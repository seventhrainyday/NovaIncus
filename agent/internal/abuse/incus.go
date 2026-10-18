package abuse

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// attributionCacheTTL 归因缓存有效期：实例 IP 变化不频繁，5 分钟刷新一次。
const attributionCacheTTL = 5 * time.Minute

var incusSocketCandidates = []string{
	"/var/lib/incus/unix.socket",
	"/var/snap/incus/common/lxd/unix.socket",
	"/var/lib/lxd/unix.socket",
}

// Attributor 把源 IP 归因到实例名（LXC/KVM 容器 IP -> 实例名）。
// 非容器 IP 返回空字符串，调用方据此标注为宿主机/未知。
type Attributor struct {
	mu       sync.Mutex
	cachedAt time.Time
	ipToName map[string]string
}

// NewAttributor 创建归因器。
func NewAttributor() *Attributor {
	return &Attributor{ipToName: make(map[string]string)}
}

// InstanceName 返回 IP 对应的实例名；查不到返回 ""。
func (a *Attributor) InstanceName(ip string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if time.Since(a.cachedAt) > attributionCacheTTL {
		a.refreshLocked()
	}
	return a.ipToName[ip]
}

// refreshLocked 刷新 IP->实例名映射（best-effort，失败则保留旧缓存）。
func (a *Attributor) refreshLocked() {
	mapping, ok := queryIncusIPMap()
	if !ok {
		return
	}
	a.ipToName = mapping
	a.cachedAt = time.Now()
}

type incusAPIResponse struct {
	Type     string          `json:"type"`
	Status   string          `json:"status"`
	Metadata json.RawMessage `json:"metadata"`
}

type incusInstanceState struct {
	Network map[string]struct {
		Addresses []struct {
			Family  string `json:"family"`
			Address string `json:"address"`
			Scope   string `json:"scope"`
		} `json:"addresses"`
	} `json:"network"`
}

// queryIncusIPMap 通过 incus unix socket 查询全部实例的 IP。
func queryIncusIPMap() (map[string]string, bool) {
	socketPath := ""
	for _, candidate := range incusSocketCandidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			socketPath = candidate
			break
		}
	}
	if socketPath == "" {
		return nil, false
	}

	client := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var dialer net.Dialer
				return dialer.DialContext(ctx, "unix", socketPath)
			},
			DisableKeepAlives: true,
		},
		Timeout: 10 * time.Second,
	}

	var names []string
	if err := incusGet(client, "/1.0/instances", &names); err != nil {
		return nil, false
	}

	mapping := make(map[string]string)
	var wg sync.WaitGroup
	var mu sync.Mutex
	sem := make(chan struct{}, 8)
	for _, raw := range names {
		// /1.0/instances 返回的是 URL 路径，取最后一段为实例名。
		name := raw[strings.LastIndex(raw, "/")+1:]
		if name == "" {
			continue
		}
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var state incusInstanceState
			if err := incusGet(client, "/1.0/instances/"+name+"/state", &state); err != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, dev := range state.Network {
				for _, addr := range dev.Addresses {
					if addr.Scope == "global" && addr.Address != "" {
						mapping[addr.Address] = name
					}
				}
			}
		}(name)
	}
	wg.Wait()
	return mapping, true
}

// incusGet 对 incus unix socket 发 GET 请求并解析 metadata。
func incusGet(client *http.Client, path string, out any) error {
	req, err := http.NewRequest(http.MethodGet, "http://incus"+path, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var apiResp incusAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		return err
	}
	if apiResp.Type == "error" {
		return errIncusAPI(apiResp.Status)
	}
	return json.Unmarshal(apiResp.Metadata, out)
}

type incusError string

func (e incusError) Error() string { return "incus api error: " + string(e) }

func errIncusAPI(status string) error { return incusError(status) }
