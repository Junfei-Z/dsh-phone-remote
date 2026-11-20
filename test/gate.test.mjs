import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createGate, gateDefaults } from "../proxy/gate.mjs";

const PASSWORD = "aaaa-bbbb-cccc";
let pass = 0, fail = 0;
const check = (label, fn) => { try { fn(); console.log("  ok  " + label); pass++; } catch (e) { console.log("  FAIL " + label + " :: " + e.message); fail++; } };

/* ---------------- fake upstream: echoes what it received ---------------- */
const seen = [];
const upstream = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: { ...req.headers } });
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("UPSTREAM OK");
});
upstream.on("upgrade", (req, socket) => {
  seen.push({ url: req.url, headers: { ...req.headers }, upgrade: true });
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  socket.write("HELLO-WS");
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
const upPort = upstream.address().port;

/* ------------------------------- helpers ------------------------------- */
function req(port, { method = "GET", pathname = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
function upgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/stream",
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "x", "sec-websocket-version": "13", ...headers } });
    r.on("upgrade", (res, socket, head) => { socket.destroy(); resolve({ status: 101, head: head.toString() }); });
    r.on("response", res => { res.resume(); resolve({ status: res.statusCode }); });
    r.on("error", reject);
    r.end();
  });
}
async function startGate(overrides = {}) {
  const cfg = { ...gateDefaults, password: PASSWORD, secret: "test-secret",
    upstream: `http://127.0.0.1:${upPort}`, credentialsFile: "/nonexistent", ...overrides };
  const gate = createGate(cfg);
  await new Promise(r => gate.server.listen(0, "127.0.0.1", r));
  return { gate, port: gate.server.address().port };
}

