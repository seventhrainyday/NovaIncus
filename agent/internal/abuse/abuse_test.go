package abuse

import (
	"strings"
	"testing"
	"time"
)

// TestParseConntrack 验证 conntrack 行解析。
func TestParseConntrack(t *testing.T) {
	data := `ipv4     2 tcp      6 431999 ESTABLISHED src=10.10.3.5 dst=93.184.216.34 sport=45678 dport=443 src=93.184.216.34 dst=10.10.3.5 sport=443 dport=45678 [ASSURED] mark=0 use=1
ipv4     2 udp      17 28 src=10.10.3.6 dst=8.8.8.8 sport=53421 dport=53 src=8.8.8.8 dst=10.10.3.6 sport=53 dport=53421 mark=0 use=1
`
	flows := make(map[string]flow)
	parseConntrack(data, flows)
	if len(flows) != 2 {
		t.Fatalf("expected 2 flows, got %d", len(flows))
	}
	found := false
	for _, f := range flows {
		if f.proto == "tcp" && f.srcIP == "10.10.3.5" && f.dstIP == "93.184.216.34" && f.dstPort == "443" {
			found = true
		}
	}
	if !found {
		t.Fatal("tcp flow not parsed correctly")
	}
}

// TestAnalyzePortScan 验证端口扫描检测。
func TestAnalyzePortScan(t *testing.T) {
	var newFlows []flow
	for i := 0; i < 60; i++ {
		newFlows = append(newFlows, flow{
			srcIP:   "10.10.3.9",
			dstIP:   "203.0.113.7",
			dstPort: strings.Join([]string{"1", string(rune('0' + i/10)), string(rune('0' + i%10))}, ""),
			proto:   "tcp",
		})
	}
	findings := analyzeNewFlows(newFlows)
	if len(findings) != 1 {
		t.Fatalf("expected 1 finding, got %d", len(findings))
	}
	if !contains(findings[0].Offenses, OffensePortScan) {
		t.Fatalf("expected port_scan offense, got %v", findings[0].Offenses)
	}
}

// TestAnalyzeSpam 验证垃圾邮件端口检测。
func TestAnalyzeSpam(t *testing.T) {
	var newFlows []flow
	for i := 0; i < 6; i++ {
		newFlows = append(newFlows, flow{srcIP: "10.10.3.9", dstIP: "198.51.100.2", dstPort: "25", proto: "tcp"})
	}
	findings := analyzeNewFlows(newFlows)
	if len(findings) != 1 || !contains(findings[0].Offenses, OffenseSpam) {
		t.Fatalf("expected spam offense, got %+v", findings)
	}
}

// TestAnalyzeLoopbackSkipped 验证回环流量被跳过。
func TestAnalyzeLoopbackSkipped(t *testing.T) {
	var newFlows []flow
	for i := 0; i < 200; i++ {
		newFlows = append(newFlows, flow{srcIP: "127.0.0.1", dstIP: "127.0.0.1", dstPort: "8080", proto: "tcp"})
	}
	if findings := analyzeNewFlows(newFlows); len(findings) != 0 {
		t.Fatalf("loopback should be skipped, got %+v", findings)
	}
}

// TestStateMachineEscalation 验证三阶升级：alert(2) -> throttle(3) -> freeze(5)。
func TestStateMachineEscalation(t *testing.T) {
	e := NewEngine()
	e.now = func() time.Time { return time.Unix(0, 0).UTC() }
	finding := Finding{SrcIP: "10.10.3.9", Offenses: []string{OffensePortScan}}

	var gotActions []string
	for cycle := 1; cycle <= 6; cycle++ {
		for _, a := range e.ProcessCycle([]Finding{finding}) {
			gotActions = append(gotActions, a.Action)
		}
	}
	want := []string{ActionAlert, ActionThrottle, ActionFreeze}
	if len(gotActions) != len(want) {
		t.Fatalf("expected actions %v, got %v", want, gotActions)
	}
	for i := range want {
		if gotActions[i] != want[i] {
			t.Fatalf("expected actions %v, got %v", want, gotActions)
		}
	}
	if e.StageOf("10.10.3.9") != StageFreeze {
		t.Fatalf("expected stage freeze, got %s", e.StageOf("10.10.3.9"))
	}
}

// TestStateMachineRecovery 验证连续正常 5 周期后自动解封。
func TestStateMachineRecovery(t *testing.T) {
	e := NewEngine()
	finding := Finding{SrcIP: "10.10.3.9", Offenses: []string{OffenseUDPFlood}}
	for cycle := 1; cycle <= 5; cycle++ {
		e.ProcessCycle([]Finding{finding})
	}
	if e.StageOf("10.10.3.9") != StageFreeze {
		t.Fatalf("expected freeze before recovery, got %s", e.StageOf("10.10.3.9"))
	}
	var recovered bool
	for cycle := 1; cycle <= 5; cycle++ {
		for _, a := range e.ProcessCycle(nil) {
			if a.Action == ActionRecover {
				recovered = true
			}
		}
	}
	if !recovered {
		t.Fatal("expected recover action after 5 clean cycles")
	}
	if e.StageOf("10.10.3.9") != StageNormal {
		t.Fatalf("expected stage normal, got %s", e.StageOf("10.10.3.9"))
	}
}

// TestStateMachineNoFalsePositive 验证单周期异常不触发动作。
func TestStateMachineNoFalsePositive(t *testing.T) {
	e := NewEngine()
	finding := Finding{SrcIP: "10.10.3.9", Offenses: []string{OffensePortScan}}
	if actions := e.ProcessCycle([]Finding{finding}); len(actions) != 0 {
		t.Fatalf("single bad cycle should not trigger action, got %+v", actions)
	}
}

// TestHexToIP 验证 /proc/net/tcp 的 hex 地址解析。
func TestHexToIP(t *testing.T) {
	if got := hexToIP("0100007F"); got != "127.0.0.1" {
		t.Fatalf("expected 127.0.0.1, got %s", got)
	}
	if got := hexToIP("010AA8C0"); got != "192.168.10.1" {
		t.Fatalf("expected 192.168.10.1, got %s", got)
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
