# dsh-phone-remote

**English** | [简体中文](README.zh-CN.md)

Use **DeepSeek Harness (DSH)** from your phone — like Claude Code's remote control: send messages, watch the agent work in real time, and approve actions while away from your desk.

- 💰 Zero cost (Cloudflare free quick tunnel)
- 📱 **No app, no VPN** on the phone — iPhone and Android work identically (and it won't fight proxy apps for iPhone's single VPN slot)
- 🖥️ **Two modes**: attach to the running DeepSeek Harness **desktop app** (same instance), or host a **standalone `dsh web`**
- 💻 Host side: **macOS / Linux / Windows**
- 🔒 Built-in password gate (DSH has no login mechanism — exposing it bare would be public remote code execution)
- 🔄 Auto-restart: survives reboots and crashes
- 🧩 Generic: set `auth` to `none` and point `upstream` at any local web app

## Quick start: let your DSH install it for you ⚡

Already running DSH on your computer? Don't even open a terminal — paste this into your DSH chat:

> Help me set up phone remote access. Clone https://github.com/Junfei-Z/dsh-phone-remote locally, read its README, then run `./install.sh --desktop` (I use the desktop app; if it turns out I don't have it, use `--web` instead), and give me the phone URL and access password.

DSH will clone, configure the services, and hand you the **URL and password** — you just open it on your phone. 🤯

(Linux: `./install-linux.sh`. Windows: ask DSH to read `windows/start-dsh-remote.ps1` and run it.)

## What you get

```
phone browser → https://xxx.trycloudflare.com → password once → full DSH GUI
(messages / live output / tool approvals / auto-reconnect / add to home screen)
```

<p align="center">
  <img src="docs/images/iphone-gui.png" width="280" alt="The full DSH console running on an iPhone">
  &nbsp;&nbsp;
  <img src="docs/images/iphone-homescreen.jpg" width="280" alt="DSH icon on the iPhone home screen">
</p>

<p align="center"><i>Left: the full DSH console on an iPhone. Right: added to the home screen, it behaves like an app.</i></p>

## Two modes: which DSH does the phone talk to?

Same tunnel + password gate, two possible upstreams. Pick one at install time; switch any time by re-running the installer.

| | **A · Desktop app** (use this if you have it) | **B · Standalone `dsh web`** |
|---|---|---|
| What the phone sees | The very instance you use on the Mac: same workspace, same sessions, same live state | A separate `dsh web` process (3080) — history is shared, but it is **not** the instance your desktop app has open |
| Requires | `DeepSeek Harness.app` running (its GUI port is random per launch) | launchd/systemd keeps `dsh web` alive; no desktop app needed |
| Needs on the Mac | the desktop app | the `dsh` CLI (falls back to `npm exec`) |
| Port | random — discovered automatically | fixed `127.0.0.1:3080` |
| Best for | taking over the session you are already in | no desktop app, or a clean separate entry for the phone |

```zsh
./install.sh --desktop   # mode A
./install.sh --web       # mode B
./install.sh             # auto: desktop if /Applications/DeepSeek Harness.app exists, else web
```

Switching modes reuses your password and tunnel services; the URL is reassigned.

### How mode A works (why a cookie has to be minted)

Since DSH 0.2 every process mints a random launch token, prints it only inside the startup URL (`?token=...`), and exchanges it for a signed browser cookie. The desktop app's GUI also listens on a **random** loopback port. A tunnel can supply neither.

So the gate reads the persistent `client-connection/browser-session` secret from `~/.dsh/.credentials.yaml`, **mints the same signed cookie DSH would mint** for `127.0.0.1:<current port>`, and injects it on every upstream request. The port is re-confirmed via `ps` + `lsof` before forwarding (8s cache, single-flight probe), so a desktop-app restart on a new port keeps working. **Zero changes to DSH.**

### How mode B works

