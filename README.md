# dsh-phone-remote

让 **DeepSeek Harness（DSH）** 在手机上用——像 Claude Code 的 remote control 一样：出门在外也能发消息、看 Agent 实时干活、批准操作。

- 💰 零成本（Cloudflare 免费快速隧道）
- 📱 手机端**不用装 App、不用开 VPN**，iPhone / 安卓完全一样（不占 iPhone 唯一的 VPN 槽位，和代理 App 无冲突）
- 💻 电脑端支持 **macOS / Linux / Windows**
- 🔒 自带密码登录网关（DSH 本身没有登录机制，直接暴露等于把电脑挂公网裸奔）
- 🔄 常驻自启：电脑重启、进程崩溃都会自动恢复
- 🧩 通用：把 upstream 改成任意本地 Web 应用端口，这套方案同样适用

## 快速启动：让你电脑上的 DSH 自己装（最懒的方式）⚡

电脑上已经跑着 DSH？连终端都不用开。直接在 DSH 的对话框（http://127.0.0.1:3080）里发这句话：

> 帮我安装手机远程访问。克隆 https://github.com/Junfei-Z/dsh-phone-remote 到本地，读它的 README，然后按我的系统执行安装脚本（macOS 跑 install.sh，Linux 跑 install-linux.sh），装完把手机端网址和访问密码告诉我。

DSH 会自己克隆、装依赖、配服务，最后把**网址和密码**直接给你——你只管去手机上打开。🤯

（Windows 用户：让 DSH 阅读 `windows/start-dsh-remote.ps1` 并帮你运行。）

## 效果

```
手机浏览器 → https://xxx.trycloudflare.com → 输一次密码 → 完整的 DSH GUI
（发消息 / 看实时输出 / 批准工具调用 / 断线自动重连 / 添加到主屏幕）
```

## 平台支持

| 组合 | 支持情况 |
|---|---|
| Mac → iPhone | ✅ 一键脚本（`install.sh`） |
| Mac → 安卓 | ✅ 同一脚本（手机端操作完全一样） |
| Linux → 任意手机 | ✅ 一键脚本（`install-linux.sh`，systemd 用户服务） |
| Windows → 任意手机 | ⚠️ 半自动（`windows/start-dsh-remote.ps1`，自启动见下文；欢迎 PR） |

**手机端没有区别**：iPhone 和安卓都是"浏览器打开网址 → 输密码 → 添加到主屏幕"，iPhone 用 Safari，安卓用 Chrome/系统浏览器即可。

## 原理：为什么 DSH 默认连不上，这套又怎么解决

`dsh web` 启动的 GUI 只监听 `127.0.0.1:3080`，而且 `--host 0.0.0.0` 被官方刻意禁止——因为 GUI 能直接在你电脑上执行代码，而它**没有内置账号体系**。它有一道"浏览器信任围栏"（校验 Host/Origin 头，防 DNS rebinding 和 CSRF），但那是防攻击的，不是登录认证。

所以"手机访问"的本质是三个独立的问题，各用一招解决：

```
┌─────────┐   HTTPS    ┌──────────────┐  隧道(出站)  ┌──────────────────────────────┐
│ 手机浏览器│ ────────→ │ Cloudflare   │ ───────────→ │ 你的电脑（无需公网 IP/端口映射）│
└─────────┘           │ 边缘节点      │              │                              │
                      └──────────────┘              │  ③ dsh-auth-proxy :8443      │
                                                    │   密码登录 + Cookie + 限流      │
                                                    │   ↓ 改写 Host / 剥掉 Origin    │
                                                    │  ② dsh web :127.0.0.1:3080    │
                                                    │   围栏看到"本机请求"，原生放行  │
                                                    └──────────────────────────────┘
```

1. **打通网络** —— `cloudflared` 从电脑**主动向外**建立到 Cloudflare 的加密隧道。不需要公网 IP、不需要碰路由器、天然 HTTPS。全平台都有官方版本。
2. **补上登录** —— 一个 200 行、零依赖的 Node 网关（`proxy/dsh-auth-proxy.mjs`）挡在隧道和 DSH 之间：没密码只看到登录页，登录后给 180 天有效的签名 Cookie，密码错误 8 次锁 5 分钟。跨平台。
3. **过围栏** —— 网关转发时把 `Host` 改写成 `127.0.0.1:3080`、剥掉 `Origin`，DSH 的围栏认为请求来自本机，**DSH 零改动**。

