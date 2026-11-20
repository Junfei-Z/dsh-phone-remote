/**
 * dsh-phone-gate — the DSH bundle plugin form of dsh-phone-remote.
 *
 * Runs the password gate (proxy/gate.mjs) inside DSH and, optionally, a
 * Cloudflare quick tunnel pointed at it, so phone access needs no terminal and
 * no system service. Everything is registered through ctx.effect(), so
 * disabling or reconfiguring the plugin tears the listener and the tunnel down.
 *
 * The gate keeps using $DSH_HOME/remote-auth.json for the password and cookie
 * secret, so a machine that was set up with install.sh keeps the same password,
 * and the standalone service and this plugin stay interchangeable.
 *
 * For an entry point that outlives DSH itself — reachable while DSH is
 * restarting or closed — run the standalone service instead (install.sh);
 * a plugin can only live as long as the process that loads it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Schema from "@deepseek-ai/schemastery";
import { createGate, detectDesktopPort, gateDefaults } from "../proxy/gate.mjs";

export const name = "dsh-phone-gate";

export const Config = Schema.object({
  listen: Schema.string().default(gateDefaults.listen)
    .description("网关监听地址，只应是回环地址；隧道指向它。"),
  target: Schema.union(["auto", "desktop", "url"]).default("auto")
    .description("上游：desktop = 正在运行的桌面版本体（随机端口自动发现）；url = 固定地址；auto = 能发现桌面版就用它，否则用 url。"),
  upstream: Schema.string().default(gateDefaults.upstream)
    .description("target 为 url 时的上游地址，通常是 dsh web 的 127.0.0.1:3080。"),
  auth: Schema.union(["dsh-cookie", "none"]).default(gateDefaults.auth)
    .description("dsh-cookie = 现签并注入 DSH 的 browser-session cookie；none = 纯反代，用于非 DSH 的本地应用。"),
  credentialsFile: Schema.string().default("")
    .description("DSH 的 credentials 文件；留空则用 $DSH_HOME/.credentials.yaml。必须与上游进程同一个 DSH_HOME。"),
  password: Schema.string().role("secret").default("")
    .description("访问密码。留空则沿用 $DSH_HOME/remote-auth.json 里的密码，没有就自动生成一个并写进去。"),
  cookieMaxAgeDays: Schema.number().default(gateDefaults.cookieMaxAgeDays)
    .description("手机端登录一次后免密的天数。"),
  tunnel: Schema.object({
    enabled: Schema.boolean().default(true)
      .description("是否自动起一个 Cloudflare 快速隧道。关掉则只监听本机，自己接隧道或走局域网。"),
    bin: Schema.string().default("cloudflared")
      .description("cloudflared 可执行文件，不在 PATH 里就写绝对路径。"),
    forceHttp2: Schema.boolean().default(false)
      .description("网络对 QUIC 不友好（日志反复报 control stream 错误）时打开，强制走 TCP。")
  }).default({}).description("Cloudflare 快速隧道")
}).description("DSH 手机远程访问网关");

/* ------------------------------------------------------------- config file */
function newPassword() {
  return [...Array(3)].map(() => crypto.randomBytes(3).toString("hex").slice(0, 4)).join("-");
}

/**
 * Merge the plugin's config with $DSH_HOME/remote-auth.json and make sure a
 * password and a cookie secret exist on disk. Returns the gate's cfg object.
 */