The gate forwards to the fixed `http://127.0.0.1:3080` and injects the same cookie, which also gets past the launch-token requirement of newer `dsh web` builds; `com.deepseek.dsh-web` (or `dsh-web.service`) keeps that process alive.

### Troubleshooting both modes

| What the phone shows | Cause / fix |
|---|---|
| "can't reach this machine's DSH" | A: the desktop app is not running (or still starting). B: nothing listens on 3080 |
| "DSH rejected this session (401)" | The gate's `credentialsFile` is not the one that process uses (different `DSH_HOME`). Fix it in `~/.dsh/remote-auth.json`, then `launchctl kickstart -k gui/$(id -u)/com.dsh.auth-proxy` |
| Breaks after a desktop-app restart | Refresh once — the port is rediscovered; if it persists, check `~/.dsh/logs/auth-proxy.err.log` |

## Platform support

| Setup | Status |
|---|---|
| Mac → iPhone | ✅ one-command (`install.sh`) |
| Mac → Android | ✅ same script (phone steps are identical) |
| Linux → any phone | ✅ one-command (`install-linux.sh`, systemd user services) |
| Windows → any phone | ⚠️ semi-automatic (`windows/start-dsh-remote.ps1`; PRs welcome) |

**The phone side is identical everywhere**: open the URL in a browser (Safari on iPhone, Chrome on Android), enter the password, add to home screen.

## Why DSH isn't remotely reachable by default — and how this fixes it

`dsh web` serves the GUI on `127.0.0.1:3080` only, and `--host 0.0.0.0` is deliberately refused — the GUI can execute code on your machine yet **has no built-in accounts**. It does ship a "browser-trust fence" (Host/Origin checks against DNS rebinding and CSRF), but that's attack defense, not authentication.

So "phone access" is three independent problems, each with one fix:

```
┌────────────┐   HTTPS   ┌──────────────┐ tunnel(outbound) ┌───────────────────────────────┐
│   phone    │ ────────→ │  Cloudflare  │ ───────────────→ │ your computer (no public IP /  │
│  browser   │           │  edge        │                  │ no router changes needed)      │
└────────────┘           └──────────────┘                  │  ③ dsh-auth-proxy :8443        │
                                                           │   password + injected DSH      │
                                                           │   cookie + rate limit          │
                                                           │   ↓ rewrite Host / Origin      │
                                                           │  ② upstream (pick one)         │
                                                           │   A desktop app (random port)  │
                                                           │   B dsh web :127.0.0.1:3080    │
                                                           │   fence sees a local request   │
                                                           └───────────────────────────────┘
```

1. **Networking** — `cloudflared` builds an encrypted tunnel *outbound* from your computer to Cloudflare. No public IP, no router changes, HTTPS included. Official builds for every platform.
2. **Authentication** — a zero-dependency Node gate (`proxy/dsh-auth-proxy.mjs`) sits between the tunnel and DSH: no password, no entry; a signed 180-day cookie after login; 8 wrong passwords locks the IP for 5 minutes. Cross-platform.
3. **Fence + launch-token compatibility** — the gate rewrites `Host`/`Origin` to a loopback authority so the fence sees a local request, and injects a session cookie minted from `~/.dsh/.credentials.yaml` (the same secret DSH uses), which also satisfies the launch-token requirement of newer builds. **Zero changes to DSH itself.**

Only the auto-start layer is OS-specific: launchd on macOS, systemd on Linux, Task Scheduler/startup folder on Windows.

## Manual install

Prerequisites: **Node.js ≥ 22.18 (or 24)**, plus either the DeepSeek Harness desktop app (mode A) or a working `npm exec @deepseek-ai/dsh web` (mode B).

> ⚠️ The Node version matters: dsh's entry point gates on `import.meta.main`, which only exists in Node 22.18+ / 24. On an older Node, `dsh web` **exits 0 silently** — no error, no output, no listener. `install.sh` probes for a usable node and tells you to upgrade if it finds none.
>
> In mode B the `npx` fallback may pull a different `dsh` version than your desktop app; if session files ever disagree, align them with `npm i -g @deepseek-ai/dsh@<same version>`.

