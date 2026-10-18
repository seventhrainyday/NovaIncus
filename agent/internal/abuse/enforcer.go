package abuse

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// 规则标记：所有本引擎创建的防火墙/tc 规则都带此前缀，便于识别与清理。
const ruleCommentPrefix = "NOVAINCUS_ABUSE"

// ErrEnforcerDegraded 表示执行器降级（缺 iptables/tc 等工具），处置动作被跳过。
var ErrEnforcerDegraded = errors.New("abuse enforcer degraded: required tool missing")

// Enforcer 负责把处置动作落地到宿主机防火墙与流量整形。
// 全部规则幂等：重复调用不会产生重复规则。
type Enforcer struct {
	mu         sync.Mutex
	throttled  map[string]bool // 当前被限速的 IP
	blocked    map[string]bool // 当前被冻结的 IP
	iface      string          // 出口网卡（tc 挂载点）
	iptablesOK bool
	tcOK       bool
}

// NewEnforcer 创建执行器并探测可用工具。
func NewEnforcer() *Enforcer {
	e := &Enforcer{
		throttled: make(map[string]bool),
		blocked:   make(map[string]bool),
		iface:     detectEgressInterface(),
	}
	e.iptablesOK = commandExists("iptables")
	e.tcOK = commandExists("tc")
	if !e.iptablesOK {
		log.Printf("[abuse] enforcer: iptables not found, block/unblock degraded")
	}
	if !e.tcOK || e.iface == "" {
		log.Printf("[abuse] enforcer: tc unavailable (tc=%v iface=%q), throttle degraded", e.tcOK, e.iface)
	}
	return e
}

// Throttle 把 IP 限速到 1Mbps（幂等）。
func (e *Enforcer) Throttle(ip string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.tcOK || e.iface == "" {
		return ErrEnforcerDegraded
	}
	if e.throttled[ip] {
		return nil
	}
	e.throttled[ip] = true
	return e.syncThrottleLocked()
}

// Unthrottle 解除 IP 的限速（幂等）。
func (e *Enforcer) Unthrottle(ip string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.tcOK || e.iface == "" {
		return nil
	}
	if !e.throttled[ip] {
		return nil
	}
	delete(e.throttled, ip)
	return e.syncThrottleLocked()
}

// syncThrottleLocked 从内存集合重建全部限速 filter（删除后重加，保证幂等）。
func (e *Enforcer) syncThrottleLocked() error {
	iface := e.iface
	// 确保 root qdisc 存在。
	if !qdiscExists(iface) {
		if err := runCmd("tc", "qdisc", "add", "dev", iface, "root", "handle", "1:", "htb", "default", "20"); err != nil {
			return fmt.Errorf("tc qdisc add: %w", err)
		}
	}
	// 确保限速 class 存在。
	if err := runCmd("tc", "class", "replace", "dev", iface, "parent", "1:", "classid", "1:10",
		"htb", "rate", throttleRate, "ceil", throttleRate); err != nil {
		return fmt.Errorf("tc class replace: %w", err)
	}
	// 清掉本引擎之前下发的 prio 1 filter，全部重建。
	_ = runCmd("tc", "filter", "del", "dev", iface, "parent", "1:", "prio", "1")
	index := 0
	for ip := range e.throttled {
		index++
		handle := fmt.Sprintf("800::%d", 100+index)
		args := []string{"filter", "add", "dev", iface, "parent", "1:", "handle", handle,
			"protocol", "ip", "prio", "1", "u32", "match", "ip", "src", ip + "/32", "flowid", "1:10"}
		if err := runCmd("tc", args...); err != nil {
			log.Printf("[abuse] enforcer: tc filter add failed for %s: %v", ip, err)
		}
	}
	log.Printf("[abuse] enforcer: throttle synced on %s, %d ip(s) at %s", iface, len(e.throttled), throttleRate)
	return nil
}

// qdiscExists 检查网卡上是否已有 handle 1: 的 htb qdisc。
func qdiscExists(iface string) bool {
	out, err := exec.Command("tc", "qdisc", "show", "dev", iface).Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "qdisc htb 1:")
}

