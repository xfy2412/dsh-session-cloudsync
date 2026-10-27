#!/usr/bin/env bash
#
# dscs-server installer for Linux.
#
# This script is intentionally dependency-light: it installs the published
# `dscs-server` npm package into a versioned directory, switches a `current`
# symlink, and (optionally) manages a systemd unit. It never updates itself and
# never deletes the data directory unless --purge is explicit.
set -euo pipefail

VERSION="latest"
INSTALL_ROOT=""
DATA_DIR=""
RUN_USER=""
HOST="127.0.0.1"
PORT="8787"
SOURCE=""
REGISTRY=""
NO_SERVICE=0
UPGRADE=0
UNINSTALL=0
PURGE=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
用法: install.sh [选项]

选项:
  --version <v>         安装指定 npm 版本，默认 latest
  --install-dir <dir>   程序目录；root 默认 /opt/dscs，普通用户默认 ~/.local/share/dscs
  --data-dir <dir>      数据目录；root 默认 /var/lib/dscs，普通用户默认 <install-dir>/data
  --user <name>         systemd 运行用户；root 安装默认 dscs
  --host <addr>         监听地址，默认 127.0.0.1
  --port <n>            监听端口，默认 8787
  --source <archive>    从本地 .tgz/.tar.gz 安装，而不是 npm
  --registry <url>      覆盖 npm registry
  --no-service          不创建/启动 systemd 服务
  --upgrade             停服务、备份数据、安装新版本并重启
  --uninstall           卸载程序和服务，保留数据
  --purge               配合 --uninstall，同时删除数据
  --yes                 不询问确认
  -h, --help            显示帮助

需要 Node.js >= 24 和 npm。
EOF
}

log() { printf '[dscs] %s\n' "$*"; }
warn() { printf '[dscs] 警告: %s\n' "$*" >&2; }
die() { printf '[dscs] 错误: %s\n' "$*" >&2; exit 1; }

need_value() {
  [[ $# -ge 2 && -n "$2" ]] || die "参数 $1 缺少值"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) need_value "$@"; VERSION="$2"; shift 2 ;;
    --install-dir) need_value "$@"; INSTALL_ROOT="$2"; shift 2 ;;
    --data-dir) need_value "$@"; DATA_DIR="$2"; shift 2 ;;
    --user) need_value "$@"; RUN_USER="$2"; shift 2 ;;
    --host) need_value "$@"; HOST="$2"; shift 2 ;;
    --port) need_value "$@"; PORT="$2"; shift 2 ;;
    --source) need_value "$@"; SOURCE="$2"; shift 2 ;;
    --registry) need_value "$@"; REGISTRY="$2"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --upgrade) UPGRADE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] || die "端口必须是数字"
command -v tar >/dev/null 2>&1 || die "需要 tar"
command -v npm >/dev/null 2>&1 || die "需要 npm"

IS_ROOT=0
if [[ "$(id -u)" -eq 0 ]]; then IS_ROOT=1; fi

if [[ -z "$INSTALL_ROOT" ]]; then
  if [[ "$IS_ROOT" -eq 1 ]]; then INSTALL_ROOT="/opt/dscs"; else INSTALL_ROOT="$HOME/.local/share/dscs"; fi
fi
if [[ -z "$DATA_DIR" ]]; then
  if [[ "$IS_ROOT" -eq 1 ]]; then DATA_DIR="/var/lib/dscs"; else DATA_DIR="$INSTALL_ROOT/data"; fi
fi
if [[ -z "$RUN_USER" ]]; then
  if [[ "$IS_ROOT" -eq 1 ]]; then RUN_USER="dscs"; else RUN_USER="$(id -un)"; fi
fi

SERVICE_NAME="dscs"
CURRENT_LINK="$INSTALL_ROOT/current"
RELEASES_DIR="$INSTALL_ROOT/releases"

if [[ "$IS_ROOT" -eq 0 && "$NO_SERVICE" -eq 0 && "$RUN_USER" != "$(id -un)" ]]; then
  die "普通用户只能使用当前用户；如不需要 systemd，请加 --no-service"
fi

# ---- uninstall ------------------------------------------------------------
stop_service() {
  if [[ "$NO_SERVICE" -eq 1 ]]; then return 0; fi
  if [[ "$IS_ROOT" -eq 1 ]]; then
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$SERVICE_NAME.service" >/dev/null 2>&1; then
      systemctl stop "$SERVICE_NAME" 2>/dev/null || true
      systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    fi
  else
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
      systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
    fi
  fi
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  log "正在停止 dscs-server"
  stop_service
  if [[ "$NO_SERVICE" -eq 0 ]]; then
    if [[ "$IS_ROOT" -eq 1 ]]; then
      rm -f "/etc/systemd/system/$SERVICE_NAME.service"
      command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true
    else
      rm -f "$HOME/.config/systemd/user/$SERVICE_NAME.service"
      command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload || true
    fi
  fi
  rm -rf "$CURRENT_LINK" "$RELEASES_DIR"
  if [[ "$PURGE" -eq 1 ]]; then
    if [[ "$ASSUME_YES" -eq 0 ]]; then
      read -r -p "是否删除数据目录 $DATA_DIR？[y/N] " answer
      [[ "$answer" =~ ^[Yy]$ ]] || die "已取消；数据未删除"
    fi
    rm -rf "$DATA_DIR"
    log "已删除数据目录：$DATA_DIR"
  else
    log "已保留数据目录：$DATA_DIR（使用 --purge 可删除）"
  fi
  log "卸载完成"
  exit 0
fi

# ---- prerequisites and directories ---------------------------------------
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 24 ]] || die "需要 Node.js >= 24（当前 $("$NODE_BIN" -v)）"
if [[ -n "$SOURCE" && ! -f "$SOURCE" ]]; then die "找不到安装包：$SOURCE"; fi
if [[ -n "$REGISTRY" ]]; then export npm_config_registry="$REGISTRY"; fi

