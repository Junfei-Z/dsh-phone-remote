#!/bin/zsh
# dsh Web GUI launcher — managed by launchd (com.deepseek.dsh-web.plist) for 方案 B.
# Placeholders (__NODE_BIN_DIR__, __DSH_BIN__, __HOME__) are filled by install.sh.
export PATH="__NODE_BIN_DIR__:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "__HOME__" || exit 1
# Handoff-friendly: if another instance still holds 3080 (e.g. a terminal-run
# dsh being replaced), wait for it to release the port first (max ~5 min).
for i in {1..150}; do
  lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 2
done

# 1) 全局/仓库安装的 dsh（install.sh 填进来）
DSH_BIN="__DSH_BIN__"
if [ -n "$DSH_BIN" ] && [ -x "$DSH_BIN" ]; then
  exec "$DSH_BIN" web --no-open
fi

# 2) npx 缓存里的 dsh（(N) = 没有匹配时也不报错）
for candidate in "$HOME"/.npm/_npx/*/node_modules/.bin/dsh(N); do
  if [ -x "$candidate" ]; then
    exec "$candidate" web --no-open
  fi
done

# 3) 最后兜底：npx --yes（首次会下载；--yes 避免卡在“是否安装”的交互提示）
exec "__NODE_BIN_DIR__/npx" --yes @deepseek-ai/dsh web --no-open
