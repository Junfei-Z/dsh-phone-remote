# 更新日志

## v2.1.0 — 2026-11-20

**可以当 DSH 插件装了，为上架插件市场做好打包。**

### 新增

- **DSH bundle 插件形态**：`dsh plugin --profile web add dsh-phone-gate` 一条命令装好，
  设置页里直接配置，不用开终端、不用装系统服务。npm 包名 `dsh-phone-gate`
  （`dsh-phone-remote` 在 npm 上已被他人占用）。
  - `package.json` 声明 `dsh.bundle.patch` + `engines.dsh`，`cordis.patch.yml` 贡献一行插件配置。
  - `plugin/index.mjs`：Schemastery 设置项（上游、认证、密码、隧道），全部注册在 `ctx.effect()` 上，
    禁用或改配置时网关和隧道一起干净收掉。
  - `target: "auto"`：能发现桌面版本体就连它，否则回落到固定 `upstream`。
  - 插件会自动起 Cloudflare 快速隧道并打印手机网址，也写进 `~/.dsh/remote-url.txt`。
  - 密码和 cookie 密钥仍然读写 `~/.dsh/remote-auth.json`，所以**插件和常驻服务共用同一个密码**，
    两种装法可以互换。
  - **零构建**：纯 ESM，不需要 `prepare` 脚本，所以 `github:` 直装也不用 pnpm 的 `allowBuilds` 授权。
- `test/gate.test.mjs`：网关端到端测试（`npm test`，20 项，不需要装 DSH）。覆盖登录门、
  伪造/过期 cookie、限流、Host/Origin 改写、WebSocket 升级、上游失联，以及用独立实现的 HMAC
  交叉验证现签出来的 DSH cookie。
- README（中英）新增「插件装还是常驻服务装」对照表。

### 变更

- 网关逻辑抽到 `proxy/gate.mjs`，导出 `createGate()` / `detectDesktopPort()`；
  原来的状态（密钥缓存、端口缓存、失败计数）从模块级变成每个实例独立，一个进程里可以跑多个网关。
  `proxy/dsh-auth-proxy.mjs` 变成读配置文件的瘦入口，**常驻服务的行为和日志完全不变**，
  现有 launchd / systemd / 计划任务安装无需改动。
- `createGate().close()` 会销毁已升级的 WebSocket 连接再关监听，插件卸载时不留悬挂连接。

### 说明

- DSH 0.2.2 起官方声明 `node >=24.9.0`；网关自身只需要 Node 22.18，README 已注明。
- `engines.dsh` 写成 `>=0.2.0-0` 而不是 `>=0.2.0`：DSH 当前只发预发布版（如 `0.2.2-rc.5`），
  按 semver 规则 `>=0.2.0` 匹配不到带 `-rc` 的版本，会把用户挡在安装之外。

## v2.0.0 — 2026-11-06

**两种方案 + 适配 DSH 0.2 的 cookie 认证。**

### 新增

- **方案 A：桌面版本体**（`./install.sh --desktop`）
  手机连的就是电脑上正在用的那个 DeepSeek Harness 实例——同一工作区、同一批会话、同一份实时状态。
  桌面版 GUI 监听随机端口，网关用 `ps` + `lsof` 自动发现（8 秒缓存、单飞探测、失败回退旧端口）。
- **方案 B：独立 `dsh web`**（`./install.sh --web`）：原来的做法，由 launchd / systemd 常驻。
- `./install.sh` 不带参数时自动判断：有 `/Applications/DeepSeek Harness.app` 走 A，否则走 B。
- 网关配置新增字段：`target`（`desktop` / `url`）、`auth`（`dsh-cookie` / `none`）、`credentialsFile`。
- 401 诊断页：上游拒绝 cookie 时直接告诉你是 `credentialsFile` / `DSH_HOME` 不匹配，而不是白屏或死循环。

### 修复

- **DSH 0.2 的 launch token**：新版 `dsh web` / 桌面版每个进程随机生成 token，只印在启动 URL 里，
  经隧道访问必然 401。网关照 `~/.dsh/.credentials.yaml` 里持久化的
  `client-connection/browser-session` 密钥，为上游 loopback 地址现场签同名 cookie 注入，
  **DSH 本体零改动**。
- **偶发 502**：关闭上游 socket 复用（DSH 5 秒 keep-alive 的半关闭连接会被误判成故障）。
- **并发 502**：端口发现从 `pgrep` 改成 `ps` + 逐 PID `lsof`（`pgrep` 会匹配到自己，导致取到已退出的 PID）。
- **隧道侧 `unexpected EOF`**：网关不再主动关闭空闲客户端连接（`keepAliveTimeout = 0`），
  避免 cloudflared 复用连接时撞上半关闭 socket。
- **Node 版本**：dsh 的入口用 `import.meta.main`（Node 22.18+ / 24），旧 Node 会**静默退出 0**
  （不报错、不监听 3080）。安装脚本现在自动挑一个能用的 node，找不到会明确提示升级；
  `dsh-web.sh` 优先直接执行 npx 缓存里的 dsh（带 `--no-open`），最后才用 `npx --yes` 兜底，
  避免卡在 npm 的"是否安装"交互提示上。
- **launchd 重启竞态**：`bootout` 是异步的，紧接着 `bootstrap` 会偶发 `Bootstrap failed: 5`；
  现在会等旧实例真正退出并重试。
- `ps | grep -q` 在 `pipefail` 下会被 SIGPIPE 误判（桌面版明明在跑却提示没运行），已改为先取变量再匹配。
- 旧版 `install.sh` 重跑会覆盖网关脚本、把方案 A 的配置冲掉的问题（现在配置是合并写入，密码保留）。

### 变更

- `com.deepseek.dsh-web` 在方案 A 下会被停用并移除 plist（`--web` 会重新装回来）。
- `uninstall.sh` 会恢复 `dsh-web` 的 launchd 状态。
- README（中英）新增「两种方案」对比、原理和故障对照表。

## 之前

- v1.x — 仅支持独立 `dsh web`（3080）+ 密码网关 + Cloudflare 快速隧道。
