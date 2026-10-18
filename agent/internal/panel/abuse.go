package panel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"novaincus-agent/internal/abuse"
	"novaincus-agent/internal/protocol"
)

// abuseEventPath 与 panel 端 server/src/routes/abuse.ts 的 POST 路由保持一致。
// 注意：签名 payload 中的 path 必须与服务端 buildRequestPath(request)
// （即 request.url 去掉 query 部分）完全一致，否则验签失败。
const abuseEventPath = "/api/agent/abuse-event"

// abuseEventPayload 是上报给 panel 的事件负载。
type abuseEventPayload struct {
	Events []abuse.Event `json:"events"`
}

// ReportAbuseEvents 把风控事件推送给 panel。
// 使用与 Heartbeat 相同的 HMAC 签名鉴权机制（x-novaincus-* 请求头）。
func (client *Client) ReportAbuseEvents(ctx context.Context, events []abuse.Event) error {
	if len(events) == 0 {
		return nil
	}

	payload := abuseEventPayload{Events: events}
	body, err := protocol.CanonicalJSON(payload)
	if err != nil {
		return fmt.Errorf("encode abuse events: %w", err)
	}

	timestamp := protocol.NewTimestamp()
	nonce, err := protocol.NewNonce()
	if err != nil {
		return fmt.Errorf("new nonce: %w", err)
	}
	bodyHash := protocol.BodySHA256(body)
	signingPayload := protocol.SigningPayload(http.MethodPost, abuseEventPath, timestamp, nonce, bodyHash)
	signature := protocol.Signature(client.agentSecret, signingPayload)

	reportCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(reportCtx, http.MethodPost, client.panelURL+abuseEventPath, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-novaincus-agent-id", client.agentID)
	request.Header.Set("x-novaincus-timestamp", timestamp)
	request.Header.Set("x-novaincus-nonce", nonce)
	request.Header.Set("x-novaincus-body-sha256", bodyHash)
	request.Header.Set("x-novaincus-signature", signature)

	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("post abuse events: %w", err)
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("report abuse events failed: status=%d body=%s", response.StatusCode, string(responseBody))
	}

	// 兼容服务端返回的待下发指令（如解封指令），预留结构暂不处理。
	var parsed struct {
		Commands []json.RawMessage `json:"commands"`
	}
	_ = json.Unmarshal(responseBody, &parsed)
	return nil
}
