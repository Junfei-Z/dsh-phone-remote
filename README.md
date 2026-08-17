# dsh-phone-remote

让 **DeepSeek Harness（DSH）** 在 iPhone / 安卓 / 任何手机的浏览器里用——像 Claude Code 的 remote control 一样：出门在外也能发消息、看 Agent 实时干活、批准操作。

- 💰 零成本（Cloudflare 免费快速隧道）
- 📱 手机端**不用装任何 App、不用开 VPN**（不占 iPhone 唯一的 VPN 槽位，和小火箭等代理 App 无冲突）
- 🔒 自带密码登录网关（DSH 本身没有登录机制，直接暴露等于把电脑挂公网裸奔）
- 🔄 常驻自启：Mac 重启、进程崩溃都会自动恢复
- 🧩 其实通用：把 upstream 改成任意本地 Web 应用端口，这套方案同样适用

## 效果

```
iPhone Safari → https://xxx.trycloudflare.com → 输一次密码 → 完整的 DSH GUI
（发消息 / 看实时输出 / 批准工具调用 / 断线自动重连）
```

## 原理：为什么 DSH 默认连不上，这套又怎么解决

`dsh web` 启动的 GUI 只监听 `127.0.0.1:3080`，而且 `--host 0.0.0.0` 被官方刻意禁止——因为 GUI 能直接在你电脑上执行代码，而它**没有内置账号体系**。它有一道"浏览器信任围栏"（校验 Host/Origin 头，防 DNS rebinding 和 CSRF），但那是防攻击的，不是登录认证。

所以"手机访问"的本质是三个独立的问题，各用一招解决：

```
┌─────────┐   HTTPS    ┌──────────────┐   隧道(出站)   ┌──────────────────────────────┐
│ iPhone   │ ────────→ │ Cloudflare   │ ────────────→ │ 你的 Mac（无需公网 IP/端口映射）│
│ Safari   │           │ 边缘节点      │               │                              │
└─────────┘           └──────────────┘               │  ③ dsh-auth-proxy :8443      │
                                                      │   密码登录 + Cookie + 限流      │
                                                      │   ↓ 改写 Host / 剥掉 Origin    │
                                                      │  ② dsh web :127.0.0.1:3080    │
                                                      │   围栏看到"本机请求"，原生放行  │
                                                      └──────────────────────────────┘
```

1. **打通网络** —— `cloudflared` 从 Mac **主动向外**建立到 Cloudflare 的加密隧道。不需要公网 IP、不需要碰路由器、天然 HTTPS。
2. **补上登录** —— 一个 200 行、零依赖的 Node 网关（`proxy/dsh-auth-proxy.mjs`）挡在隧道和 DSH 之间：没密码只看到登录页，登录后给 180 天有效的签名 Cookie，密码错误 8 次锁 5 分钟。
3. **过围栏** —— 网关转发时把 `Host` 改写成 `127.0.0.1:3080`、剥掉 `Origin`，DSH 的围栏认为请求来自本机，**DSH 零改动**。

最后 launchd 托管四个服务（GUI、网关、隧道、接电源防睡眠），崩溃/重启自动拉起。

## 快速开始（macOS）

前置：装好 DSH（`npm exec @deepseek-ai/dsh web` 能跑通）、Node.js、Homebrew。

```zsh
git clone https://github.com/Junfei-Z/dsh-phone-remote.git
cd dsh-phone-remote
./install.sh
```

脚本会：安装 cloudflared（若缺）→ 生成随机访问密码 → 部署网关和 launchd 服务 → 启动隧道 → 打印**手机端网址和密码**。

> 如果你的 dsh 正在终端里运行：脚本不会动它。想交给 launchd 托管，在终端 Ctrl+C 后按脚本提示执行一条命令即可。

## 手机端（以 iPhone 为例）

1. Safari 打开安装时打印的网址
2. 输入访问密码（180 天不用再输）
3. 分享 → **添加到主屏幕** → 以后点图标即用

安卓一样用浏览器打开即可。

## 升级为固定网址（可选）

快速隧道的网址在 Mac 重启后会变（新网址永远在 `~/.dsh/remote-url.txt`）。想要固定域名：

1. 买一个域名并托管到 Cloudflare（免费套餐即可，.xyz/.top 首年几块钱）
2. Cloudflare Zero Trust → Networks → Tunnels → 创建 tunnel，把 Public Hostname 指到 `http://localhost:8443`
3. 建议同时加 Access 应用（邮箱验证码登录），或继续用本仓库的密码网关
4. 把 `com.dsh.cloudflared` 服务的启动命令换成 `cloudflared service install <token>` 的官方常驻方式

## FAQ

**安全吗？** 公网只能摸到带密码的网关；DSH 本体只听 127.0.0.1。全程 HTTPS。密码在 `~/.dsh/remote-auth.json`（权限 600），改 `password` 字段即换密码。千万不要把没有鉴权的 DSH 直接 `--host 0.0.0.0` 或用裸隧道暴露。

**和 Tailscale 方案比？** Tailscale 也很棒（私有组网），但 iPhone 同时只能开一个 VPN 隧道——如果你常用代理 App 就会冲突。本方案对手机就是"一个网址"，零冲突。

**Mac 合盖/睡眠？** 安装包带 `caffeinate -s` 服务：接电源时不睡眠，拔电池自动失效，不影响续航。

**卸载** `./uninstall.sh`

## 文件说明

| 路径 | 作用 |
|---|---|
| `proxy/dsh-auth-proxy.mjs` | 密码登录网关（零依赖 Node，通用） |
| `scripts/dsh-web.sh` | DSH GUI 启动器（含端口等待，和平接管） |
| `scripts/dsh-cloudflared.sh` | 隧道包装（自动记录分配的网址） |
| `launchd/*.plist` | 四个常驻服务模板 |
| `install.sh` / `uninstall.sh` | 一键安装 / 卸载 |

## License

MIT
