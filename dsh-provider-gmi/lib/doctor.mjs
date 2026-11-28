/**
 * Live checks against GMI Cloud's OpenAI-compatible endpoint, zero-dependency.
 *
 * `checkRoute` runs, per model and reasoning level, the loop a coding agent
 * depends on: a streamed turn that must end in a tool call, then a second
 * streamed turn that receives the tool result and must quote a nonce only the
 * tool result contained. Passing it means the model, the tool-call wire shape,
 * the reasoning switch and streaming all work for DSH on this key.
 */
import crypto from "node:crypto";
import { BASE_URL, MODELS, reasoningParams } from "./models.mjs";

const TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file from the workspace and return its contents.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative path" } },
      required: ["path"],
    },
  },
};

export class GmiHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(cfg, path, init = {}) {
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/u, "")}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${cfg.key}`,
      "content-type": "application/json",
      "user-agent": "dsh-provider-gmi-doctor",
      ...init.headers,
    },
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 90_000),
  });
  if (res.status !== 200) {
    const body = await res.text().catch(() => "");
    let message = body.slice(0, 300);
    try { message = JSON.parse(body).error?.message ?? message; } catch { /* not JSON */ }
    throw new GmiHttpError(res.status, `HTTP ${res.status}: ${message || res.statusText}`);
  }
  return res;
}

/** GET /models → [{ id, contextLength }] */
export async function listModels(cfg) {
  const res = await request(cfg, "/models");
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  return data
    .filter(m => typeof m?.id === "string")
    .map(m => ({ id: m.id, name: m.name ?? m.id, contextLength: m.context_length ?? null }));
}

/** Parse an OpenAI chat-completions SSE body into content, reasoning and tool calls. */
export function parseSse(text) {
  let content = "";
  let reasoning = "";
  let finish = null;
  const calls = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    const think = delta.reasoning_content ?? delta.reasoning;
    if (typeof think === "string") reasoning += think;
    for (const tc of delta.tool_calls ?? []) {
      const slot = (calls[tc.index ?? 0] ??= { id: "", name: "", arguments: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  return { content, reasoning, finish, calls: calls.filter(Boolean) };
}

async function streamTurn(cfg, body) {
  const res = await request(cfg, "/chat/completions", {
    method: "POST",
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
  });
  return parseSse(await res.text());
}

/**
 * One model, one reasoning level: streamed tool call, then streamed answer
 * that must use the tool result.
 */
export async function checkRoute(cfg, model, level) {
  const started = Date.now();
  const nonce = `gmi-${crypto.randomBytes(3).toString("hex")}`;
  const base = {
    model: model.id,
    max_completion_tokens: 4096,
    tools: [TOOL],
    ...reasoningParams(model, level),
  };
  const messages = [
    { role: "system", content: "You are a coding agent. Use the provided tools when the task needs them." },
    { role: "user", content: "What is the \"name\" field in package.json? Read it with read_file, then answer with the value." },
  ];
  try {
    const first = await streamTurn(cfg, { ...base, messages });
    const call = first.calls[0];
    if (!call || call.name !== "read_file") {
      return result(false, `expected a read_file tool call, got ${call ? call.name : `finish=${first.finish}`}`);
    }
    try { JSON.parse(call.arguments || "{}"); } catch {
      return result(false, `tool arguments are not JSON: ${call.arguments.slice(0, 80)}`);
    }
    const second = await streamTurn(cfg, {
      ...base,
      messages: [
        ...messages,
        {
          role: "assistant",
          content: first.content || null,
          tool_calls: first.calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
        },
        ...first.calls.map(c => ({
          role: "tool",
          tool_call_id: c.id,
          content: JSON.stringify({ name: nonce, version: "1.0.0" }),
        })),
      ],
    });
    if (!second.content.includes(nonce)) {
      return result(false, `answer did not use the tool result: ${JSON.stringify(second.content.slice(0, 80))}`);
    }
    return result(true, `tool loop ok${first.reasoning || second.reasoning ? " · reasoning streamed" : ""}`);
  } catch (error) {
    return result(false, describeError(error, cfg));
  }

  function result(ok, detail) {
    return { model: model.id, level, ok, detail, ms: Date.now() - started };
  }
}

export function describeError(error, cfg = {}) {
  if (error instanceof GmiHttpError) {
    if (error.status === 401 || error.status === 403) {
      return `${error.message} — the key was rejected; check ${cfg.keyEnv ?? "GMI_API_KEY"}`;
    }
    return error.message;
  }
  if (error?.name === "TimeoutError") return `timed out after ${cfg.timeoutMs ?? 90_000} ms`;
  const cause = error?.cause?.code ?? error?.cause?.message ?? "";
  let hint = "";
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    hint = " — HTTPS_PROXY is set but Node's fetch ignores it; rerun with NODE_USE_ENV_PROXY=1";
  }
  return `${error?.message ?? error}${cause ? ` (${cause})` : ""}${hint}`;
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Full doctor run: key + catalogue check, then every (model, level) pair.
 * @returns {{ catalogue: object, results: object[], ok: boolean }}
 */
export async function runDoctor(cfg, { models = MODELS, levels, concurrency = 4, onResult } = {}) {
  const visible = await listModels(cfg);
  const ids = new Set(visible.map(m => m.id));
  const missing = models.filter(m => !ids.has(m.id)).map(m => m.id);
  const pairs = models
    .filter(m => ids.has(m.id))
    .flatMap(m => Object.keys(m.reasoning)
      .filter(level => !levels || levels.includes(level))
      .map(level => [m, level]));
  const results = await mapLimit(pairs, concurrency, async ([m, level]) => {
    const r = await checkRoute(cfg, m, level);
    onResult?.(r);
    return r;
  });
  return {
    catalogue: { visible: visible.length, curated: models.length, missing },
    results,
    ok: missing.length === 0 && results.length > 0 && results.every(r => r.ok),
  };
}

export const defaults = Object.freeze({ baseUrl: BASE_URL, timeoutMs: 90_000 });
