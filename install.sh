#!/usr/bin/env bash
# ============================================================================
# NovaIncus 面板一键部署脚本（Docker 模式，从本地源码构建）
#
# 功能：
#   - 自动安装 Docker Engine + Docker Compose 插件（Debian/Ubuntu/CentOS/
#     RHEL/Alpine/Arch 等常见发行版）
#   - 调用 scripts/init-env.sh 生成 .env（随机密钥，不覆盖已有配置）
#   - 本地构建镜像并 docker compose up -d 启动
#   - 等待面板健康检查通过后输出访问地址与管理员账号
#
# 用法：
#   安装：  sudo bash install.sh
#   卸载：  sudo bash install.sh --uninstall
#   帮助：  bash install.sh --help
#
# 要求：在仓库根目录（包含 docker-compose.yml 的目录）下运行。
# ============================================================================
set -euo pipefail

# ========================== 全局常量 ==========================
readonly SCRIPT_VERSION="1.0.0"
readonly PROJECT_NAME="NovaIncus"
readonly DEFAULT_PORT=3000
readonly HEALTH_TIMEOUT=180   # 健康检查最长等待秒数

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
readonly ENV_FILE="${SCRIPT_DIR}/.env"
readonly INIT_ENV_SCRIPT="${SCRIPT_DIR}/scripts/init-env.sh"

# ========================== 颜色定义 ==========================
readonly RED='\033[1;31m'
readonly GREEN='\033[1;32m'
readonly YELLOW='\033[1;33m'
readonly CYAN='\033[1;36m'
readonly BOLD='\033[1m'
readonly DIM='\033[2m'
readonly NC='\033[0m'

# ========================== 工具函数 ==========================
# 日志统一输出到 stderr，避免在 $() 捕获中混入
log()   { echo -e "${GREEN}[✓]${NC} $1" >&2; }
info()  { echo -e "${CYAN}[i]${NC} $1" >&2; }
warn()  { echo -e "${YELLOW}[!]${NC} $1" >&2; }
error() { echo -e "${RED}[✗]${NC} $1" >&2; }
step()  { echo -e "\n${CYAN}[▶]${NC} ${BOLD}$1${NC}" >&2; }

# 从 .env 中读取单个键的值（不 source，避免执行任意内容）
get_env_value() {
    local key="$1"
    if [[ ! -f "$ENV_FILE" ]]; then
        return 0
    fi
    grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d'=' -f2- || true
}

# ========================== 系统检查 ==========================
check_root() {
    if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
        error "请以 root 权限运行此脚本！"
        error "用法: sudo bash $0"
        exit 1
    fi
}

check_repo() {
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        error "未在 ${SCRIPT_DIR} 找到 docker-compose.yml"
        error "请在 NovaIncus 仓库根目录下运行此脚本。"
        exit 1
    fi
    if [[ ! -f "$INIT_ENV_SCRIPT" ]]; then
        error "未找到 ${INIT_ENV_SCRIPT}，仓库不完整。"
        exit 1
    fi
}

# 检测发行版，返回 pm=<包管理器> / distro=<id>
detect_distro() {
    DISTRO_ID="unknown"
    DISTRO_LIKE=""
    if [[ -f /etc/os-release ]]; then
        DISTRO_ID="$(grep -E '^ID=' /etc/os-release | cut -d'=' -f2 | tr -d '"' || echo unknown)"
        DISTRO_LIKE="$(grep -E '^ID_LIKE=' /etc/os-release | cut -d'=' -f2 | tr -d '"' || echo "")"
    fi
    PKG_MGR=""
    if command -v apt-get >/dev/null 2>&1; then
        PKG_MGR="apt"
    elif command -v dnf >/dev/null 2>&1; then
        PKG_MGR="dnf"
    elif command -v yum >/dev/null 2>&1; then
        PKG_MGR="yum"
    elif command -v apk >/dev/null 2>&1; then
        PKG_MGR="apk"
    elif command -v pacman >/dev/null 2>&1; then
        PKG_MGR="pacman"
    fi
    log "系统检测: ${DISTRO_ID}（包管理器: ${PKG_MGR:-未知}）"
}

# 用系统包管理器安装基础工具
pkg_install() {
    case "$PKG_MGR" in
        apt)
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq >/dev/null 2>&1 || true
            apt-get install -y -qq "$@" >/dev/null 2>&1
            ;;
        dnf)  dnf install -y -q "$@" >/dev/null 2>&1 ;;
        yum)  yum install -y -q "$@" >/dev/null 2>&1 ;;
        apk)  apk add --no-cache "$@" >/dev/null 2>&1 ;;
        pacman) pacman -Sy --noconfirm --needed "$@" >/dev/null 2>&1 ;;
        *)
            error "未知包管理器，无法自动安装: $*"
            error "请手动安装后重试。"
            exit 1
            ;;
    esac
}

ensure_base_tools() {
    step "检查基础工具..."
    local missing=()
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v openssl >/dev/null 2>&1 || missing+=("openssl")
    if [[ "${#missing[@]}" -gt 0 ]]; then
        info "正在安装缺失工具: ${missing[*]}"
        pkg_install "${missing[@]}"
    fi
    log "基础工具就绪"
}

