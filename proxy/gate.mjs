/**
 * gate.mjs — the password gate + DSH cookie injection, as a reusable factory.
 *
 * `createGate(cfg)` builds an http.Server that is not yet listening. All state
 * (secret cache, discovered desktop port, login failures) lives per instance,
 * so a host process may run several gates and dispose of them independently.
 *
 * Two consumers share this module:
 *   - proxy/dsh-auth-proxy.mjs — the standalone service (launchd / systemd /
 *     Task Scheduler), which reads its config from a JSON file.
 *   - plugin/index.mjs — the DSH bundle plugin, which gets config from the
 *     profile and disposes of the gate when the plugin unloads.
 *
 * cfg fields (all required unless noted; the callers fill the defaults):
 *   password            access password for the phone-facing login page
 *   secret              HMAC key for our own session cookie
 *   target              "desktop" (discover the app's random port) | "url"
 *   upstream            used when target === "url", e.g. http://127.0.0.1:3080
 *   auth                "dsh-cookie" (mint and inject) | "none" (plain proxy)
 *   credentialsFile     $DSH_HOME/.credentials.yaml, read when auth is dsh-cookie
 *   cookieName          our cookie's name
 *   cookieMaxAgeDays    our cookie's lifetime
 *   log                 optional { info, error } sink; defaults to console
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { execFile } from "node:child_process";

/* ---------------------------------------------------------------- helpers */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => err ? reject(err) : resolve(String(stdout)));
  });
}
const b64u = value => Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const unb64u = value => Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "origin"]);

/* The desktop host is the Electron main process carrying
 * "dsh-desktop-host/lib/index.js" in its argv; its web GUI listens on a random
 * 127.0.0.1 port per launch. */
const HOST_MARKER = "dsh-desktop-host/lib/index.js";

function clientIp(req) {
  return req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown";
}

/**
 * Find the loopback port the DeepSeek Harness desktop app's web GUI listens on.
 *
 * Resolved through ps + lsof — never pgrep, whose own argv matches the pattern
 * and whose transient child PIDs make lsof fail. Throws when the app is not
 * running or has not opened its listener yet. Needs ps/lsof, so macOS or Linux.
 */
export async function detectDesktopPort() {
  const ps = await run("ps", ["-axo", "pid=,command="]);
  const pids = [];
  for (const line of ps.split("\n")) {
    if (!line.includes(HOST_MARKER)) continue;
    const match = line.trim().match(/^(\d+)\s+(.*)$/u);
    if (!match) continue;
    if (/pgrep|ps -axo|lsof -nP/u.test(match[2])) continue; // never our own probes
    pids.push(match[1]);
  }
  if (pids.length === 0) throw new Error("DeepSeek Harness desktop app is not running");
  for (const pid of pids) {
    let out;
    try {
      out = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid]);
    } catch { continue; } // that PID vanished between ps and lsof
    for (const line of out.split("\n")) {
      const match = line.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/u);
      if (match) return Number(match[1]);
    }
  }
  throw new Error("desktop app has no loopback web listener yet");
}

