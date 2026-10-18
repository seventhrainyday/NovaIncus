// Package abuse 实现 NovaIncus 智能风控与防滥用引擎的 Agent 端。
//
// 设计说明（诚实标注）：
//   - 本实现为 conntrack 采样轻量版检测器（/proc/net/nf_conntrack 每 60 秒采样，
//     差分统计新建连接），并非内核 eBPF 字节码探针。eBPF 版本见 ABUSE.md 的升级路径。
//   - 检测到异常后执行阶梯式处置：告警 -> 限速 1Mbps(tc) -> 冻结(iptables DROP)，
//     恢复正常后自动解封，所有动作与事件通过 panel 上报通道推送。
package abuse

import "time"

// 检测阈值（每 60 秒采样周期内，单个源 IP）。
const (
	// 端口扫描：单个源 IP 在一个周期内连接的不同目标端口数。
	thresholdPortScanDistinctPorts = 50
	// 主机扫描：单个源 IP 在一个周期内连接的不同目标 IP 数。
	thresholdHostScanDistinctIPs = 100
	// UDP 洪泛：单个源 IP 在一个周期内新建的 UDP 流数。
	thresholdUDPFloodNewFlows = 500
	// 连接洪泛：单个源 IP 在一个周期内新建的总流数。
	thresholdConnFloodNewFlows = 1000
	// 垃圾邮件：单个源 IP 在一个周期内向 25/465/587 端口新建的 TCP 连接数。
	thresholdSpamNewConns = 5

	// 状态机推进阈值（连续异常周期数）。
	cyclesToAlert    = 2 // 告警上报
	cyclesToThrottle = 3 // tc 限速到 1Mbps
	cyclesToFreeze   = 5 // iptables 冻结
	// 连续正常周期数达到该值后自动解封。
	cyclesToRecover = 5

	// 垃圾邮件端口（默认硬拦截观察）。
	spamPorts = "25,465,587"

	// 限速带宽。
	throttleRate = "1mbit"
)

// 异常类型。
const (
	OffensePortScan  = "port_scan"  // 外发端口扫描
	OffenseHostScan  = "host_scan"  // 外发主机扫描
	OffenseUDPFlood  = "udp_flood"  // UDP 洪泛
	OffenseConnFlood = "conn_flood" // 连接洪泛
	OffenseSpam      = "spam"       // 垃圾邮件外发
)

// 处置动作。
const (
	ActionAlert    = "alert"    // 仅告警上报
	ActionThrottle = "throttle" // 限速 1Mbps
	ActionFreeze   = "freeze"   // 冻结：DROP 全部出站
	ActionRecover  = "recover"  // 自动解封
)

// 事件严重等级。
const (
	SeverityWarning  = "warning"
	SeverityHigh     = "high"
	SeverityCritical = "critical"
	SeverityInfo     = "info"
)

// Finding 是单个采样周期内针对一个源 IP 的检测结论。
type Finding struct {
	SrcIP         string
	Offenses      []string // 命中的异常类型
	NewFlows      int      // 周期内新建流数
	DistinctPorts int      // 周期内不同目标端口数
	DistinctIPs   int      // 周期内不同目标 IP 数
	SpamConns     int      // 周期内垃圾邮件端口新建连接数
}

// Event 是上报给 panel 的风控事件。
type Event struct {
	OccurredAt   time.Time `json:"occurredAt"`
	OffenderIP   string    `json:"offenderIp"`
	InstanceName string    `json:"instanceName"`
	Types        []string  `json:"types"`
	Severity     string    `json:"severity"`
	Action       string    `json:"action"`
	Detail       string    `json:"detail"`
}

// 垃圾邮件端口集合。
var spamPortSet = map[string]bool{"25": true, "465": true, "587": true}
