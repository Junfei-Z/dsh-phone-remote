#!/usr/bin/env node
// dsh-provider-gmi — check a GMI Cloud key against the models this bundle
// configures for DeepSeek Harness, or list what the key can reach.
import { parseArgs } from "node:util";
import { defaults, describeError, listModels, runDoctor } from "../lib/doctor.mjs";
import { API_KEY_ENV, MODELS } from "../lib/models.mjs";

const HELP = `Usage: dsh-provider-gmi [doctor|models] [options]

Commands:
  doctor   (default) check the key, then run a streamed tool-call loop on every
           model this bundle configures, at every reasoning level it offers
  models   list every model the key can reach; ★ marks the ones configured here

Options:
  --model <id>      check only this model (repeatable)
  --level <level>   check only this reasoning level, e.g. off or high (repeatable)
  --key-env <name>  environment variable holding the key (default ${API_KEY_ENV})
  --base-url <url>  endpoint (default ${defaults.baseUrl}, or $GMI_BASE_URL)
  --timeout <ms>    per-request timeout (default ${defaults.timeoutMs})
  --json            machine-readable output
  -h, --help        show this help

The key is read from the environment only; it is never printed or written.`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string", multiple: true },
      level: { type: "string", multiple: true },
      "key-env": { type: "string", default: API_KEY_ENV },
      "base-url": { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (error) {
  console.error(`${error.message}\n\n${HELP}`);
  process.exit(2);
}

const { values, positionals } = args;
const command = positionals[0] ?? "doctor";
if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (!["doctor", "models"].includes(command)) {
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exit(2);
}

const keyEnv = values["key-env"];
const key = process.env[keyEnv];
if (!key) {
  console.error(`${keyEnv} is not set. Export your GMI Cloud API key first, e.g.\n  export ${keyEnv}=...   # from the GMI Cloud console`);
  process.exit(2);
}

const cfg = {
  key,
  keyEnv,
  baseUrl: values["base-url"] ?? process.env.GMI_BASE_URL ?? defaults.baseUrl,
  timeoutMs: values.timeout ? Number(values.timeout) : defaults.timeoutMs,
};

const out = values.json ? () => {} : (...line) => console.log(...line);
const seconds = ms => `${(ms / 1000).toFixed(1)}s`;

try {
  if (command === "models") {
    const models = await listModels(cfg);
    const curated = new Set(MODELS.map(m => m.id));
    if (values.json) {
      console.log(JSON.stringify(models.map(m => ({ ...m, configured: curated.has(m.id) })), null, 2));
    } else {
      const width = Math.max(...models.map(m => m.id.length), 10);
      for (const m of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
        const ctx = m.contextLength ? `${Math.round(m.contextLength / 1024)}K ctx` : "";
        out(`${curated.has(m.id) ? "★" : " "} ${m.id.padEnd(width)}  ${ctx}`);
      }
      out(`\n${models.length} models reachable with ${keyEnv}; ★ = configured by dsh-provider-gmi.`);
    }
    process.exit(0);
  }

  let models = MODELS;
  if (values.model?.length) {
    models = MODELS.filter(m => values.model.includes(m.id));
    const unknown = values.model.filter(id => !MODELS.some(m => m.id === id));
    if (unknown.length) {
      console.error(`Not configured by this bundle: ${unknown.join(", ")} (see \`dsh-provider-gmi models\`).`);
      process.exit(2);
    }
  }

  out(`GMI Cloud doctor · ${cfg.baseUrl}`);
  const width = Math.max(...models.map(m => m.id.length));
  const report = await runDoctor(cfg, {
    models,
    levels: values.level,
    onResult: r => out(`${r.ok ? "✔" : "✖"} ${r.model.padEnd(width)}  ${r.level.padEnd(4)}  ${seconds(r.ms).padStart(6)}  ${r.detail}`),
  });
  const { catalogue, results } = report;
  const passed = results.filter(r => r.ok).length;
  out("");
  out(`key accepted · ${catalogue.visible} models visible · ${catalogue.curated - catalogue.missing.length}/${catalogue.curated} configured models available`);
  if (catalogue.missing.length) out(`missing for this key: ${catalogue.missing.join(", ")}`);
  out(`${passed}/${results.length} model × reasoning-level checks passed`);
  if (values.json) console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  const message = describeError(error, cfg);
  if (values.json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`✖ ${message}`);
  process.exit(1);
}
