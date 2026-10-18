package abuse

import (
	"bufio"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// flow 是 conntrack 中的一条流（原始方向）。
type flow struct {
	srcIP   string
	dstIP   string
	dstPort string
	proto   string // "tcp" | "udp"
}

// Detector 每 60 秒采样一次连接跟踪表，差分统计新建连接并识别滥用特征。
type Detector struct {
	prev    map[string]flow // 上一周期快照，key 为流标识
	hostIPs map[string]bool // 宿主机自身 IP（用于归因标注）
}

// NewDetector 创建检测器。
func NewDetector() *Detector {
	return &Detector{
		prev:    make(map[string]flow),
		hostIPs: localIPSet(),
	}
}

// Sample 采集一个周期并返回本周期内每个源 IP 的检测结论。
// 首次调用只建立基线快照，返回空结论。
func (d *Detector) Sample() []Finding {
	current := snapshotFlows()
	if d.prev == nil {
		d.prev = make(map[string]flow)
	}
	isBaseline := len(d.prev) == 0
	newFlows := diffFlows(d.prev, current)
	d.prev = current
	if isBaseline {
		return nil
	}
	return analyzeNewFlows(newFlows)
}

// snapshotFlows 读取当前全部流：优先 /proc/net/nf_conntrack，
// 不存在则尝试 conntrack -L 命令，最后降级读 /proc/net/tcp + /proc/net/udp。
func snapshotFlows() map[string]flow {
	flows := make(map[string]flow)
	if data, err := os.ReadFile("/proc/net/nf_conntrack"); err == nil {
		parseConntrack(string(data), flows)
		return flows
	}
	if out, err := exec.Command("conntrack", "-L", "-o", "extended").Output(); err == nil {
		parseConntrack(string(out), flows)
		return flows
	}
	parseProcNetTCP("/proc/net/tcp", "tcp", flows)
	parseProcNetTCP("/proc/net/udp", "udp", flows)
	return flows
}

// flowKey 生成流标识（原始方向五元组）。
func flowKey(f flow) string {
	return f.proto + "|" + f.srcIP + "|" + f.dstIP + "|" + f.dstPort
}

// diffFlows 返回本周期新增的流（上一周期不存在的）。
func diffFlows(prev, current map[string]flow) []flow {
	var added []flow
	for key, f := range current {
		if _, ok := prev[key]; !ok {
			added = append(added, f)
		}
	}
	return added
}

// perIPStats 聚合单个源 IP 的周期统计。
type perIPStats struct {
	newFlows  int
	udpFlows  int
	spamConns int
	ports     map[string]bool
	ips       map[string]bool
}

// analyzeNewFlows 对新增流做特征分析，返回命中阈值的结论。
func analyzeNewFlows(newFlows []flow) []Finding {
	stats := make(map[string]*perIPStats)
	for _, f := range newFlows {
		// 跳过回环与组播。
		if isSkippedIP(f.srcIP) || isSkippedIP(f.dstIP) {
			continue
		}
		s := stats[f.srcIP]
		if s == nil {
			s = &perIPStats{ports: make(map[string]bool), ips: make(map[string]bool)}
			stats[f.srcIP] = s
		}
		s.newFlows++
		if f.proto == "udp" {
			s.udpFlows++
		}
		s.ports[f.dstPort] = true
		s.ips[f.dstIP] = true
		if f.proto == "tcp" && spamPortSet[f.dstPort] {
			s.spamConns++
		}
	}

	var findings []Finding
	for srcIP, s := range stats {
		var offenses []string
		if len(s.ports) >= thresholdPortScanDistinctPorts {
			offenses = append(offenses, OffensePortScan)
		}
		if len(s.ips) >= thresholdHostScanDistinctIPs {
			offenses = append(offenses, OffenseHostScan)
		}
		if s.udpFlows >= thresholdUDPFloodNewFlows {
			offenses = append(offenses, OffenseUDPFlood)
		}
		if s.newFlows >= thresholdConnFloodNewFlows {
			offenses = append(offenses, OffenseConnFlood)
		}
		if s.spamConns >= thresholdSpamNewConns {
			offenses = append(offenses, OffenseSpam)
		}
		if len(offenses) > 0 {
			findings = append(findings, Finding{
				SrcIP:         srcIP,
				Offenses:      offenses,
				NewFlows:      s.newFlows,
				DistinctPorts: len(s.ports),
				DistinctIPs:   len(s.ips),
				SpamConns:     s.spamConns,
			})
		}
	}
	return findings
}

// parseConntrack 解析 conntrack 文本（/proc 文件或 conntrack -L 输出）。
// 行格式示例：
// ipv4 2 tcp 6 431999 ESTABLISHED src=10.0.0.5 dst=1.2.3.4 sport=45678 dport=443 ...
func parseConntrack(data string, out map[string]flow) {
	scanner := bufio.NewScanner(strings.NewReader(data))
	// 防止超长行拖慢。
	scanner.Buffer(make([]byte, 64*1024), 64*1024)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		proto := ""
		for _, p := range []string{"tcp", "udp"} {
			if fields[2] == p {
				proto = p
				break
			}
		}
		if proto == "" {
			continue
		}
		f := flow{proto: proto}
		// 只取原始方向的第一个 src=/dst=/sport=/dport=。
		for _, field := range fields {
			switch {
			case f.srcIP == "" && strings.HasPrefix(field, "src="):
				f.srcIP = strings.TrimPrefix(field, "src=")
			case f.dstIP == "" && strings.HasPrefix(field, "dst="):
				f.dstIP = strings.TrimPrefix(field, "dst=")
			case f.dstPort == "" && strings.HasPrefix(field, "dport="):
				f.dstPort = strings.TrimPrefix(field, "dport=")
			}
		}
		if f.srcIP == "" || f.dstIP == "" || f.dstPort == "" {
			continue
		}
		out[flowKey(f)] = f
	}
}