# ========================== 安装 Docker ==========================
docker_compose_ok() {
    docker compose version >/dev/null 2>&1
}

install_docker() {
    step "检查 Docker..."

    if command -v docker >/dev/null 2>&1 && docker_compose_ok; then
        log "Docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',') + Compose 已安装，跳过"
        return 0
    fi

    info "正在安装 Docker Engine + Compose 插件..."

    if [[ "$DISTRO_ID" == "alpine" ]]; then
        # Alpine：官方 get.docker.com 不支持，走 apk 社区包
        pkg_install docker docker-cli-compose
    else
        local installer
        installer="$(mktemp)"
        if ! curl -fsSL https://get.docker.com -o "$installer"; then
            rm -f "$installer"
            error "无法下载 Docker 官方安装脚本（网络不可达）"
            error "请手动安装 Docker 后重试：https://docs.docker.com/engine/install/"
            exit 1
        fi
        sh "$installer"
        rm -f "$installer"
    fi

    # 尝试启动 Docker 服务
    if command -v systemctl >/dev/null 2>&1; then
        systemctl enable docker >/dev/null 2>&1 || true
        systemctl start docker >/dev/null 2>&1 || true
    elif command -v rc-service >/dev/null 2>&1; then
        rc-update add docker default >/dev/null 2>&1 || true
        rc-service docker start >/dev/null 2>&1 || true
    fi

    if ! command -v docker >/dev/null 2>&1; then
        error "Docker 安装后仍不可用，请检查上面的安装输出。"
        exit 1
    fi
    if ! docker_compose_ok; then
        error "docker compose 插件不可用，请手动安装 docker-compose-plugin 后重试。"
        exit 1
    fi
    log "Docker 安装完成"
}

# ========================== 生成 .env ==========================
# 把模板占位值（CHANGE_ME*）视作缺失，让 init-env.sh 重新生成随机值
sanitize_env_placeholders() {
    if [[ -f "$ENV_FILE" ]] && grep -qE '^[A-Z_]+=CHANGE_ME' "$ENV_FILE" 2>/dev/null; then
        local tmp
        tmp="$(mktemp)"
        grep -vE '^[A-Z_]+=CHANGE_ME' "$ENV_FILE" > "$tmp" || true
        cat "$tmp" > "$ENV_FILE"
        rm -f "$tmp"
        info "已清除 .env 中的模板占位值，将重新生成随机密钥"
    fi
}

ensure_env() {
    step "准备环境配置..."

    if [[ -f "$ENV_FILE" ]]; then
        info ".env 已存在，仅补齐缺失项（不覆盖已有配置）"
        sanitize_env_placeholders
    else
        info ".env 不存在，将自动生成随机密钥"
    fi

    # init-env.sh 默认读写当前目录下的 .env；切到仓库根目录执行
    ( cd "$SCRIPT_DIR" && bash "$INIT_ENV_SCRIPT" )
    chmod 600 "$ENV_FILE"
    log ".env 就绪: ${ENV_FILE}"
}

# ========================== 生成面板客户端证书 ==========================
# 母机 agent 通过 mTLS 与面板通信，需要面板侧的客户端证书
generate_panel_cert() {
    local cert_dir="${SCRIPT_DIR}/server/certs"
    local cert_file="${cert_dir}/client.crt"
    local key_file="${cert_dir}/client.key"

    if [[ -f "$cert_file" && -f "$key_file" ]]; then
        log "面板客户端证书已存在，跳过生成"
        return 0
    fi

    step "生成面板客户端证书..."
    mkdir -p "$cert_dir"
    openssl req -x509 -newkey rsa:4096 \
        -keyout "$key_file" \
        -out "$cert_file" \
        -days 3650 -nodes \
        -subj "/CN=novaincus-panel/O=NovaIncus" 2>/dev/null
    chmod 644 "$cert_file" "$key_file"
    log "面板客户端证书已生成（RSA 4096，有效期 10 年）"
}

# ========================== 启动服务 ==========================
start_services() {
    step "构建并启动服务（首次构建需要几分钟）..."

    cd "$SCRIPT_DIR"
    docker compose up -d --build

    step "等待面板就绪..."
    local app_port
    app_port="$(get_env_value APP_PORT)"
    app_port="${app_port:-$DEFAULT_PORT}"

    local waited=0
    while [[ "$waited" -lt "$HEALTH_TIMEOUT" ]]; do
        if curl -sf --max-time 3 "http://127.0.0.1:${app_port}/api/health" >/dev/null 2>&1; then
            log "面板已就绪"
            return 0
        fi
        sleep 3
        waited=$((waited + 3))
    done

    warn "等待超时，面板尚未通过健康检查，请查看日志："
    warn "  cd ${SCRIPT_DIR} && docker compose logs -f app"
    return 1
}