### macOS

```zsh
git clone https://github.com/Junfei-Z/dsh-phone-remote.git
cd dsh-phone-remote
./install.sh --desktop   # mode A: attach to the desktop app
./install.sh --web       # mode B: host a standalone dsh web
./install.sh             # no flag: auto-detect
```

The installer adds cloudflared via Homebrew if missing, wires the launchd services, and prints the phone URL plus password.

### Linux

```bash
git clone https://github.com/Junfei-Z/dsh-phone-remote.git
cd dsh-phone-remote
./install-linux.sh  # cloudflared must be installed first (script prints the link)
```

Uses systemd user services; for start-at-boot without login: `sudo loginctl enable-linger $USER`.

### Windows (semi-automatic)

```powershell
git clone https://github.com/Junfei-Z/dsh-phone-remote.git
cd dsh-phone-remote
powershell -ExecutionPolicy Bypass -File .\windows\start-dsh-remote.ps1
```

Auto-start (either): drop a shortcut to the script into `shell:startup`, or use the `schtasks` command from the Chinese README.

> The Windows path is not machine-tested — issues and PRs welcome.

## Phone side (iPhone / Android identical)

1. Open the printed URL in your browser
2. Enter the access password (once per 180 days)
3. Share/menu → **Add to Home Screen** → tap the icon from now on

## Optional: a stable URL

Quick-tunnel URLs change when the computer restarts (the current one is always in `~/.dsh/remote-url.txt`). For a fixed hostname:

1. Buy any domain and host it on Cloudflare (free plan works)
2. Cloudflare Zero Trust → Networks → Tunnels → create a tunnel, point the Public Hostname at `http://localhost:8443`
3. Optionally add a Cloudflare Access application (email OTP), or keep this repo's password gate
4. Run the tunnel the official persistent way: `cloudflared service install <token>`

## FAQ

**Desktop app or standalone `dsh web`?** If you have the DeepSeek Harness desktop app, use mode A (`--desktop`) so the phone drives the very instance you use on the Mac. Without it (or if you want a headless, always-on entry point), use mode B (`--web`). See the table under "Two modes".

**Is it secure?** The public internet can only reach the password gate; DSH itself stays on 127.0.0.1. Everything is HTTPS. The password lives in `~/.dsh/remote-auth.json` — edit the `password` field to rotate it. The gate only uses the secret in `~/.dsh/.credentials.yaml` in local memory to sign a session cookie; that secret is never sent to the phone. Never expose DSH without authentication (bare `--host 0.0.0.0` or an unauthenticated tunnel).

**Why not Tailscale?** Tailscale is great (private mesh), but an iPhone can only run one VPN tunnel at a time — if you use proxy apps, they conflict. This approach is "just a URL" on the phone: zero conflicts.

**Mac lid closed / asleep?** The macOS package includes a `caffeinate -s` service: no sleep on AC power, automatically inactive on battery.

**Uninstall**: macOS `./uninstall.sh`; Linux `systemctl --user disable --now dsh-auth-proxy dsh-cloudflared dsh-web` and remove `~/.config/systemd/user/dsh-*`.

## Files

| Path | Role |
|---|---|
| `proxy/dsh-auth-proxy.mjs` | password gate (zero-dependency Node): two upstream modes + DSH cookie injection |
| `scripts/dsh-web.sh` | mode B's DSH GUI launcher (waits for port handoff) |
| `scripts/dsh-cloudflared.sh` | tunnel wrapper (records the assigned URL) |
| `launchd/*.plist` | macOS service templates |
| `systemd/*.service` | Linux service templates |
| `windows/start-dsh-remote.ps1` | Windows starter |
| `install.sh` / `install-linux.sh` / `uninstall.sh` | installers |

## License

MIT