/* =================== 1. auth: none — the gate itself =================== */
console.log("\n[1] password gate (auth: none)");
{
  const { gate, port } = await startGate({ auth: "none" });

  const anon = await req(port, { pathname: "/" });
  check("GET / without cookie -> login page", () => {
    assert.equal(anon.status, 200);
    assert.ok(anon.body.includes("DSH 远程控制"), "expected login page");
  });

  const anonApi = await req(port, { pathname: "/api/sessions" });
  check("GET /api without cookie -> 401 json", () => {
    assert.equal(anonApi.status, 401);
    assert.equal(JSON.parse(anonApi.body).error, "authentication required");
  });

  const wsAnon = await upgrade(port);
  check("WS upgrade without cookie -> 401", () => assert.equal(wsAnon.status, 401));

  const bad = await req(port, { method: "POST", pathname: "/__dsh_login",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=wrong" });
  check("wrong password -> 401", () => assert.equal(bad.status, 401));

  const good = await req(port, { method: "POST", pathname: "/__dsh_login",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: `password=${PASSWORD}` });
  const setCookie = String(good.headers["set-cookie"] || "");
  check("right password -> 302 + Secure HttpOnly cookie", () => {
    assert.equal(good.status, 302);
    assert.equal(good.headers.location, "/");
    assert.ok(setCookie.startsWith("dsh_remote="), "cookie name");
    assert.ok(setCookie.includes("HttpOnly") && setCookie.includes("Secure") && setCookie.includes("SameSite=Lax"), setCookie);
  });
  const cookie = setCookie.split(";")[0];

  seen.length = 0;
  const proxied = await req(port, { pathname: "/some/page", headers: { cookie, origin: "https://x.trycloudflare.com" } });
  check("with cookie -> proxied to upstream", () => {
    assert.equal(proxied.status, 200);
    assert.equal(proxied.body, "UPSTREAM OK");
  });
  check("fence: Host + Origin rewritten to loopback authority", () => {
    assert.equal(seen[0].headers.host, `127.0.0.1:${upPort}`);
    assert.equal(seen[0].headers.origin, `http://127.0.0.1:${upPort}`);
  });
  check("gate cookie is stripped before forwarding", () => {
    assert.ok(!String(seen[0].headers.cookie || "").includes("dsh_remote="), seen[0].headers.cookie);
  });
  check("auth none -> no dsh-auth cookie injected", () => {
    assert.ok(!String(seen[0].headers.cookie || "").includes("dsh-auth-"), seen[0].headers.cookie);
  });
  check("x-forwarded-proto is https", () => assert.equal(seen[0].headers["x-forwarded-proto"], "https"));

  const wsOk = await upgrade(port, { cookie });
  check("WS upgrade with cookie -> 101 and payload flows", () => {
    assert.equal(wsOk.status, 101);
    assert.ok(wsOk.head.includes("HELLO-WS"), JSON.stringify(wsOk.head));
  });

  // forged cookie must not pass
  const forged = await req(port, { pathname: "/api/x", headers: { cookie: "dsh_remote=" + Buffer.from(String(Date.now() + 1e6)).toString("base64url") + ".deadbeef" } });
  check("forged cookie signature -> 401", () => assert.equal(forged.status, 401));

  // expired but correctly signed cookie must not pass
  const past = String(Date.now() - 1000);
  const mac = crypto.createHmac("sha256", "test-secret").update(past).digest("base64url");
  const expired = await req(port, { pathname: "/api/x", headers: { cookie: "dsh_remote=" + Buffer.from(past).toString("base64url") + "." + mac } });
  check("expired cookie -> 401", () => assert.equal(expired.status, 401));

  // rate limit: 8 failures allowed, the 9th locks the IP
  for (let i = 0; i < 8; i++) {
    await req(port, { method: "POST", pathname: "/__dsh_login", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=nope" });
  }
  const locked = await req(port, { method: "POST", pathname: "/__dsh_login",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: `password=${PASSWORD}` });
  check("9 wrong attempts -> 429 even for the right password", () => assert.equal(locked.status, 429));

  await gate.close();
  check("close() stops the listener", () => assert.equal(gate.server.listening, false));
}

/* ============ 2. auth: dsh-cookie — minting from credentials ============ */
console.log("\n[2] DSH cookie minting (auth: dsh-cookie)");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
  const credFile = path.join(dir, ".credentials.yaml");
  const browserSecret = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(credFile, [
    "some-other-entry:",
    "  secret: ZZZZ",
    "client-connection/browser-session:",
    "  kind: hmac",
    `  secret: ${browserSecret}`,
    ""
  ].join("\n"));

  const { gate, port } = await startGate({ auth: "dsh-cookie", credentialsFile: credFile });
  const good = await req(port, { method: "POST", pathname: "/__dsh_login",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: `password=${PASSWORD}` });
  const cookie = String(good.headers["set-cookie"]).split(";")[0];

  seen.length = 0;
  await req(port, { pathname: "/api/sessions", headers: { cookie } });
  const fwd = String(seen[0].headers.cookie || "");
  const authority = `127.0.0.1:${upPort}`;

  check("a dsh-auth-<hash> cookie is injected", () => assert.ok(/dsh-auth-[A-Za-z0-9_-]+=v1\./u.test(fwd), fwd));

  const b64u = v => Buffer.from(v).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  check("cookie name is keyed to the upstream authority", () => {
    const expected = "dsh-auth-" + b64u(crypto.createHash("sha256").update(authority).digest());
    assert.ok(fwd.includes(expected + "=v1."), `want ${expected}\ngot  ${fwd}`);
  });
  check("payload authority matches, MAC verifies against the file secret", () => {
    const token = fwd.split("dsh-auth-")[1].split("=v1.")[1];
    const [bodyPart, macPart] = token.split(".");
    const raw = Buffer.from(bodyPart.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
    const payload = JSON.parse(raw);
    assert.equal(payload.authority, authority);
    assert.equal(payload.version, 1);
    assert.ok(payload.expiresAt > Date.now(), "not expired");
    assert.ok(payload.expiresAt - payload.issuedAt <= 30 * 86400 * 1000, "within DSH's 30-day window");
    const key = Buffer.from(browserSecret.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    assert.equal(b64u(crypto.createHmac("sha256", key).update(bodyPart).digest()), macPart);
  });
  seen.length = 0;
  await req(port, { pathname: "/api/x", headers: { cookie: `${cookie}; dsh-auth-stale=old; theme=dark` } });
  const fwd2 = String(seen[0].headers.cookie || "");
  check("stale dsh-auth-* dropped, unrelated cookies preserved", () => {
    assert.ok(!fwd2.includes("dsh-auth-stale"), fwd2);
    assert.ok(fwd2.includes("theme=dark"), fwd2);
  });

  await gate.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================ 3. unreachable upstream -> 502 page ================= */
console.log("\n[3] upstream down");
{
  const { gate, port } = await startGate({ auth: "none", upstream: "http://127.0.0.1:1" });
  const good = await req(port, { method: "POST", pathname: "/__dsh_login",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: `password=${PASSWORD}` });
  const cookie = String(good.headers["set-cookie"]).split(";")[0];
  const down = await req(port, { pathname: "/", headers: { cookie } });
  check("dead upstream -> 502 with a readable page", () => {
    assert.equal(down.status, 502);
    assert.ok(down.body.includes("连不上本机的 DSH"), down.body.slice(0, 200));
  });
  await gate.close();
}

upstream.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