# ========================== 显示结果 ==========================
show_result() {
    local app_port admin_pass frontend_url
    app_port="$(get_env_value APP_PORT)"; app_port="${app_port:-$DEFAULT_PORT}"
    admin_pass="$(get_env_value ADMIN_PASSWORD)"
    frontend_url="$(get_env_value FRONTEND_URL)"

    local access_url="${frontend_url:-http://<服务器IP>:${app_port}}"

    echo "" >&2
    echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}" >&2
    echo -e "${GREEN}║                                                  ║${NC}" >&2
    echo -e "${GREEN}║        ✅  ${PROJECT_NAME} 部署完成！              ║${NC}" >&2
    echo -e "${GREEN}║                                                  ║${NC}" >&2
    echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}" >&2
    echo "" >&2
    echo -e "  ${BOLD}访问地址${NC}     ${access_url}" >&2
    echo -e "  ${BOLD}管理员账号${NC}   admin" >&2
    echo -e "  ${BOLD}管理员密码${NC}   ${admin_pass}" >&2
    echo "" >&2
    echo -e "  ${YELLOW}本次生成的密钥（请妥善保存，.env 权限已设为 600）:${NC}" >&2
    echo -e "  ${DIM}POSTGRES_PASSWORD${NC}=$(get_env_value POSTGRES_PASSWORD)" >&2
    echo -e "  ${DIM}REDIS_PASSWORD${NC}=$(get_env_value REDIS_PASSWORD)" >&2
    echo -e "  ${DIM}JWT_SECRET${NC}=$(get_env_value JWT_SECRET)" >&2
    echo -e "  ${DIM}COOKIE_SECRET${NC}=$(get_env_value COOKIE_SECRET)" >&2
    echo -e "  ${DIM}ENCRYPTION_KEY${NC}=$(get_env_value ENCRYPTION_KEY)" >&2
    echo "" >&2
    echo -e "  ${YELLOW}常用命令:${NC}" >&2
    echo -e "  ${DIM}查看日志${NC}   cd ${SCRIPT_DIR} && docker compose logs -f app" >&2
    echo -e "  ${DIM}重启服务${NC}   cd ${SCRIPT_DIR} && docker compose restart" >&2
    echo -e "  ${DIM}停止服务${NC}   cd ${SCRIPT_DIR} && docker compose down" >&2
    echo -e "  ${DIM}卸载面板${NC}   sudo bash ${SCRIPT_DIR}/install.sh --uninstall" >&2
    echo "" >&2

    if [[ -z "$frontend_url" ]]; then
        warn "FRONTEND_URL 为空：面板可访问，但节点注册/支付回调等功能需要公网地址"
        warn "请在 ${ENV_FILE} 中设置 FRONTEND_URL 后重启：docker compose up -d"
    fi
}

# ========================== 安装流程 ==========================
do_install() {
    step "${PROJECT_NAME} 一键安装 v${SCRIPT_VERSION}"

    check_repo
    detect_distro
    ensure_base_tools
    install_docker
    ensure_env
    generate_panel_cert

    if start_services; then
        show_result
    else
        exit 1
    fi
}

# ========================== 卸载流程 ==========================
do_uninstall() {
    echo "" >&2
    echo -e "${RED}${BOLD}⚠  警告：卸载将停止所有容器并删除数据卷（数据库数据会丢失）！${NC}" >&2
    echo "" >&2
    echo -ne "  ${BOLD}确认卸载？输入 'yes' 继续: ${NC}" >&2
    read -r confirm || confirm=""

    if [[ "$confirm" != "yes" ]]; then
        info "已取消卸载"
        exit 0
    fi

    step "卸载 ${PROJECT_NAME}..."

    if [[ -f "$COMPOSE_FILE" ]]; then
        cd "$SCRIPT_DIR"
        info "停止容器并删除数据卷..."
        docker compose down -v 2>/dev/null || true
    fi

    # .env 保留但改名备份，避免误删密钥
    if [[ -f "$ENV_FILE" ]]; then
        mv "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
        info ".env 已备份为 .env.bak.*（内含密钥，请自行决定是否删除）"
    fi

    log "卸载完成（Docker Engine 未被移除）"
}

# ========================== 主入口 ==========================
main() {
    # 帮助不需要 root 权限
    case "${1:-}" in
        --help|-h)
            echo "${PROJECT_NAME} 一键部署脚本 v${SCRIPT_VERSION}"
            echo ""
            echo "用法: sudo bash $0 [选项]"
            echo ""
            echo "选项:"
            echo "  (无参数)      全新安装（自动装 Docker、生成 .env、构建启动）"
            echo "  --uninstall   卸载面板（删除容器与数据卷，.env 自动备份）"
            echo "  --help        显示本帮助"
            echo ""
            echo "要求：在 NovaIncus 仓库根目录下运行。"
            return 0
            ;;
    esac

    check_root

    case "${1:-}" in
        --uninstall|--remove)
            do_uninstall
            ;;
        "")
            do_install
            ;;
        *)
            error "未知参数: $1"
            error "用法: sudo bash $0 [--uninstall|--help]"
            exit 1
            ;;
    esac
}

main "$@"
