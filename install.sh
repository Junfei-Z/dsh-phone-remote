#!/bin/zsh
# dsh-phone-remote 一键安装（macOS）
# 装好后：iPhone Safari 打开打印出的网址 → 输密码 → 添加到主屏幕。
set -euo pipefail

echo "==> dsh-phone-remote installer"

if [ "$(uname)" != "Darwin" ]; then echo "仅支持 macOS（其他系统请参考 README 手动搭建）"; exit 1; fi
if ! command -v node >/dev/null 2>&1; then echo "需要 Node.js，请先安装：brew install node"; exit 1; fi
if ! command -v cloudflared >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "==> 安装 cloudflared ..."
    brew install cloudflared
  else
    echo "需要 cloudflared。请先安装 Homebrew（https://brew.sh），再执行: brew install cloudflared"; exit 1
  fi
fi

NODE_BIN="$(command -v node)"
NODE_BIN_DIR="$(dirname "$NODE_BIN")"
CLOUDFLARED_BIN="$(command -v cloudflared)"
DSH_BIN="$(command -v dsh 2>/dev/null || true)"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_DIR="$HOME/.dsh"
UID_NUM="$(id -u)"

mkdir -p "$DSH_DIR/bin" "$DSH_DIR/logs"

# 1) 鉴权配置（已存在则保留你的密码）
if [ ! -f "$DSH_DIR/remote-auth.json" ]; then
  node -e '
    const c = require("crypto"), fs = require("fs");
    const cfg = {
      password: [...Array(3)].map(() => c.randomBytes(3).toString("hex").slice(0, 4)).join("-"),
      secret: c.randomBytes(32).toString("hex"),
      listen: "127.0.0.1:8443",
      upstream: "http://127.0.0.1:3080",
      cookieName: "dsh_remote",
      cookieMaxAgeDays: 180
    };
    fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  ' "$DSH_DIR/remote-auth.json"
  echo "==> 已生成访问密码（见结尾）"
else
  echo "==> 复用已有配置 ~/.dsh/remote-auth.json"
fi

# 2) 鉴权代理
cp "$REPO_DIR/proxy/dsh-auth-proxy.mjs" "$DSH_DIR/bin/"

# 3) 启动脚本（替换占位符）
sed -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" -e "s|__DSH_BIN__|$DSH_BIN|g" -e "s|__HOME__|$HOME|g" \
  "$REPO_DIR/scripts/dsh-web.sh" > "$DSH_DIR/bin/dsh-web.sh"
sed -e "s|__CLOUDFLARED__|$CLOUDFLARED_BIN|g" -e "s|__HOME__|$HOME|g" \
  "$REPO_DIR/scripts/dsh-cloudflared.sh" > "$DSH_DIR/bin/dsh-cloudflared.sh"
chmod +x "$DSH_DIR/bin/dsh-web.sh" "$DSH_DIR/bin/dsh-cloudflared.sh"

# 4) launchd 服务
for p in "$REPO_DIR"/launchd/*.plist; do
  base="$(basename "$p")"
  sed -e "s|__HOME__|$HOME|g" -e "s|__NODE__|$NODE_BIN|g" "$p" > "$HOME/Library/LaunchAgents/$base"
done

for s in com.dsh.auth-proxy com.dsh.cloudflared com.dsh.caffeinate; do
  launchctl bootout "gui/$UID_NUM/$s" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/$s.plist"
done
echo "==> 网关 / 隧道 / 防睡眠 已启动"

# 5) DSH GUI 托管：3080 被占用时不动（你可能正在终端里跑着），空闲才接管
if lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "==> 3080 已被占用：保留你当前的 dsh 进程。"
  echo "    想让 launchd 托管：在终端 Ctrl+C 停掉当前 dsh，然后执行："
  echo "    launchctl bootstrap gui/$UID_NUM ~/Library/LaunchAgents/com.deepseek.dsh-web.plist"
else
  launchctl bootout "gui/$UID_NUM/com.deepseek.dsh-web" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$HOME/Library/LaunchAgents/com.deepseek.dsh-web.plist"
  echo "==> DSH GUI 已由 launchd 托管"
fi

# 6) 等隧道 URL
echo "==> 等待 Cloudflare 分配临时网址 ..."
url=""
for i in {1..60}; do
  [ -f "$DSH_DIR/remote-url.txt" ] && url="$(cat "$DSH_DIR/remote-url.txt")" && [ -n "$url" ] && break
  sleep 1
done

PW="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).password)' "$DSH_DIR/remote-auth.json")"
echo ""
echo "============================================================"
echo " 安装完成！iPhone 上这样用："
echo ""
if [ -n "$url" ]; then
  echo "   1. Safari 打开:  $url"
else
  echo "   1. Safari 打开 ~/.dsh/remote-url.txt 里的网址（隧道还在分配，稍等片刻）"
fi
echo "   2. 输入访问密码:  $PW"
echo "   3. 分享 → 添加到主屏幕，以后点图标即可"
echo "============================================================"
echo " 日志: ~/.dsh/logs/   卸载: ./uninstall.sh"
