#!/bin/zsh
# dsh-phone-remote 一键安装（macOS）
#
# 两种方案，装哪一种由参数决定（不填则自动判断）：
#   --desktop  方案 A：手机连「桌面版 DeepSeek Harness」本体
#              （同一个工作区、同一批会话、同一份实时状态；桌面版必须开着）
#   --web      方案 B：托管一个独立的 `dsh web`（127.0.0.1:3080）
#              （电脑上不装桌面版、或想给手机一个干净的独立实例时用）
#   自动判断   装了 /Applications/DeepSeek Harness.app → desktop，否则 web
#
# 装好后：手机浏览器打开打印出的网址 → 输密码 → 添加到主屏幕。
set -euo pipefail

usage() {
  cat <<'EOF'
用法: ./install.sh [--desktop|--web]

  --desktop   方案 A：连桌面版 DeepSeek Harness（推荐，装了桌面版时）
  --web       方案 B：托管独立 `dsh web`（默认 3080 端口）
  不带参数    自动判断（有桌面版 App 用 A，否则用 B）
EOF
}

MODE=""
for arg in "$@"; do
  case "$arg" in
    --desktop) MODE=desktop ;;
    --web) MODE=web ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $arg"; usage; exit 1 ;;
  esac
done

APP_PATH="/Applications/DeepSeek Harness.app"
if [ -z "$MODE" ]; then
  if [ -d "$APP_PATH" ]; then MODE=desktop; else MODE=web; fi
  echo "==> 未指定方案，自动选择：$MODE"
fi

if [ "$(uname)" != "Darwin" ]; then echo "macOS 专用脚本（Linux 用 install-linux.sh）"; exit 1; fi
if ! command -v cloudflared >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "==> 安装 cloudflared ..."
    brew install cloudflared
  else
    echo "需要 cloudflared。请先安装 Homebrew（https://brew.sh），再执行: brew install cloudflared"; exit 1
  fi
fi