// Block 冻结 IP：DROP 其全部出站流量（FORWARD + OUTPUT 链，幂等）。
func (e *Enforcer) Block(ip string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.iptablesOK {
		return ErrEnforcerDegraded
	}
	comment := ruleCommentPrefix + ":block:" + ip
	v6 := strings.Contains(ip, ":")
	bin := "iptables"
	if v6 {
		bin = "ip6tables"
		if !commandExists("ip6tables") {
			return ErrEnforcerDegraded
		}
	}
	for _, chain := range []string{"FORWARD", "OUTPUT"} {
		// 先检查，存在则跳过，保证幂等。
		if ruleExists(bin, chain, ip, comment) {
			continue
		}
		if err := runCmd(bin, "-I", chain, "-s", ip,
			"-m", "comment", "--comment", comment, "-j", "DROP"); err != nil {
			return fmt.Errorf("%s %s block %s: %w", bin, chain, ip, err)
		}
	}
	e.blocked[ip] = true
	log.Printf("[abuse] enforcer: blocked %s (DROP outbound)", ip)
	return nil
}

// Unblock 解封 IP：清理本引擎下发的 DROP 规则（幂等）。
func (e *Enforcer) Unblock(ip string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.iptablesOK {
		return nil
	}
	comment := ruleCommentPrefix + ":block:" + ip
	bin := "iptables"
	if strings.Contains(ip, ":") {
		bin = "ip6tables"
		if !commandExists("ip6tables") {
			return nil
		}
	}
	for _, chain := range []string{"FORWARD", "OUTPUT"} {
		for ruleExists(bin, chain, ip, comment) {
			if err := runCmd(bin, "-D", chain, "-s", ip,
				"-m", "comment", "--comment", comment, "-j", "DROP"); err != nil {
				break
			}
		}
	}
	delete(e.blocked, ip)
	// 兜底：同时解除可能存在的限速，避免冻结解除后仍被限速。
	if e.throttled[ip] {
		delete(e.throttled, ip)
		_ = e.syncThrottleLocked()
	}
	log.Printf("[abuse] enforcer: unblocked %s", ip)
	return nil
}

// ruleExists 用 iptables -C 检查规则是否存在。
func ruleExists(bin, chain, ip, comment string) bool {
	err := runCmd(bin, "-C", chain, "-s", ip,
		"-m", "comment", "--comment", comment, "-j", "DROP")
	return err == nil
}

// Cleanup 清理本引擎创建的全部规则（agent 退出时调用，best-effort）。
func (e *Enforcer) Cleanup() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for ip := range e.blocked {
		comment := ruleCommentPrefix + ":block:" + ip
		bin := "iptables"
		if strings.Contains(ip, ":") {
			bin = "ip6tables"
		}
		for _, chain := range []string{"FORWARD", "OUTPUT"} {
			for ruleExists(bin, chain, ip, comment) {
				if err := runCmd(bin, "-D", chain, "-s", ip,
					"-m", "comment", "--comment", comment, "-j", "DROP"); err != nil {
					break
				}
			}
		}
	}
	e.blocked = make(map[string]bool)
	if e.tcOK && e.iface != "" {
		_ = runCmd("tc", "filter", "del", "dev", e.iface, "parent", "1:", "prio", "1")
	}
	e.throttled = make(map[string]bool)
}

// detectEgressInterface 从 /proc/net/route 解析默认路由的出口网卡。
func detectEgressInterface() string {
	data, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return ""
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 || fields[0] == "Iface" {
			continue
		}
		if fields[1] == "00000000" {
			return fields[0]
		}
	}
	return ""
}

// commandExists 检查命令是否存在。
func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// runCmd 执行命令并限制 15 秒超时。
func runCmd(name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// IsV6 判断是否为 IPv6 地址（供调用方选择链路）。
func IsV6(ip string) bool {
	parsed := net.ParseIP(ip)
	return parsed != nil && parsed.To4() == nil
}