唯一因系统而异的是"自启动"这层：macOS 用 launchd，Linux 用 systemd，Windows 用任务计划/启动文件夹。

## 手动安装

前置：装好 DSH（`npm exec @deepseek-ai/dsh web` 能跑通）、Node.js。

### macOS

```zsh
git clone https://github.com/Junfei-Z/dsh-phone-remote.git
cd dsh-phone-remote
./install.sh        # 会自动 brew 安装 cloudflared（若缺）
```

### Linux

```bash
git clone https://github.com/Junfei-Z/dsh-phone-remote.git
cd dsh-phone-remote
./install-linux.sh  # cloudflared 需先自行安装（脚本会给出链接）
```

用的是 systemd 用户服务；想要"未登录也开机自启"：`sudo loginctl enable-linger $USER`。

### Windows（半自动）

```powershell
git clone https://github.com/Junfei-Z/dsh-phone-remote.git
cd dsh-phone-remote
powershell -ExecutionPolicy Bypass -File .\windows\start-dsh-remote.ps1
```

开机自启（二选一）：
- 把该脚本的快捷方式放进 `shell:startup` 文件夹；或
- `schtasks /create /tn "DSH-Remote" /sc onlogon /tr "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%USERPROFILE%\.dsh\bin\start-dsh-remote.ps1\""`（先把脚本复制到该路径）

> Windows 路径未实机测试，遇到问题欢迎提 Issue / PR。

## 手机端（iPhone / 安卓相同）

1. 浏览器打开安装时打印的网址
2. 输入访问密码（180 天不用再输）
3. 分享/菜单 → **添加到主屏幕** → 以后点图标即用

## 升级为固定网址（可选）

快速隧道的网址在电脑重启后会变（新网址永远在 `~/.dsh/remote-url.txt`，Windows 在 `%USERPROFILE%\.dsh\remote-url.txt`）。想要固定域名：

1. 买一个域名托管到 Cloudflare（免费套餐即可，.xyz/.top 首年几块钱）
2. Cloudflare Zero Trust → Networks → Tunnels → 创建 tunnel，Public Hostname 指到 `http://localhost:8443`
3. 建议同时加 Access 应用（邮箱验证码登录），或继续用本仓库的密码网关
4. 隧道改用官方常驻方式：`cloudflared service install <token>`

## FAQ

**安全吗？** 公网只能摸到带密码的网关；DSH 本体只听 127.0.0.1。全程 HTTPS。密码在 `~/.dsh/remote-auth.json`，改 `password` 字段即换密码。千万不要把没有鉴权的 DSH 直接 `--host 0.0.0.0` 或用裸隧道暴露。

**和 Tailscale 方案比？** Tailscale 也很棒（私有组网），但 iPhone 同时只能开一个 VPN 隧道——常用代理 App 就会冲突。本方案对手机就是"一个网址"，零冲突。

**Mac 合盖/睡眠？** macOS 安装包带 `caffeinate -s` 服务：接电源时不睡眠，拔电池自动失效。

**卸载**：macOS `./uninstall.sh`；Linux `systemctl --user disable --now dsh-auth-proxy dsh-cloudflared dsh-web` 并删 `~/.config/systemd/user/dsh-*`。

## 文件说明

| 路径 | 作用 |
|---|---|
| `proxy/dsh-auth-proxy.mjs` | 密码登录网关（零依赖 Node，全平台通用） |
| `scripts/dsh-web.sh` | DSH GUI 启动器（含端口等待，和平接管） |
| `scripts/dsh-cloudflared.sh` | 隧道包装（自动记录分配的网址） |
| `launchd/*.plist` | macOS 常驻服务模板 |
| `systemd/*.service` | Linux 常驻服务模板 |
| `windows/start-dsh-remote.ps1` | Windows 启动脚本 |
| `install.sh` / `install-linux.sh` / `uninstall.sh` | 安装与卸载 |

## License

MIT