function resolveConfig(config) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const dshHome = process.env.DSH_HOME || path.join(homeDir, ".dsh");
  const file = process.env.DSH_REMOTE_CONFIG || path.join(dshHome, "remote-auth.json");

  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first run */ }

  const password = config.password || stored.password || newPassword();
  const secret = stored.secret || crypto.randomBytes(32).toString("hex");

  // Persist only what must survive a restart; the rest stays in the profile so
  // the plugin's settings remain the single source of truth for behaviour.
  if (stored.password !== password || stored.secret !== secret) {
    const next = { ...stored, password, secret };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    } catch (error) {
      console.error(`[${name}] cannot write ${file}: ${String(error.message || error)}`);
    }
  }

  return {
    ...gateDefaults,
    listen: config.listen,
    target: config.target === "auto" ? "url" : config.target, // settled in start()
    upstream: config.upstream,
    auth: config.auth,
    credentialsFile: config.credentialsFile || path.join(dshHome, ".credentials.yaml"),
    cookieMaxAgeDays: config.cookieMaxAgeDays,
    password,
    secret,
    dshHome,
    configFile: file
  };
}

/* ----------------------------------------------------------------- tunnel */
const TUNNEL_URL = /https:\/\/[-a-z0-9.]*trycloudflare\.com/u;

/** Spawn a quick tunnel at `listen` and resolve the assigned public URL. */
function startTunnel(options, listen, dshHome) {
  const args = ["tunnel", "--no-autoupdate", "--url", `http://${listen}`];
  if (options.forceHttp2) args.push("--protocol", "http2");

  const child = spawn(options.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let url = "";
  const onChunk = chunk => {
    if (url) return;
    const match = TUNNEL_URL.exec(String(chunk));
    if (!match) return;
    url = match[0];
    try {
      fs.writeFileSync(path.join(dshHome, "remote-url.txt"), url + "\n");
    } catch { /* the URL is still logged below */ }
    console.log(`[${name}] 手机访问地址：${url}`);
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("error", error => {
    console.error(`[${name}] 起不动 ${options.bin}：${String(error.message || error)}`);
    console.error(`[${name}] 装一个 cloudflared，或把 tunnel.enabled 关掉自己接隧道。`);
  });
  child.on("exit", code => {
    if (code !== 0 && code !== null) console.error(`[${name}] cloudflared 退出，code=${code}`);
  });
  return child;
}

/* ------------------------------------------------------------------ plugin */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);

  ctx.effect(() => {
    const state = { gate: null, server: null, tunnel: null, disposed: false };

    (async () => {
      // "auto": prefer the running desktop app, fall back to the fixed upstream.
      if (config.target === "auto") {
        try {
          await detectDesktopPort();
          cfg.target = "desktop";
        } catch {
          cfg.target = "url";
        }
      }
      if (state.disposed) return;

      const gate = createGate(cfg);
      state.gate = gate;
      state.server = gate.server;

      const [host, portStr] = cfg.listen.split(":");
      await new Promise((resolve, reject) => {
        gate.server.once("error", reject);
        gate.server.listen(Number(portStr), host, resolve);
      }).catch(error => {
        state.server = null;
        console.error(`[${name}] 监听 ${cfg.listen} 失败：${String(error.message || error)}`);
        console.error(`[${name}] 端口可能已被 dsh-auth-proxy 服务占用；停掉它，或改 listen 换一个端口。`);
      });
      if (state.disposed || !state.server) return;

      const upstreamLabel = cfg.target === "desktop"
        ? "DeepSeek Harness 桌面版（随机端口自动发现）"
        : cfg.upstream;
      console.log(`[${name}] 网关已启动 http://${cfg.listen} → ${upstreamLabel}` +
        (cfg.auth === "dsh-cookie" ? " [dsh-cookie]" : " [不注入认证]"));
      console.log(`[${name}] 访问密码：${cfg.password}（可在 ${cfg.configFile} 里改）`);

      if (config.tunnel.enabled) {
        state.tunnel = startTunnel(config.tunnel, cfg.listen, cfg.dshHome);
      } else {
        console.log(`[${name}] 隧道已关闭；自己把隧道或反代指向 http://${cfg.listen}。`);
      }
    })().catch(error => {
      console.error(`[${name}] 启动失败：${String(error.message || error)}`);
    });

    return () => {
      state.disposed = true;
      state.tunnel?.kill();
      state.gate?.close();
    };
  });
}
