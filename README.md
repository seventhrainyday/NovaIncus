# NovaIncus

基于 Incus (LXC / KVM) 的轻量级、高密度现代化虚拟化资产交付与自动化管理平台。

NovaIncus 是 [qwer-xyz/incudal](https://github.com/qwer-xyz/incudal) 的社区二开分支
（上游已于 2026-06-26 永久归档）。本分支在其基础上继续演进：依赖升级、安全加固、
部署标准化，并按《NovaIncus 项目计划书》推进网络编排、智能风控、弹性计费等能力。

## 版权与协议声明

本项目基于 BSD 3-Clause 协议的开源代码修改、分发。原项目版权归其作者所有，
`LICENSE` 文件完整保留。依据上游声明：

- 本项目依"现状（As-is）"提供，不对使用后果承担责任；
- NovaIncus 与上游 Incudal 项目 / 原作者无关，不代表其背书或提供技术支持；
- 请勿使用 "Incudal" 名称为本衍生项目背书或推广。

## 架构

```
[ 用户端 / 管理端 UI (Vue 3 + Vite) ]
              │ REST API + WebSocket
              ▼
[ Master Panel (Fastify + Prisma + Redis + PostgreSQL) ]
              │ mTLS + 私有 Agent 协议
              ▼
[ 母机节点 (Go Agent) ] → Incus (LXC/KVM)
```

| 目录 | 说明 |
|------|------|
| `client/` | Vue 3 + Vite 前端 |
| `server/` | Fastify + Prisma 后端 |
| `agent/` | Go 宿主机 Agent（状态上报、宿主机操作执行） |
| `server/prisma/` | 数据库 schema 与迁移 |
| `server/templates/` | 安装脚本、邮件与生成模板 |

## 快速部署

### 方式一：一键脚本（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/<org>/NovaIncus/main/install.sh | sudo bash
```

脚本会自动安装 Docker、生成随机密钥的 `.env`、拉起 `docker compose` 全家桶
（Panel + PostgreSQL + Redis），并输出管理员初始账号。

### 方式二：Docker Compose（1Panel 编排 / 手动）

1. 复制 `docker-compose.yml` 与 `.env.example` 为 `.env`，填好密钥；
2. `docker compose up -d`；
3. 打开 `http://<服务器IP>:3000`，用 `ADMIN_PASSWORD` 初始密码登录。

详见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 本地开发

```bash
corepack enable && corepack prepare pnpm@9.14.2 --activate
pnpm install
pnpm dev
```

Agent 开发需要 Go 1.23+：`cd agent && go test ./...`

## 路线图

见《NovaIncus 项目计划书》：稳定基础 → 网络增强与救援终端 → 智能风控引擎 →
计费升级与界面焕新 → 生态互联与开源发布。