function readBody(req, cap = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > cap) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function htmlPage(title, detail, extra) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:-apple-system,system-ui,sans-serif;padding:28px;line-height:1.7;max-width:640px">
<h3 style="margin:0 0 12px">${title}</h3>
<p style="color:#555;margin:0 0 10px">${detail}</p>
${extra ? `<p style="color:#555;margin:0">${extra}</p>` : ""}</body>`;
}

/* ------------------------------------------------------------------ factory */
export function createGate(cfg) {
  const log = cfg.log || console;
  const COOKIE = cfg.cookieName;
  const MAX_AGE_S = cfg.cookieMaxAgeDays * 86400;
  const MINT_DSH_COOKIE = cfg.auth === "dsh-cookie";

  /* ----------------------------------------- password cookie (ours) */
  function signPassword(value) {
    return crypto.createHmac("sha256", cfg.secret).update(value).digest("base64url");
  }
  function makePasswordCookie() {
    const expiry = String(Date.now() + MAX_AGE_S * 1000);
    return Buffer.from(expiry).toString("base64url") + "." + signPassword(expiry);
  }
  function validPasswordCookie(req) {
    const header = req.headers.cookie;
    if (!header) return false;
    const match = header.split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE + "="));
    if (!match) return false;
    const token = match.slice(COOKIE.length + 1);
    const dot = token.indexOf(".");
    if (dot <= 0) return false;
    const b64 = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    let expiry;
    try { expiry = Buffer.from(b64, "base64url").toString("utf8"); } catch { return false; }
    if (!/^\d+$/.test(expiry)) return false;
    const expected = Buffer.from(signPassword(expiry));
    const actual = Buffer.from(mac);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
    return Number(expiry) > Date.now();
  }

  /* ------------------------- DSH browser-session secret and cookie */
  let secretCache = { path: "", mtimeMs: 0, value: "" };
  function dshSecret() {
    const file = cfg.credentialsFile;
    const stat = fs.statSync(file);
    if (secretCache.path === file && secretCache.mtimeMs === stat.mtimeMs && secretCache.value) return secretCache.value;
    const text = fs.readFileSync(file, "utf8");
    const block = text.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/u);
    if (!block) throw new Error("client-connection/browser-session secret not found in " + file);
    secretCache = { path: file, mtimeMs: stat.mtimeMs, value: block[1] };
    return block[1];
  }

  /** Mint the cookie DSH itself would have minted for this loopback authority. */
  function mintDshCookie(authority) {
    const secret = unb64u(dshSecret());
    const name = "dsh-auth-" + b64u(crypto.createHash("sha256").update(authority).digest());
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 30 * 86400 * 1000 - 60 * 1000; // inside DSH's 30-day window
    const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), "utf8"));
    const mac = b64u(crypto.createHmac("sha256", secret).update(body).digest());
    return name + "=v1." + body + "." + mac;
  }

  let warnedSecret = false;
  function dshCookieFor(authority) {
    if (!MINT_DSH_COOKIE) return undefined;
    try {
      return mintDshCookie(authority);
    } catch (error) {
      if (!warnedSecret) {
        warnedSecret = true;
        log.error("dsh-phone-gate: cannot mint the DSH session cookie — " + String(error.message || error));
        log.error("dsh-phone-gate: forwarding without it; use auth \"none\" for non-DSH upstreams");
      }
      return undefined;
    }
  }

  /* --------------------------------------- upstream discovery (desktop) */
  /* detectDesktopPort() behind a short cache and a single in-flight probe, so a
   * burst of requests costs one ps + lsof pass and an app restart on a new port
   * is picked up within 8s. */
  let portCache = { value: 0, at: 0 };
  let portProbe = null;
  async function desktopPort() {
    if (portCache.value && Date.now() - portCache.at < 8000) return portCache.value;
    portProbe ??= detectDesktopPort().finally(() => { portProbe = null; });
    try {
      const port = await portProbe;
      portCache = { value: port, at: Date.now() };
      return port;
    } catch (error) {
      // A stale-but-recent port beats a hard failure while the app restarts.
      if (portCache.value && Date.now() - portCache.at < 120000) return portCache.value;
      throw error;
    }
  }
  async function resolveUpstream() {
    if (cfg.target === "desktop") {
      const port = await desktopPort();
      return { host: "127.0.0.1", port, authority: "127.0.0.1:" + String(port) };
    }
    const url = new URL(cfg.upstream);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return { host: url.hostname, port, authority: url.hostname + ":" + String(port) };
  }

  /* ----------------------------------------------- login rate limiting */
  const fails = new Map();
  function throttled(ip) {
    const rec = fails.get(ip);
    if (!rec) return false;
    if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
    if (rec.resetAt < Date.now()) { fails.delete(ip); return false; }
    return false;
  }
  function recordFail(ip) {
    const now = Date.now();
    let rec = fails.get(ip);
    if (!rec || rec.resetAt < now) rec = { count: 0, resetAt: now + 5 * 60 * 1000, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count > 8) rec.lockedUntil = now + 5 * 60 * 1000;
    fails.set(ip, rec);
  }

  /* --------------------------------------------------------- login page */
  function loginPage(error) {
    return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><title>DSH 远程入口</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0f1115;color:#e8eaee;font-family:-apple-system,"PingFang SC",system-ui,sans-serif}
  .card{width:min(88vw,340px);padding:32px 24px;background:#1a1d24;border-radius:16px;
        box-shadow:0 8px 32px rgba(0,0,0,.4)}
  h1{font-size:20px;margin:0 0 8px}p{font-size:14px;color:#9aa0aa;margin:0 0 20px}
  input{width:100%;box-sizing:border-box;padding:14px;font-size:16px;border-radius:10px;
        border:1px solid #333842;background:#0f1115;color:#e8eaee;outline:none}
  input:focus{border-color:#4c8dff}
  button{width:100%;margin-top:14px;padding:14px;font-size:16px;font-weight:600;border:0;
         border-radius:10px;background:#4c8dff;color:#fff}
  .err{color:#ff7a7a;font-size:13px;margin-top:12px;min-height:1em}
</style></head><body><div class="card">
<h1>DSH 远程控制</h1><p>输入访问密码进入你的 Harness。登录后 ${Math.round(MAX_AGE_S / 86400)} 天内不用再输。</p>
<form method="post" action="/__dsh_login">
<input name="password" type="password" autocomplete="current-password" placeholder="访问密码" autofocus required>
<button type="submit">进入</button>
<div class="err">${error ? "密码不对，或尝试次数过多，请稍后再试。" : ""}</div>
</form></div></body></html>`;
  }

  /* ------------------------------------------------------ header rewriting */
  function proxyHeaders(req, upstream) {
    const minted = dshCookieFor(upstream.authority);
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k)) continue;
      if (k === "cookie") {
        // Drop our gate cookie and any stale DSH cookie; the gate mints its own.
        const kept = String(v).split(";").map(s => s.trim())
          .filter(s => s && s.split("=")[0] !== COOKIE && !s.startsWith("dsh-auth-"));
        if (minted !== undefined) kept.push(minted);
        if (kept.length > 0) out.cookie = kept.join("; ");
        continue;
      }
      out[k] = v;
    }
    if (out.cookie === undefined && minted !== undefined) out.cookie = minted;
    // Satisfy the DSH browser-trust fence: loopback Host + matching Origin.
    out.host = upstream.authority;
    if (req.headers.origin !== undefined) out.origin = "http://" + upstream.authority;
    out["x-forwarded-for"] = clientIp(req);
    out["x-forwarded-proto"] = "https";
    return out;
  }

  /* ----------------------------------------------------------- error pages */
  function unreachable(res, detail) {
    if (res.headersSent) { res.end(); return; }
    const hint = cfg.target === "desktop"
      ? "请确认电脑上 DeepSeek Harness 桌面版正在运行，然后刷新本页。"
      : "请确认 " + cfg.upstream + " 正在监听，然后刷新本页。";
    res.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(htmlPage("连不上本机的 DSH", detail, hint));
  }
  function authMismatch(res) {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(htmlPage("DSH 拒绝了这个会话（401）",
      "网关注入的会话 cookie 不被上游接受。最常见的原因是两者用的不是同一个 DSH_HOME（密钥不同）。",
      "检查 <code>" + cfg.credentialsFile + "</code> 是否就是该 DSH 进程的 credentials 文件。"));
  }

  /* ----------------------------------------------------------- HTTP path */
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__dsh_login") {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(loginPage(false));
        return;
      }
      if (req.method === "POST") {
        const ip = clientIp(req);
        if (throttled(ip)) {
          res.writeHead(429, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(loginPage(true));
          return;
        }
        const body = await readBody(req).catch(() => null);
        if (body === null) { res.writeHead(400); res.end(); return; }
        const ok = new URLSearchParams(body.toString("utf8")).get("password") === cfg.password;
        if (!ok) {
          recordFail(ip);
          res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(loginPage(true));
          return;
        }
        res.writeHead(302, {
          "set-cookie": COOKIE + "=" + makePasswordCookie() + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + String(MAX_AGE_S),
          "location": "/",
          "cache-control": "no-store"
        });
        res.end();
        return;
      }
      res.writeHead(405); res.end(); return;
    }

    if (!validPasswordCookie(req)) {
      if (req.method === "GET" && !url.pathname.startsWith("/api")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(loginPage(false));
        return;
      }
      res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "authentication required" }));
      return;
    }

    let upstream;
    try {
      upstream = await resolveUpstream();
    } catch (error) {
      portCache.at = 0;
      unreachable(res, String(error.message || error));
      return;
    }

    const proxyReq = http.request({
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: proxyHeaders(req, upstream),
      timeout: 0,
      // No socket pooling: DSH's 5s keep-alive would otherwise hand us a
      // half-closed socket and surface a spurious 502 under load.
      agent: false
    }, proxyRes => {
      if (proxyRes.statusCode === 401 && String(proxyRes.headers["content-type"] || "").includes("text/plain")) {
        const chunks = [];
        let size = 0;
        proxyRes.on("data", chunk => {
          size += chunk.length;
          if (size <= 4096) chunks.push(chunk);
        });
        proxyRes.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (text.includes("dsh web authentication required")) { authMismatch(res); return; }
          const headers = { ...proxyRes.headers };
          delete headers["transfer-encoding"];
          headers["content-length"] = String(Buffer.byteLength(text));
          res.writeHead(401, headers);
          res.end(text);
        });
        proxyRes.on("error", () => authMismatch(res));
        return;
      }
      const headers = { ...proxyRes.headers };
      if (typeof headers.location === "string") {
        headers.location = headers.location.replace(/^https?:\/\/[^/]+/u, "");
      }
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", () => {
      portCache.at = 0; // the app may have restarted on a new port
      unreachable(res, "上游连接失败（端口可能已变，刷新可自动重试）");
    });
    req.pipe(proxyReq);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("gate error: " + String(error && error.message ? error.message : error));
    });
  });
  server.requestTimeout = 0;   // long-lived RPCs must not be cut
  // Never close an idle client connection on our own: cloudflared keeps sockets
  // alive and a closing race shows up at the edge as "unexpected EOF" (502/530).
  server.keepAliveTimeout = 0;
  server.headersTimeout = 65000;

  /* ---- WebSocket upgrades (the GUI's live event downlinks live under /api) */
  const sockets = new Set();
  server.on("upgrade", async (req, socket, head) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const fail = (code, text) => {
      if (text === undefined) socket.write("HTTP/1.1 " + code + "\r\nConnection: close\r\n\r\n");
      else socket.write("HTTP/1.1 " + code + "\r\ncontent-type: text/plain\r\ncontent-length: " + Buffer.byteLength(text) + "\r\nConnection: close\r\n\r\n" + text);
      socket.destroy();
    };
    if (!validPasswordCookie(req)) { fail("401 Unauthorized"); return; }
    let upstream;
    try {
      upstream = await resolveUpstream();
    } catch {
      portCache.at = 0;
      fail("502 Bad Gateway");
      return;
    }
    const path = req.url;
    const upstreamSock = http.request({
      host: upstream.host, port: upstream.port, method: "GET", path, agent: false,
      headers: { ...proxyHeaders(req, upstream), connection: "Upgrade", upgrade: req.headers.upgrade }
    });
    upstreamSock.on("upgrade", (upRes, upSocket, upHead) => {
      let statusLine = "HTTP/1.1 101 Switching Protocols\r\n";
      for (const [k, v] of Object.entries(upRes.headers)) {
        const vv = Array.isArray(v) ? v : [v];
        for (const one of vv) statusLine += k + ": " + String(one) + "\r\n";
      }
      statusLine += "\r\n";
      socket.write(statusLine);
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
    });
    upstreamSock.on("response", upRes => {
      fail(String(upRes.statusCode));
      upRes.resume();
    });
    upstreamSock.on("error", () => { portCache.at = 0; fail("502 Bad Gateway"); });
    upstreamSock.end();
  });

  /** Stop listening and tear down tunnelled sockets. Safe to call twice. */
  function close() {
    return new Promise(resolve => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, close, resolveUpstream };
}

export const gateDefaults = {
  listen: "127.0.0.1:8443",
  target: "url",
  upstream: "http://127.0.0.1:3080",
  auth: "dsh-cookie",
  cookieName: "dsh_remote",
  cookieMaxAgeDays: 180
};
