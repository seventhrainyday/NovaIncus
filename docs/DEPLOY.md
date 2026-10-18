# NovaIncus 部署指南

本文档覆盖三种部署方式：**一键脚本**（推荐）、**1Panel 创建编排**（单文件粘贴）、**手动 docker compose**。

---

## 方式一：一键脚本（推荐）

```bash
git clone <仓库地址> novaincus
cd novaincus
sudo bash install.sh
```

脚本会自动完成：

1. 检测发行版（Debian / Ubuntu / CentOS / RHEL / Alpine / Arch 等）
2. 未安装 Docker 时自动安装 Docker Engine + Compose 插件
3. 调用 `scripts/init-env.sh` 生成 `.env`（JWT_SECRET / COOKIE_SECRET / ENCRYPTION_KEY / POSTGRES_PASSWORD / REDIS_PASSWORD / ADMIN_PASSWORD 全部随机生成，已有配置不覆盖）
4. 生成面板↔母机 mTLS 客户端证书（`server/certs/client.crt` + `client.key`）
5. 本地构建镜像并 `docker compose up -d` 启动
6. 等待 `/api/health` 通过后输出访问地址和管理员账号密码

其他用法：

```bash
sudo bash install.sh --uninstall   # 卸载（删除容器与数据卷，.env 自动备份）
bash install.sh --help             # 帮助
```

> ⚠️ `.env` 权限会被设为 600；**ENCRYPTION_KEY 上线后必须稳定保存**，更换会导致已加密数据（如 2FA 密钥）无法解密。

---

## 方式二：1Panel「创建编排」单文件粘贴

在 1Panel → 容器 → 编排 → 创建编排，粘贴以下内容。**先把 6 处 `REPLACE_ME_*` 替换为随机值**（生成命令见下方）：

```bash
# 生成随机密钥（每条跑一次）
openssl rand -hex 24                                            # POSTGRES_PASSWORD
openssl rand -hex 24                                            # REDIS_PASSWORD
printf 'A1!%s' "$(openssl rand -hex 48)" | cut -c1-64            # JWT_SECRET
printf 'A1!%s' "$(openssl rand -hex 48)" | cut -c1-64            # COOKIE_SECRET
openssl rand -base64 32                                         # ENCRYPTION_KEY
openssl rand -hex 8                                             # ADMIN_PASSWORD
```

```yaml
services:
  app:
    # 注意：1Panel 编排无法本地构建，请先在有源码的机器上构建并推送镜像，
    # 或改用方式一/方式三。如已有镜像，取消下一行注释并注释掉 build：
    # image: ghcr.io/<你的组织>/novaincus:latest
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      # 如需面板直接对外访问，把 127.0.0.1 改为 0.0.0.0（建议配反代+HTTPS再放行）
      - "127.0.0.1:3000:3000"
    environment:
      - NODE_ENV=production
      - HOST=0.0.0.0
      - PORT=3000
      - DATABASE_URL=postgresql://incudal:REPLACE_ME_POSTGRES_PASSWORD@db:5432/incudal
      - REDIS_URL=redis://:REPLACE_ME_REDIS_PASSWORD@redis:6379
      - JWT_SECRET=REPLACE_ME_JWT_SECRET
      - COOKIE_SECRET=REPLACE_ME_COOKIE_SECRET
      - ENCRYPTION_KEY=REPLACE_ME_ENCRYPTION_KEY
      - FRONTEND_URL=                              # 填面板公网地址，如 https://panel.example.com
      - LOG_LEVEL=info
      - DISABLE_REQUEST_LOG=true
      - ADMIN_PASSWORD=REPLACE_ME_ADMIN_PASSWORD
    volumes:
      - ./server/certs:/app/server/certs:ro
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=incudal
      - POSTGRES_PASSWORD=REPLACE_ME_POSTGRES_PASSWORD
      - POSTGRES_DB=incudal
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U incudal"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass REPLACE_ME_REDIS_PASSWORD
    volumes:
      - redis_data:/data
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:

networks:
  default:
    driver: bridge
    enable_ipv6: true
    ipam:
      config:
        - subnet: "172.31.0.0/16"
        - subnet: "fd42:dead:beef:10::/64"
```

