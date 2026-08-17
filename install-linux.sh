#!/usr/bin/env bash
# dsh-phone-remote 一键安装（Linux，systemd 用户服务）
set -euo pipefail

echo "==> dsh-phone-remote installer (Linux)"

command -v node >/dev/null 2>&1 || { echo "需要 Node.js（用你的发行版包管理器安装）"; exit 1; }
command -v cloudflared >/dev/null 2>&1 || {
  echo "需要 cloudflared。安装方式见："
  echo "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
}
command -v systemctl >/dev/null 2>&1 || { echo "需要 systemd"; exit 1; }

NODE_BIN="$(command -v node)"
CLOUDFLARED_BIN="$(command -v cloudflared)"
DSH_BIN="$(command -v dsh 2>/dev/null || true)"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_DIR="$HOME/.dsh"

mkdir -p "$DSH_DIR/bin" "$DSH_DIR/logs" "$HOME/.config/systemd/user"

# 1) 鉴权配置（已存在则保留）
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
fi

# 2) 鉴权代理 + 启动脚本
cp "$REPO_DIR/proxy/dsh-auth-proxy.mjs" "$DSH_DIR/bin/"
sed -e "s|__NODE_BIN_DIR__|$(dirname "$NODE_BIN")|g" -e "s|__DSH_BIN__|$DSH_BIN|g" -e "s|__HOME__|$HOME|g" \
  "$REPO_DIR/scripts/dsh-web.sh" > "$DSH_DIR/bin/dsh-web.sh"
sed -e "s|__CLOUDFLARED__|$CLOUDFLARED_BIN|g" -e "s|__HOME__|$HOME|g" \
  "$REPO_DIR/scripts/dsh-cloudflared.sh" > "$DSH_DIR/bin/dsh-cloudflared.sh"
chmod +x "$DSH_DIR/bin/dsh-web.sh" "$DSH_DIR/bin/dsh-cloudflared.sh"

# 3) systemd 用户服务
for u in "$REPO_DIR"/systemd/*.service; do
  sed -e "s|__NODE__|$NODE_BIN|g" "$u" > "$HOME/.config/systemd/user/$(basename "$u")"
done
systemctl --user daemon-reload
systemctl --user enable --now dsh-auth-proxy dsh-cloudflared
echo "==> 网关 / 隧道 已启动"

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "==> 3080 已被占用：保留当前 dsh 进程。想让 systemd 托管："
  echo "    停掉当前 dsh 后执行: systemctl --user enable --now dsh-web"
else
  systemctl --user enable --now dsh-web
  echo "==> DSH GUI 已由 systemd 托管"
fi

echo "==> 如需“未登录也开机自启”，执行一次: sudo loginctl enable-linger $USER"

# 4) 等隧道 URL
echo "==> 等待 Cloudflare 分配临时网址 ..."
url=""
for i in $(seq 1 60); do
  [ -f "$DSH_DIR/remote-url.txt" ] && url="$(cat "$DSH_DIR/remote-url.txt")" && [ -n "$url" ] && break
  sleep 1
done

PW="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).password)' "$DSH_DIR/remote-auth.json")"
echo ""
echo "============================================================"
echo " 安装完成！手机上这样用："
if [ -n "$url" ]; then
  echo "   1. 浏览器打开:  $url"
else
  echo "   1. 浏览器打开 ~/.dsh/remote-url.txt 里的网址（隧道还在分配，稍等）"
fi
echo "   2. 输入访问密码:  $PW"
echo "   3. 添加到主屏幕，以后点图标即可"
echo "============================================================"
