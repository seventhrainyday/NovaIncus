# NovaIncus 智能风控与防滥用引擎（Phase 3）

## 架构总览

```
宿主机 (Go agent, agent/internal/abuse/)
  detector.go      每 60s 采样 conntrack，差分统计新建连接，识别 5 类滥用特征
  incus.go         容器 IP -> 实例名归因（incus unix socket，5 分钟缓存）
  statemachine.go  alert(2周期) -> throttle(3周期) -> freeze(5周期) 三阶状态机
  enforcer.go      落地处置：tc 限速 1Mbps / iptables DROP（规则带 NOVAINCUS_ABUSE 标记）
  runner.go        主循环：采样 -> 状态机 -> 处置 -> 经 panel client 上报
  panel/abuse.go   POST /api/agent/abuse-event（与心跳相同的 HMAC 签名鉴权）

控制面板 (server/src/)
  db/abuse.ts      复用 Log 表（module='security', action='abuse.*'），无新表、无迁移
  routes/abuse.ts  上报/查询/确认/解封请求 4 个路由（待在 app.ts 注册，见文件头 TODO）
```

## 关于 eBPF 的诚实说明

**本实现不是内核 eBPF 字节码探针**，而是 conntrack 采样轻量版：

- 数据源：`/proc/net/nf_conntrack`（无 conntrack 模块时降级为 `conntrack -L`，
  再降级为 `/proc/net/tcp` + `/proc/net/udp`）。
- 原理：每 60 秒拍一次连接跟踪表快照，差分得到本周期"新建"的流，
  按源 IP 聚合统计后与阈值比对。
- 局限：60 秒粒度，对低于阈值的慢速扫描不敏感；依赖 conntrack 模块；
  高并发下快照解析是 O(表大小) 的用户态开销。

**生产环境升级 eBPF 的路径**（计划书原目标）：

1. 用 `cilium/ebpf`（纯 Go，无 C 依赖）在 `tc`/`XDP` 挂载点统计
   每 (srcIP, dstIP, dstPort) 的新建连接计数， via BPF map；
2. agent 只做 `map lookup` 读聚合计数，不再解析 /proc；
3. 阻断从 iptables 升级为 XDP `DROP`（单包延迟更低）；
4. 保持本包的 `Finding`/`Event`/状态机接口不变，只替换 `detector.go` 的数据源。

## 检测特征与阈值（每 60 秒 / 每源 IP）

| 特征 | 阈值 | 说明 |
|------|------|------|
| 端口扫描 `port_scan` | 去重目标端口 ≥ 50 | 短时间内扫大量端口 |
| 主机扫描 `host_scan` | 去重目标 IP ≥ 100 | 网段探测 |
| UDP 洪泛 `udp_flood` | 新建 UDP 流 ≥ 500 | 外发 UDP 洪水 |
| 连接洪泛 `conn_flood` | 新建总流 ≥ 1000 | SYN/连接耗尽攻击 |
| 垃圾邮件 `spam` | 到 25/465/587 的新建 TCP ≥ 5 | 垃圾邮件外发 |

回环 / 组播 / 未指定地址不计入统计。宿主机自身 IP 归因为 `host`，
归因失败的容器外 IP 标记为 `unknown`（仍会被处置）。

## 阶梯处置状态机

同一源 IP 的连续异常周期计数：

```
正常 --[连续2周期异常]--> 告警(alert, severity=warning)：仅上报
  --[连续3周期异常]--> 限速(throttle, severity=high)：tc htb 限到 1Mbps
  --[连续5周期异常]--> 冻结(freeze, severity=critical)：iptables FORWARD/OUTPUT DROP，
                       上报并建议人工复核后停机
  --[连续5周期正常]--> 自动解封(recover, severity=info)：清理规则并上报
```

单周期异常不会触发任何动作（防抖）。内存中的跟踪记录对长期正常的 IP 自动回收。

## 落地处置细节（enforcer.go）

- 限速：`tc qdisc add dev <出口网卡> root handle 1: htb` + class `1:10` rate/ceil 1mbit，
  按源 IP 的 u32 filter 分流；用内存集合全量重建 filter，保证幂等。
- 冻结：`iptables -I FORWARD/OUTPUT -s <ip> -m comment --comment "NOVAINCUS_ABUSE:block:<ip>" -j DROP`
 （IPv6 走 ip6tables）；`iptables -C` 预检保证幂等。
- 缺 `iptables`/`tc` 时处置降级（返回 `ErrEnforcerDegraded`），事件照常上报，
  日志中明确标注 degraded。
- agent 退出时 `Cleanup()` 清理本引擎下发的全部规则。

## Panel 端 API

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/agent/abuse-event` | agent HMAC | 批量上报事件 `{events: [...]}`，最多 100/批 |
| GET | `/api/admin/abuse-events` | 管理员 | 分页查询，支持 `page/pageSize/instanceId/type` |
| POST | `/api/admin/abuse-events/:id/ack` | 管理员 | 确认事件（审计留痕） |
| POST | `/api/admin/abuse-events/:id/unblock` | 管理员 | 解封请求：当前仅记 log 为 pending（见下） |

事件写入 `Log` 表：`module='security'`，`action='abuse.<首个特征>'`，
`content` 含人类可读摘要与 `ip=<ip>` 机器标记（供解封解析），
`result` 按 severity 映射为 failed/warning/success。

**解封指令通道（未实现，诚实标注）**：
agent 目前只有"上报"通道（心跳/事件），panel->agent 尚无通用指令下发通道。
`unblock` 接口当前只记录 `abuse.unblock_requested` 日志并返回 pending。
完整方案是在心跳响应中增加 pending commands 队列（见 routes/abuse.ts 的 TODO），
agent 拉取后执行 `Unblock`。在此之前，解封需手动在宿主机执行：

```bash
iptables -D FORWARD -s <ip> -m comment --comment "NOVAINCUS_ABUSE:block:<ip>" -j DROP
iptables -D OUTPUT  -s <ip> -m comment --comment "NOVAINCUS_ABUSE:block:<ip>" -j DROP
```

## 接线说明

- agent 侧：`cmd/novaincus-agent/main.go` 中 3 行启动 `abuse.NewRunner(cfg, client).Run(ctx)`。
- panel 侧：在 `server/src/app.ts` 加（见 routes/abuse.ts 文件头 TODO）：
  ```ts
  import abuseRoutes from './routes/abuse.js'
  await fastify.register(abuseRoutes)
  ```

## 本地验证

```bash
cd agent && go build ./... && go vet ./... && go test ./...
```

TS 侧因本机无 node_modules 未跑 tsc；代码对照 `routes/traffic.ts` /
`routes/admin-notification-channels.ts` / `routes/agent.ts` 的既有风格编写，
类型引用（`request.user.id`、`fastify.authenticateAdmin`、`prisma.hostAgent` 等）
均取自现有代码中的实际用法。