> 说明：
> - 1Panel 编排的构建上下文是编排目录，`build.context: .` 需要该目录下有完整源码（含 Dockerfile）；只有 compose 文件而无源码时，请用方式一或方式三。
> - `server/certs` 用于面板↔母机 mTLS 证书（`client.crt`/`client.key`）；添加母机前需把证书放入该目录（方式一会自动生成）。

---

## 方式三：手动 docker compose

```bash
git clone <仓库地址> novaincus && cd novaincus

# 生成 .env（随机密钥，不覆盖已有值）
bash scripts/init-env.sh
# 或：cp .env.example .env  后手动填入密钥

# 构建并启动
docker compose up -d --build

# 查看启动日志（首次含 Prisma 迁移）
docker compose logs -f app
```

面板就绪后访问 `http://<服务器IP>:3000`（默认账号 `admin`，密码见 `.env` 中的 `ADMIN_PASSWORD`）。

常用命令：

```bash
docker compose logs -f app        # 看日志
docker compose restart            # 重启
docker compose down               # 停止（保留数据）
docker compose down -v            # 停止并删除数据卷（⚠️ 数据库清空）
```

---

## 端口说明

| 服务    | 容器内 | 宿主机发布          | 说明                              |
| ------- | ------ | ------------------- | --------------------------------- |
| app     | 3000   | 127.0.0.1:3000      | 面板 Web + API（经反代对外）      |
| db      | 5432   | 未发布              | 仅 compose 内网可达               |
| redis   | 6379   | 未发布              | 仅 compose 内网可达               |

> 生产环境建议：面板不要直接暴露公网端口，前面加 Nginx / Caddy / 1Panel 反代并配置 HTTPS。`FRONTEND_URL` 必须设为面板的公网地址，否则节点注册、支付回调等功能不可用。

---

## 常见问题

**Q: 首次启动后 /api/health 一直不通？**
A: 首次 `docker compose up -d --build` 需要构建前后端镜像（几分钟），随后容器内还会跑 `prisma migrate deploy`。用 `docker compose logs -f app` 观察，看到 `🚀 Starting application...` 后再等 10~20 秒。

**Q: FRONTEND_URL 为空有什么影响？**
A: 面板本身可访问，但节点安装脚本下载地址、支付回调地址等依赖公网地址的功能不可用。设置后执行 `docker compose up -d` 使其生效。

**Q: 忘记管理员密码怎么办？**
A: `.env` 中的 `ADMIN_PASSWORD` 仅在首次初始化时生效。修改密码请登录面板后在用户设置中更改；若完全无法登录，可查阅 `server/src` 中管理员初始化逻辑或重建数据库（会清空数据）。

**Q: ENCRYPTION_KEY 可以换吗？**
A: 不建议。2FA 密钥等敏感数据用它加密，更换后旧数据无法解密。务必备份 `.env`。

**Q: 如何更换面板端口？**
A: 修改 `.env` 中的 `APP_PORT`（或 compose 中的发布端口），`docker compose up -d` 重建 app 容器即可。

**Q: 如何升级？**
A: `git pull` 拉取新代码后 `docker compose up -d --build`。数据库迁移在容器启动时自动执行。

**Q: 如何备份数据？**
A: 备份两个命名卷（`postgres_data`、`redis_data`）和 `.env` 文件即可。例如：
`docker run --rm -v novaincus_postgres_data:/data -v /backup:/backup alpine tar czf /backup/pg-$(date +%F).tgz -C /data .`

**Q: 母机 agent 如何对接面板？**
A: 在面板添加母机后，按面板给出的安装命令在母机上部署 `novaincus-agent`（详见 `agent/README.md` 与 `agent/config.example.yaml`）。agent 与面板之间使用 mTLS + 签名认证，需要面板侧 `server/certs` 中的客户端证书。
