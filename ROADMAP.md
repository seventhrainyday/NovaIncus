# NovaIncus 开发路线图

> 完整规划见《NovaIncus 项目计划书》。本文件记录各阶段目标、已完成的 Phase 1、
> 以及从社区 fork 中学到的经验。

## Phase 1：稳定基础与代码重构 ✅（已完成，2026-10-19）

- [x] Fork 骨架：改名 NovaIncus（UI 默认品牌、前后端包名、Go agent 二进制/配置路径/服务名统一），README 重写，BSD-3-Clause 协议声明保留
- [x] Go agent：`go 1.19 → 1.23`，`go build` / `go vet` / `go test` 全过（零外部依赖）
- [x] 安全加固（移植自 qdmz/incudal@960a79f）：`decryptSensitiveData` 失败返回 null 而非原文，10 组行为测试通过
- [x] 一键安装脚本 `install.sh`：自动装 Docker、随机生成 6 个密钥、生成 mTLS 证书、`docker compose up`、健康检查、打印管理员账号；支持 `--uninstall`
- [x] `.env.example` 重写为真正的可复制模板；`docs/DEPLOY.md`（一键脚本 / 1Panel 编排单文件 / 手动 compose / FAQ）
- [ ] 未验证：本机无 Docker，`docker compose up --build` 全量构建与端到端安装需在干净 Debian/Ubuntu 测试机上跑一遍

## 社区 fork 经验（已吸收）

| 来源 | 经验 | 状态 |
|------|------|------|
| qdmz/incudal | 命令注入（chpasswd 密码转义）、存储型 XSS（DOMPurify）、凭据掩码、解密兜底返回 null | 已核：仅解密兜底适用并已移植；其余为其 PVE 分支私有代码，基线无对应问题 |
| qdmz/incudal | LXC SSH 修复（禁用 ssh.socket、开 PasswordAuthentication、禁用 pam_systemd）、VNC 票据鉴权、QEMU cloud-init | Phase 2 救援终端时参考 |
| shali10/incudal | 开鸡失败重试、删除报错透出、兑换码 host scope 强制、bootstrap 预装 curl/bash | 已核：兑换码越权基线已有防护；其余 Phase 2 按需移植 |

## Phase 2：网络增强与救援终端（待开工）

- xterm.js Web SSH + 串口救援终端（参考 qdmz 的 LXC SSH/VNC 修复）
- Caddy 自动域名反代（`server` 已有 caddy 密码逻辑，补全自动化）
- NAT 端口池：冲突检测、用户自助更换、批量导入
- shali10 的开鸡重试 / 删除报错透出按需移植

## Phase 3：智能风控与安全引擎（待开工）

- Agent 端 eBPF 轻量流量特征识别（外发扫描、UDP 洪泛、挖矿特征）
- 敏感端口/协议硬拦截（25/465、BT tracker、私有网段探测）
- 阶梯熔断：告警 → 降速 1Mbps → 冻结停机，多端推送

## Phase 4：计费升级与界面焕新（待开工）

- 按小时/分钟计费（关机仅收存储费）、弹性升降配
- 前端现代化重构（卡片流 + 实时脉搏图）、移动端 PWA 优化

## Phase 5：生态互联与开源发布（待开工）

- Telegram Bot（开机/关机/查流量/续费/告警）
- 跨节点热迁移、镜像市场、cloud-init 密钥注入
- RESTful OpenAPI 3.0 文档 + Webhook + `novaincus-cli`
- 中英文部署指南
