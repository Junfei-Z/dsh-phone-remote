#!/usr/bin/env node
/**
 * dsh-auth-proxy — cookie-login gate in front of the local DSH Web GUI.
 *
 * Listens on 127.0.0.1:8443 (loopback only). The only way in from outside is
 * the cloudflared tunnel pointed here. Without a valid auth cookie:
 *   - page loads (GET, non-/api) get a login page;
 *   - everything else (API calls, WebSocket upgrades) gets 401.
 * With a valid cookie, requests proxy to the DSH web server with Host
 * rewritten to 127.0.0.1:3080 and Origin stripped, which satisfies DSH's
 * loopback browser-trust fence without any DSH-side changes.
 *
 * Config: $DSH_REMOTE_CONFIG, defaulting to ~/.dsh/remote-auth.json
 * (password, secret, listen, upstream, cookieName, cookieMaxAgeDays).
 * All fields except password/secret have defaults. Zero dependencies.
 *
 * Not DSH-specific: point "upstream" at any loopback-only web app to put it
 * behind a password on a Cloudflare tunnel.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || ".";
const CONFIG_PATH = process.env.DSH_REMOTE_CONFIG || HOME_DIR + "/.dsh/remote-auth.json";
const cfg = {
  listen: "127.0.0.1:8443",
  upstream: "http://127.0.0.1:3080",
  cookieName: "dsh_remote",
  cookieMaxAgeDays: 180,
  ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
};
const [listenHost, listenPortStr] = cfg.listen.split(":");
const listenPort = Number(listenPortStr);
const upstream = new URL(cfg.upstream);
const upstreamHost = upstream.hostname;
const upstreamPort = Number(upstream.port);
const COOKIE = cfg.cookieName;
const MAX_AGE_S = cfg.cookieMaxAgeDays * 86400;

/* ---- signed auth cookie: base64url(expiryMs).base64url(hmac) ---- */
function sign(value) {
  return crypto.createHmac("sha256", cfg.secret).update(value).digest("base64url");
}
function makeCookie() {
  const expiry = String(Date.now() + MAX_AGE_S * 1000);
  return Buffer.from(expiry).toString("base64url") + "." + sign(expiry);
}
function validCookie(req) {
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
  const expected = Buffer.from(sign(expiry));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return false;
  return Number(expiry) > Date.now();
}

/* ---- naive per-IP login rate limit ---- */
const fails = new Map(); // ip -> { count, resetAt, lockedUntil }
function clientIp(req) {
  return req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown";
}
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

/* ---- login page (iPhone-friendly) ---- */
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
<h1>DSH 远程控制</h1><p>输入访问密码进入你的 Harness。登录后 180 天内不用再输。</p>
<form method="post" action="/__dsh_login">
<input name="password" type="password" autocomplete="current-password" placeholder="访问密码" autofocus required>
<button type="submit">进入</button>
<div class="err">${error ? "密码不对，或尝试次数过多，请稍后再试。" : ""}</div>
</form></div></body></html>`;
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

/* ---- upstream proxying ---- */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "origin"]);
function proxyHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    out[k] = v;
  }
  // Satisfy the DSH loopback browser-trust fence: loopback Host, no Origin.
  out["host"] = upstreamHost + ":" + String(upstreamPort);
  out["x-forwarded-for"] = clientIp(req);
  return out;
}

function handle(req, res) {
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
      readBody(req).then(body => {
        const params = new URLSearchParams(body.toString("utf8"));
        const ok = params.get("password") === cfg.password;
        if (!ok) {
          recordFail(ip);
          res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(loginPage(true));
          return;
        }
        res.writeHead(302, {
          "set-cookie": COOKIE + "=" + makeCookie() + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + String(MAX_AGE_S),
          "location": "/",
          "cache-control": "no-store"
        });
        res.end();
      }).catch(() => { res.writeHead(400); res.end(); });
      return;
    }
    res.writeHead(405); res.end(); return;
  }

  if (!validCookie(req)) {
    if (req.method === "GET" && !url.pathname.startsWith("/api")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(loginPage(false));
      return;
    }
    res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "authentication required" }));
    return;
  }

  const proxyReq = http.request({
    host: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers: proxyHeaders(req),
    timeout: 0
  }, proxyRes => {
    const headers = { ...proxyRes.headers };
    if (typeof headers.location === "string") {
      headers.location = headers.location.replace(/^https?:\/\/[^/]+/, "");
    }
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("DSH backend unreachable");
  });
  req.pipe(proxyReq);
}

const server = http.createServer(handle);
server.requestTimeout = 0;   // long-lived RPCs must not be cut
server.headersTimeout = 60000;

/* ---- WebSocket upgrades (the GUI's live event downlinks live under /api) ---- */
server.on("upgrade", (req, socket, head) => {
  const fail = code => { socket.write("HTTP/1.1 " + code + " \r\nConnection: close\r\n\r\n"); socket.destroy(); };
  if (!validCookie(req)) { fail("401 Unauthorized"); return; }
  const headers = proxyHeaders(req);
  const path = req.url;
  const upstreamSock = http.request({
    host: upstreamHost, port: upstreamPort, method: "GET", path, headers: { ...headers, connection: "Upgrade", upgrade: req.headers.upgrade }
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
    // Upstream refused the upgrade (e.g. fence 403) — relay the status.
    fail(String(upRes.statusCode));
    upRes.resume();
  });
  upstreamSock.on("error", () => fail("502 Bad Gateway"));
  upstreamSock.end();
});

server.listen(listenPort, listenHost, () => {
  console.log("dsh-auth-proxy listening on http://" + cfg.listen + " → " + cfg.upstream);
});
