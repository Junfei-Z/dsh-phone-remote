#!/bin/zsh
# dsh Web GUI launcher — managed by launchd (com.deepseek.dsh-web.plist).
# Placeholders (__NODE_BIN_DIR__, __DSH_BIN__, __HOME__) are filled by install.sh.
export PATH="__NODE_BIN_DIR__:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "__HOME__" || exit 1
# Handoff-friendly: if another instance still holds 3080 (e.g. a terminal-run
# dsh being replaced), wait for it to release the port first (max ~5 min).
for i in {1..150}; do
  lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 2
done
if [ -x "__DSH_BIN__" ]; then
  exec "__DSH_BIN__" web
fi
# Fallback: resolve through npm exec (downloads on first use).
exec "__NODE_BIN_DIR__/npm" exec @deepseek-ai/dsh web