if [[ "$IS_ROOT" -eq 1 ]]; then
  if ! id -u "$RUN_USER" >/dev/null 2>&1; then
    log "正在创建系统用户：$RUN_USER"
    useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  fi
fi

mkdir -p "$INSTALL_ROOT" "$RELEASES_DIR" "$DATA_DIR"
if [[ "$IS_ROOT" -eq 1 ]]; then chown "$RUN_USER:$RUN_USER" "$DATA_DIR"; fi

# ---- upgrade backup -------------------------------------------------------
if [[ "$UPGRADE" -eq 1 && -d "$DATA_DIR" ]]; then
  stop_service
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="${DATA_DIR}.backup-${stamp}.tar.gz"
  log "正在备份数据到 $backup"
  tar -czf "$backup" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
fi

# ---- install --------------------------------------------------------------
install_from_archive() {
  local archive="$1" destination="$2"
  mkdir -p "$destination"
  tar -xzf "$archive" -C "$destination"
  if [[ -d "$destination/package" ]]; then
    mv "$destination/package" "$destination/package.payload"
    find "$destination/package.payload" -mindepth 1 -maxdepth 1 -exec mv {} "$destination/" \;
    rmdir "$destination/package.payload"
  fi
}

find_entry() {
  local release="$1"
  local candidate
  for candidate in \
    "$release/node_modules/dscs-server/dist/index.js" \
    "$release/package/dist/index.js" \
    "$release/dist/index.js"; do
    if [[ -f "$candidate" ]]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

if [[ -n "$SOURCE" ]]; then
  RELEASE_ID="local-$(date +%Y%m%d-%H%M%S)"
  RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
  log "正在安装本地包：$SOURCE"
  install_from_archive "$SOURCE" "$RELEASE_DIR"
  ENTRY="$(find_entry "$RELEASE_DIR")" || die "安装包中没有 dist/index.js"
else
  RESOLVED_VERSION="$VERSION"
  if [[ "$RESOLVED_VERSION" == "latest" ]]; then
    RESOLVED_VERSION="$(npm view dscs-server version --silent)" || die "无法解析 dscs-server 最新版本"
  fi
  [[ "$RESOLVED_VERSION" =~ ^[0-9A-Za-z._+-]+$ ]] || die "版本号不合法：$RESOLVED_VERSION"
  RELEASE_DIR="$RELEASES_DIR/$RESOLVED_VERSION"
  ENTRY="$RELEASE_DIR/node_modules/dscs-server/dist/index.js"
  if [[ ! -f "$ENTRY" ]]; then
    log "正在安装 dscs-server@$RESOLVED_VERSION"
    npm install --prefix "$RELEASE_DIR" --omit=dev --no-audit --no-fund "dscs-server@$RESOLVED_VERSION"
  fi
  ENTRY="$(find_entry "$RELEASE_DIR")" || die "npm 安装后没有 dist/index.js"
fi

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
log "服务端已安装到 $RELEASE_DIR"

# ---- systemd --------------------------------------------------------------
if [[ "$NO_SERVICE" -eq 0 ]]; then
  if [[ "$IS_ROOT" -eq 1 ]]; then
    UNIT_DIR="/etc/systemd/system"
    UNIT_FILE="$UNIT_DIR/$SERVICE_NAME.service"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=dscs-server (DSH Session CloudSync)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
ExecStart="$NODE_BIN" "$ENTRY" serve --data-dir "$DATA_DIR" --host "$HOST" --port "$PORT"
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now "$SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"
  elif command -v systemctl >/dev/null 2>&1; then
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT_FILE="$UNIT_DIR/$SERVICE_NAME.service"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=dscs-server (DSH Session CloudSync)
After=network-online.target

[Service]
Type=simple
ExecStart="$NODE_BIN" "$ENTRY" serve --data-dir "$DATA_DIR" --host "$HOST" --port "$PORT"
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVICE_NAME"
    systemctl --user restart "$SERVICE_NAME"
  else
    warn "systemd 不可用；请手动运行服务端"
  fi
fi

# ---- health ---------------------------------------------------------------
check_url="http://127.0.0.1:$PORT/health"
if [[ "$NO_SERVICE" -eq 0 ]]; then
  log "等待 $check_url"
  ok=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if command -v curl >/dev/null 2>&1 && curl -fsS "$check_url" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [[ "$ok" -eq 0 ]]; then
    warn "健康检查未通过；请运行 systemctl status $SERVICE_NAME 排查"
  fi
fi

if [[ "$NO_SERVICE" -eq 1 ]]; then
  SERVICE_LABEL="未安装"
else
  SERVICE_LABEL="$SERVICE_NAME (systemd)"
fi

cat <<EOF

dscs-server 安装完成
  程序目录:   $RELEASE_DIR
  当前版本:   $CURRENT_LINK
  数据目录:   $DATA_DIR
  监听地址:   http://$HOST:$PORT
  管理台:     http://127.0.0.1:$PORT/admin
  初始化码:   $DATA_DIR/onboarding-code.json（首次启动，10 分钟内有效）
  服务状态:   $SERVICE_LABEL

首次启动会打印初始化密钥。打开 /admin 设置管理密码，
然后签发设备 token，在 DSH 中填写同一服务端地址和同步口令。
EOF
