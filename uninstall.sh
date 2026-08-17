#!/bin/zsh
# 卸载 dsh-phone-remote：停止并移除四个 launchd 服务。
# 保留 ~/.dsh/remote-auth.json（你的密码）和 ~/.dsh/logs/ 日志。
set -e
UID_NUM="$(id -u)"
for s in com.deepseek.dsh-web com.dsh.auth-proxy com.dsh.cloudflared com.dsh.caffeinate; do
  launchctl bootout "gui/$UID_NUM/$s" 2>/dev/null && echo "stopped $s" || echo "skip $s (not loaded)"
  rm -f "$HOME/Library/LaunchAgents/$s.plist"
done
echo "完成。~/.dsh/bin 下的脚本和 ~/.dsh/remote-auth.json 可按需手动删除。"