// parseProcNetTCP 解析 /proc/net/tcp 或 /proc/net/udp（降级数据源）。
// 行格式：sl local_address rem_address ...，地址为 hexIP:hexPort。
func parseProcNetTCP(path, proto string, out map[string]flow) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		if i == 0 {
			continue // 表头
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		localIP, localPort := splitHexAddr(fields[1])
		remoteIP, remotePort := splitHexAddr(fields[2])
		if localIP == "" || remoteIP == "" {
			continue
		}
		// /proc/net/tcp 的 local 是本机监听/发起端；作为降级数据源，
		// 用 remote 端作为"目标"，local 端作为"源"近似统计。
		f := flow{srcIP: localIP, dstIP: remoteIP, dstPort: remotePort, proto: proto}
		_ = localPort
		out[flowKey(f)] = f
	}
}

// splitHexAddr 解析 "0100007F:0035" 形式的地址。
func splitHexAddr(s string) (string, string) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return "", ""
	}
	ip := hexToIP(parts[0])
	portNum, err := strconv.ParseUint(parts[1], 16, 32)
	if err != nil {
		return "", ""
	}
	return ip, strconv.FormatUint(portNum, 10)
}

// hexToIP 把小端序 hex（如 0100007F）转成点分十进制。
func hexToIP(hexStr string) string {
	if len(hexStr) != 8 && len(hexStr) != 32 {
		return ""
	}
	if len(hexStr) == 32 {
		// IPv6：conntrack 风格的 32 hex 字符，按 4 组 32 位小端处理。
		var b [16]byte
		for i := 0; i < 4; i++ {
			word, err := strconv.ParseUint(hexStr[i*8:(i+1)*8], 16, 32)
			if err != nil {
				return ""
			}
			b[i*4] = byte(word)
			b[i*4+1] = byte(word >> 8)
			b[i*4+2] = byte(word >> 16)
			b[i*4+3] = byte(word >> 24)
		}
		return net.IP(b[:]).String()
	}
	val, err := strconv.ParseUint(hexStr, 16, 32)
	if err != nil {
		return ""
	}
	return net.IPv4(byte(val), byte(val>>8), byte(val>>16), byte(val>>24)).String()
}

// isSkippedIP 判断是否跳过统计（回环/组播/未指定）。
func isSkippedIP(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return true
	}
	return ip.IsLoopback() || ip.IsMulticast() || ip.IsUnspecified()
}

// localIPSet 获取本机全部 IP（用于归因时标注宿主机自身流量）。
func localIPSet() map[string]bool {
	set := make(map[string]bool)
	ifaces, err := net.Interfaces()
	if err != nil {
		return set
	}
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil {
				continue
			}
			set[ip.String()] = true
		}
	}
	return set
}

// IsHostIP 判断 IP 是否为宿主机自身地址。
func (d *Detector) IsHostIP(ip string) bool {
	return d.hostIPs[ip]
}

// SampleInterval 采样周期。
const SampleInterval = 60 * time.Second
