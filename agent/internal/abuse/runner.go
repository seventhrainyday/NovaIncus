package abuse

import (
	"context"
	"errors"
	"log"
	"time"

	"novaincus-agent/internal/config"
)

// Reporter 把风控事件推送给 panel。
// 由 agent/internal/panel.Client 实现（见 panel/abuse.go）。
type Reporter interface {
	ReportAbuseEvents(ctx context.Context, events []Event) error
}

// Runner 是防滥用引擎的主循环：采样 -> 状态机 -> 落地处置 -> 上报。
type Runner struct {
	cfg        config.Config
	reporter   Reporter
	detector   *Detector
	attributor *Attributor
	enforcer   *Enforcer
	engine     *Engine
	interval   time.Duration
}

// NewRunner 创建引擎 Runner。reporter 为 nil 时只做本地处置、不上报。
func NewRunner(cfg config.Config, reporter Reporter) *Runner {
	return &Runner{
		cfg:        cfg,
		reporter:   reporter,
		detector:   NewDetector(),
		attributor: NewAttributor(),
		enforcer:   NewEnforcer(),
		engine:     NewEngine(),
		interval:   SampleInterval,
	}
}

// Run 启动主循环，直到 ctx 取消。退出时清理本引擎下发的防火墙规则。
func (r *Runner) Run(ctx context.Context) {
	log.Printf("[abuse] engine started: sample interval=%s", r.interval)
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	defer r.enforcer.Cleanup()

	// 启动时先做一次基线采样，避免把存量连接误判为新建。
	r.detector.Sample()

	for {
		select {
		case <-ctx.Done():
			log.Printf("[abuse] engine stopped")
			return
		case <-ticker.C:
			r.runCycle(ctx)
		}
	}
}

// runCycle 执行一个检测周期。
func (r *Runner) runCycle(ctx context.Context) {
	findings := r.detector.Sample()
	actions := r.engine.ProcessCycle(findings)
	if len(actions) == 0 {
		return
	}

	var events []Event
	for _, action := range actions {
		if err := r.applyAction(action); err != nil {
			if errors.Is(err, ErrEnforcerDegraded) {
				log.Printf("[abuse] action %s for %s degraded (tool missing), event still reported",
					action.Action, action.OffenderIP)
			} else {
				log.Printf("[abuse] action %s for %s failed: %v", action.Action, action.OffenderIP, err)
				continue
			}
		}
		event := action.Event
		event.InstanceName = r.attribute(action.OffenderIP)
		events = append(events, event)
		log.Printf("[abuse] %s %s: %s", action.Action, action.OffenderIP, event.Detail)
	}

	if len(events) > 0 && r.reporter != nil {
		reportCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if err := r.reporter.ReportAbuseEvents(reportCtx, events); err != nil {
			log.Printf("[abuse] report events failed: %v", err)
		}
	}
}

// applyAction 把处置动作落地到宿主机。
func (r *Runner) applyAction(action PendingAction) error {
	switch action.Action {
	case ActionAlert:
		return nil // 仅上报，无本地动作
	case ActionThrottle:
		return r.enforcer.Throttle(action.OffenderIP)
	case ActionFreeze:
		// 冻结前先确保不限速残留语义清晰：直接 DROP。
		return r.enforcer.Block(action.OffenderIP)
	case ActionRecover:
		if err := r.enforcer.Unblock(action.OffenderIP); err != nil {
			return err
		}
		return r.enforcer.Unthrottle(action.OffenderIP)
	default:
		return nil
	}
}

// attribute 把源 IP 归因到实例名；归因失败则标注宿主机/未知。
func (r *Runner) attribute(ip string) string {
	if name := r.attributor.InstanceName(ip); name != "" {
		return name
	}
	if r.detector.IsHostIP(ip) {
		return "host"
	}
	return "unknown"
}
