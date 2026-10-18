# NovaIncus API 简版文档

## 交互式文档

在 `server/src/app.ts` 中所有路由注册完成后调用
`registerOpenApi(fastify)`（见 `server/src/lib/openapi.ts` 顶部注释），
启动后访问：

- `GET /docs` —— Swagger UI
- `GET /docs/json` —— OpenAPI 3.0 JSON
- `GET /docs/yaml` —— OpenAPI 3.0 YAML

> 当前 `hideUntagged: true`，只有携带 schema/tags 的路由会被收录；
> 给路由补 schema 可渐进进行。

## 认证方式

| 方式 | 说明 |
|------|------|
| `bearerAuth`（主） | `POST /api/auth/login` 返回 access token，之后请求带 `Authorization: Bearer <token>`（@fastify/jwt） |
| `cookieAuth`（辅） | `refreshToken` cookie，用于 `POST /api/auth/refresh` 刷新令牌 |

管理接口需额外管理员角色（`authenticateAdmin`），普通用户接口用 `authenticate`。

## 主要资源路径

| 前缀 | 说明 |
|------|------|
| `/api/auth` | 登录 / 注册 / 刷新令牌 / 登出 |
| `/api/users` | 用户资料 |
| `/api/instances` | 实例 CRUD、`/instances/:id/start|stop|restart` 开关机、快照、续费/销毁 |
| `/api/hosts` | 宿主机管理（含批量配置） |
| `/api/packages` | 套餐方案 |
| `/api/ssh-keys` | SSH 密钥 |
| `/api/snapshots`（挂于 `/api/instances`） | 快照 |
| `/api/balance` | 余额查询 / 转账 |
| `/api/aff` | 推荐返利 |
| `/api/checkin` | 签到 / 兑换码 |
| `/api/tickets` | 工单 |
| `/api/notifications` | 站内通知 |
| `/api/terminal-saved-commands` | 终端常用命令 |
| `/api/announcements` | 公告 |
| `/api/system-config` | 系统配置（管理员） |
| `/api/telegram` | Telegram 绑定、Webhook 管理（管理员） |
| `/api/agent` | 宿主机 Agent 上报 / 二进制分发（mTLS + 专用鉴权） |
| `/api/ws/instances` | WebSocket 终端 |

## Telegram 机器人交互命令

机器人需在管理后台配置 token 并启用。用户先在网站「个人设置」生成
绑定链接并发送给机器人完成绑定，之后可用：

| 命令 | 说明 |
|------|------|
| `/instances` | 列出名下所有实例（名称、状态、IP） |
| `/start <实例名>` | 开机（提交异步任务） |
| `/stop <实例名>` | 关机（提交异步任务） |
| `/traffic <实例名>` | 查询本月已用 / 总量流量 |
| `/balance` | 查询账户余额 |
| `/join`、`/join_vip` | 申请加入普通 / 高级用户群 |

鉴权规则：命令只能操作发送者自己绑定的站内账号名下的实例；
实例管理类命令仅限私聊使用；开关机复用与 Web 端相同的异步任务队列
（`createInstanceTask`），并写入操作日志。
