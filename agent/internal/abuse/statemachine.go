package abuse

import (
	"fmt"
	"strings"
	"time"
)

// 处置阶段。
const (
	StageNormal   = "normal"
	StageAlert    = "alert"
	StageThrottle = "throttle"
	StageFreeze   = "freeze"
)

// PendingAction 是状态机在一个周期内决定的待执行处置。
type PendingAction struct {
	OffenderIP string
	Action     string // ActionAlert | ActionThrottle | ActionFreeze | ActionRecover
	Event      Event  // 上报给 panel 的事件
}

// offender 跟踪单个源 IP 的连续异常/正常周期。
type offender struct {
	bad      int    // 连续异常周期
	good     int    // 连续正常周期
	stage    string // 当前阶段
	offenses []string
	finding  Finding // 最近一次异常周期的结论（用于事件详情）
}

// Engine 是 alert -> throttle -> freeze 三阶状态机。
type Engine struct {
	offenders map[string]*offender
	now       func() time.Time
}

// NewEngine 创建状态机引擎。
func NewEngine() *Engine {
	return &Engine{
		offenders: make(map[string]*offender),
		now:       time.Now,
	}
}

// ProcessCycle 处理一个采样周期的检测结论，返回待执行的处置动作。
// findings 为本周期命中的异常（空表示本周期全网正常）。
func (e *Engine) ProcessCycle(findings []Finding) []PendingAction {
	badIPs := make(map[string]Finding, len(findings))
	for _, f := range findings {
		badIPs[f.SrcIP] = f
	}

	var actions []PendingAction

	// 先处理本周期异常的 IP。
	for ip, finding := range badIPs {
		o := e.offender(ip)
		o.bad++
		o.good = 0
		o.offenses = finding.Offenses
		o.finding = finding

		switch {
		case o.bad == cyclesToAlert && o.stage == StageNormal:
			o.stage = StageAlert
			actions = append(actions, e.buildAction(ip, o, ActionAlert, SeverityWarning,
				fmt.Sprintf("检测到滥用特征 [%s]，已告警（连续 %d 周期异常）", strings.Join(finding.Offenses, ","), o.bad)))
		case o.bad == cyclesToThrottle && (o.stage == StageAlert || o.stage == StageNormal):
			o.stage = StageThrottle
			actions = append(actions, e.buildAction(ip, o, ActionThrottle, SeverityHigh,
				fmt.Sprintf("滥用持续 [%s]，已限速至 %s（连续 %d 周期异常）", strings.Join(finding.Offenses, ","), throttleRate, o.bad)))
		case o.bad >= cyclesToFreeze && o.stage != StageFreeze:
			o.stage = StageFreeze
			actions = append(actions, e.buildAction(ip, o, ActionFreeze, SeverityCritical,
				fmt.Sprintf("滥用持续 [%s]，已冻结出站流量，建议人工复核后停机（连续 %d 周期异常）", strings.Join(finding.Offenses, ","), o.bad)))
		}
	}

	// 再处理本周期正常的 IP（恢复逻辑）。
	for ip, o := range e.offenders {
		if _, bad := badIPs[ip]; bad {
			continue
		}
		if o.stage == StageNormal {
			// 长期正常的记录做内存回收。
			o.good++
			if o.good > cyclesToRecover*2 {
				delete(e.offenders, ip)
			}
			continue
		}
		o.good++
		o.bad = 0
		if o.good >= cyclesToRecover {
			prevStage := o.stage
			o.stage = StageNormal
			o.good = 0
			actions = append(actions, e.buildAction(ip, o, ActionRecover, SeverityInfo,
				fmt.Sprintf("已连续 %d 周期正常，自动解除%s处置", cyclesToRecover, stageName(prevStage))))
		}
	}

	return actions
}

// offender 获取（或创建）IP 的跟踪记录。
func (e *Engine) offender(ip string) *offender {
	o, ok := e.offenders[ip]
	if !ok {
		o = &offender{stage: StageNormal}
		e.offenders[ip] = o
	}
	return o
}

// buildAction 构造待执行动作与上报事件。
func (e *Engine) buildAction(ip string, o *offender, action, severity, detail string) PendingAction {
	types := append([]string{}, o.offenses...)
	return PendingAction{
		OffenderIP: ip,
		Action:     action,
		Event: Event{
			OccurredAt:   e.now().UTC(),
			OffenderIP:   ip,
			InstanceName: "", // 由 Runner 在上报前通过归因器填充
			Types:        types,
			Severity:     severity,
			Action:       action,
			Detail:       detail,
		},
	}
}

// stageName 阶段中文名（用于事件详情）。
func stageName(stage string) string {
	switch stage {
	case StageAlert:
		return "告警"
	case StageThrottle:
		return "限速"
	case StageFreeze:
		return "冻结"
	default:
		return stage
	}
}

// StageOf 返回 IP 当前所处阶段（供外部查询/测试）。
func (e *Engine) StageOf(ip string) string {
	if o, ok := e.offenders[ip]; ok {
		return o.stage
	}
	return StageNormal
}
