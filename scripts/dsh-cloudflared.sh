#!/bin/zsh
# cloudflared quick-tunnel wrapper — managed by launchd (com.dsh.cloudflared.plist).
# Placeholders (__CLOUDFLARED__, __HOME__) are filled by install.sh.
LOG=__HOME__/.dsh/logs/cloudflared.log
URL_FILE=__HOME__/.dsh/remote-url.txt
: > "$LOG"
rm -f "$URL_FILE"
# URL extractor: poll the log for the assigned trycloudflare URL, write it, exit.
(
  for i in {1..90}; do
    url=$(grep -o 'https://[-a-z0-9.]*trycloudflare\.com' "$LOG" 2>/dev/null | head -1)
    if [ -n "$url" ]; then echo "$url" > "$URL_FILE"; echo "$(date -u +%FT%TZ) tunnel URL: $url" >> "$LOG"; exit 0; fi
    sleep 1
  done
) &
exec __CLOUDFLARED__ tunnel --no-autoupdate --url http://127.0.0.1:8443 >> "$LOG" 2>&1
