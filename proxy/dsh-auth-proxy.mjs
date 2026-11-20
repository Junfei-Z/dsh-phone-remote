#!/usr/bin/env node
/**
 * dsh-auth-proxy — standalone cookie-login gate in front of a local DSH Web GUI.
 *
 * This is the service entry point, kept alive by launchd (macOS), systemd
 * (Linux) or Task Scheduler (Windows). It reads a JSON config file and hands it
 * to the shared gate in ./gate.mjs; the DSH bundle plugin (plugin/index.mjs)
 * drives that same gate from inside DSH instead.
 *
 * Listens on 127.0.0.1:8443 (loopback only). The only way in from outside is
 * the cloudflared tunnel pointed here. Without a valid password cookie:
 *   - page loads (GET, non-/api) get a login page;
 *   - everything else (API calls, WebSocket upgrades) gets 401.
 *
 * Two upstream targets (cfg.target):
 *   "url"     — a fixed cfg.upstream, typically `dsh web` on 127.0.0.1:3080.
 *   "desktop" — the running DeepSeek Harness desktop app. Its GUI listens on a
 *               random loopback port that changes on every app launch, so the
 *               port is rediscovered on demand.
 *
 * DSH authentication (cfg.auth):
 *   "dsh-cookie" — DSH >= 0.2 mints a per-process launch token, prints it in
 *                  the startup URL, and only exchanges it for a signed browser
 *                  cookie. A tunnel cannot reproduce that URL, so this gate
 *                  mints the same cookie itself from the persistent secret in
 *                  $DSH_HOME/.credentials.yaml (client-connection/browser-session)
 *                  and injects it on every upstream request. Same DSH_HOME means
 *                  the same secret, so this works for both targets.
 *   "none"       — plain proxy for any other local web app (no DSH cookie).
 *
 * In both targets the forwarded request carries a loopback Host (and a matching
 * Origin) so DSH's browser-trust fence accepts it unchanged: zero DSH patches.
 *
 * Config: $DSH_REMOTE_CONFIG, defaulting to $DSH_HOME/remote-auth.json
 * (password, secret, listen, target, upstream, auth, credentialsFile,
 * cookieName, cookieMaxAgeDays). All fields except password/secret have
 * defaults. Zero dependencies.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGate, gateDefaults } from "./gate.mjs";

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME_DIR, ".dsh");
const CONFIG_PATH = process.env.DSH_REMOTE_CONFIG || path.join(DSH_HOME, "remote-auth.json");
const cfg = {
  ...gateDefaults,
  credentialsFile: path.join(DSH_HOME, ".credentials.yaml"),
  ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
};

const [listenHost, listenPortStr] = cfg.listen.split(":");
const listenPort = Number(listenPortStr);

const { server } = createGate(cfg);

server.listen(listenPort, listenHost, () => {
  console.log("dsh-auth-proxy listening on http://" + cfg.listen +
    " → " + (cfg.target === "desktop" ? "DeepSeek Harness desktop app (auto port)" : cfg.upstream) +
    (cfg.auth === "dsh-cookie" ? " [dsh-cookie]" : " [no auth injection]"));
});