# dsh 的入口用 import.meta.main 判断"是否被直接执行"，那是 Node 22.18+ / 24 才有的。
# 旧 Node 会**静默退出 0**（什么都不打印，也不监听端口），所以这里主动挑一个能用的 node。
pick_node() {
  local candidates=() c
  c="$(command -v node 2>/dev/null || true)"
  [ -n "$c" ] && candidates+=("$c")
  for c in "$HOME"/.nvm/versions/node/*/bin/node(N); do candidates+=("$c"); done
  candidates+=(/opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node)
  for c in "${candidates[@]}"; do
    [ -x "$c" ] || continue
    if "$c" --input-type=module -e 'process.exit(import.meta.main === true ? 0 : 1)' 2>/dev/null; then
      echo "$c"
      return 0
    fi
  done
  return 1
}
if ! NODE_BIN="$(pick_node)"; then
  echo "需要 Node.js ≥ 22.18（或 24）：brew install node  或  nvm install 24"
  exit 1
fi
NODE_BIN_DIR="$(dirname "$NODE_BIN")"
CLOUDFLARED_BIN="$(command -v cloudflared)"
DSH_BIN="$(command -v dsh 2>/dev/null || true)"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
UID_NUM="$(id -u)"
CREDS="$DSH_DIR/.credentials.yaml"

echo "==> 方案：$([ "$MODE" = desktop ] && echo 'A · 桌面版本体' || echo 'B · 独立 dsh web')（node: $("$NODE_BIN" -v)）"

mkdir -p "$DSH_DIR/bin" "$DSH_DIR/logs"

# ---------------------------------------------------------------- 前置检查
if [ "$MODE" = desktop ]; then
  [ -d "$APP_PATH" ] || { echo "没找到 $APP_PATH —— 桌面版没装？想用方案 B 就加 --web"; exit 1; }
  if [ ! -f "$CREDS" ]; then
    echo "==> 缺少 $CREDS"
    echo "    先启动一次 DeepSeek Harness 桌面版（让它生成 credentials），再重新运行本脚本。"
    exit 1
  fi
  # 注意：$PS_OUT 先存进变量，别用 `ps | grep -q`——grep 提前退出会让 ps 收到
  # SIGPIPE，配合 set -o pipefail 会被误判成"没在运行"。
  PS_OUT="$(ps -axo command= 2>/dev/null || true)"
  if [[ "$PS_OUT" != *dsh-desktop-host* ]]; then
    echo "==> 提醒：桌面版现在没在运行。手机要能连，它得开着（装完可以先打开它）。"
  fi
else
  if [ -z "$DSH_BIN" ]; then
    echo "==> 没找到 dsh 命令，将用 npm exec @deepseek-ai/dsh web 兜底（首次会下载）"
  fi
fi

# ------------------------------------------------- 1) 鉴权配置（保留密码）
node -e '
  const fs = require("fs");
  const [file, mode, home, creds] = process.argv.slice(1);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const c = require("crypto");
  cfg.password ??= [...Array(3)].map(() => c.randomBytes(3).toString("hex").slice(0, 4)).join("-");
  cfg.secret ??= c.randomBytes(32).toString("hex");
  cfg.listen ??= "127.0.0.1:8443";
  cfg.cookieName ??= "dsh_remote";
  cfg.cookieMaxAgeDays ??= 180;
  cfg.target = mode === "desktop" ? "desktop" : "url";
  cfg.upstream = "http://127.0.0.1:3080";
  cfg.auth = "dsh-cookie";
  cfg.credentialsFile = creds;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
' "$DSH_DIR/remote-auth.json" "$MODE" "$HOME" "$CREDS"
echo "==> 配置已写入 ~/.dsh/remote-auth.json（target=$([ "$MODE" = desktop ] && echo desktop || echo url)）"

# ------------------------------------------------------------ 2) 鉴权代理
cp "$REPO_DIR/proxy/dsh-auth-proxy.mjs" "$DSH_DIR/bin/"
chmod +x "$DSH_DIR/bin/dsh-auth-proxy.mjs"

# ------------------------------------------------- 3) 启动脚本 + launchd 服务
sed -e "s|__CLOUDFLARED__|$CLOUDFLARED_BIN|g" -e "s|__HOME__|$HOME|g" \
  "$REPO_DIR/scripts/dsh-cloudflared.sh" > "$DSH_DIR/bin/dsh-cloudflared.sh"
chmod +x "$DSH_DIR/bin/dsh-cloudflared.sh"

if [ "$MODE" = web ]; then
  sed -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" -e "s|__DSH_BIN__|$DSH_BIN|g" -e "s|__HOME__|$HOME|g" \
    "$REPO_DIR/scripts/dsh-web.sh" > "$DSH_DIR/bin/dsh-web.sh"
  chmod +x "$DSH_DIR/bin/dsh-web.sh"
fi

for p in "$REPO_DIR"/launchd/*.plist; do
  base="$(basename "$p")"
  # 方案 A 不需要 dsh-web 服务
  if [ "$MODE" = desktop ] && [ "$base" = "com.deepseek.dsh-web.plist" ]; then
    continue
  fi
  sed -e "s|__HOME__|$HOME|g" -e "s|__NODE__|$NODE_BIN|g" "$p" > "$HOME/Library/LaunchAgents/$base"
done

# launchd 的 bootout 是异步的：紧接着 bootstrap 偶发 "Bootstrap failed: 5"，
# 所以重试几次，并关掉 stderr 噪音。
restart_service() {
  local s="$1"
  local plist="$HOME/Library/LaunchAgents/$1.plist"
  local i
  launchctl bootout "gui/$UID_NUM/$s" 2>/dev/null || true
  # 等旧实例真的退干净（cloudflared 优雅退出可能要好几百毫秒到几秒）
  for i in {1..20}; do
    launchctl print "gui/$UID_NUM/$s" >/dev/null 2>&1 || break
    sleep 0.5
  done
  for i in {1..10}; do
    if launchctl bootstrap "gui/$UID_NUM" "$plist" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  echo "!! $s 启动失败：看 $plist 和 ~/.dsh/logs/"
  return 1
}

for s in com.dsh.auth-proxy com.dsh.cloudflared com.dsh.caffeinate; do
  restart_service "$s"
done
echo "==> 网关 / 隧道 / 防睡眠 已启动"

# --------------------------------------------------------------- 4) DSH 服务
if [ "$MODE" = web ]; then
  launchctl enable "gui/$UID_NUM/com.deepseek.dsh-web" 2>/dev/null || true
  if lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "==> 3080 已被占用：保留你当前的 dsh 进程。"
    echo "    想让 launchd 托管：在终端 Ctrl+C 停掉当前 dsh，然后执行："
    echo "    launchctl bootstrap gui/$UID_NUM ~/Library/LaunchAgents/com.deepseek.dsh-web.plist"
  else
    restart_service com.deepseek.dsh-web
    echo "==> 独立 dsh web 已由 launchd 托管（127.0.0.1:3080）"
  fi
else
  # 方案 A 不托管 dsh-web：停掉并禁用旧服务，避免重启后又拉起一个用不到的实例
  launchctl bootout "gui/$UID_NUM/com.deepseek.dsh-web" 2>/dev/null || true
  launchctl disable "gui/$UID_NUM/com.deepseek.dsh-web" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.deepseek.dsh-web.plist"
  echo "==> 已停用独立的 dsh web 服务（方案 A 用不到；切回 --web 会重新装回来）"
fi

# ------------------------------------------------------------ 5) 自查 + 等网址
echo "==> 检查网关是否可用 ..."
ok=""
for i in {1..15}; do
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:8443/__dsh_login" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
if [ -n "$ok" ]; then
  echo "==> 网关正常（http://127.0.0.1:8443）"
else
  echo "==> 网关没起来，看看 ~/.dsh/logs/auth-proxy.err.log"
fi

echo "==> 等待 Cloudflare 分配临时网址 ..."
url=""
for i in {1..60}; do
  [ -f "$DSH_DIR/remote-url.txt" ] && url="$(cat "$DSH_DIR/remote-url.txt")" && [ -n "$url" ] && break
  sleep 1
done

PW="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).password)' "$DSH_DIR/remote-auth.json")"
echo ""
echo "============================================================"
echo " 安装完成！（方案 $([ "$MODE" = desktop ] && echo 'A · 桌面版本体' || echo 'B · 独立 dsh web')）"
echo ""
if [ -n "$url" ]; then
  echo "   1. Safari 打开:  $url"
else
  echo "   1. Safari 打开 ~/.dsh/remote-url.txt 里的网址（隧道还在分配，稍等片刻）"
fi
echo "   2. 输入访问密码:  $PW"
echo "   3. 分享 → 添加到主屏幕，以后点图标即可"
echo ""
if [ "$MODE" = desktop ]; then
  echo " 注意：桌面版 DeepSeek Harness 必须开着；它重启换了端口会自动重连。"
else
  echo " 注意：独立 dsh web 由 launchd 常驻，关掉终端也不影响。"
fi
echo " 换方案：./install.sh --web  /  ./install.sh --desktop"
echo " 日志: ~/.dsh/logs/   卸载: ./uninstall.sh"
echo "============================================================"
