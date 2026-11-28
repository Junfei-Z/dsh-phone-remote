// The doctor against a local mock of GMI's OpenAI-compatible API — no key, no
// network. The mock answers like the real endpoint: SSE chunks with streamed
// tool-call deltas, then an answer that quotes the tool result.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRoute, listModels, parseSse, runDoctor } from "../lib/doctor.mjs";
import { MODELS } from "../lib/models.mjs";

const BIN = fileURLToPath(new URL("../bin/dsh-provider-gmi.mjs", import.meta.url));

function sse(chunks) {
  return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * @param {object} behaviour
 *   key        - accepted bearer token
 *   models     - ids /models returns
 *   ignoreTool - answer without using the tool result
 *   fail       - model id -> HTTP status for chat calls
 */
async function mockGmi(behaviour = {}) {
  const { key = "test-key", models = MODELS.map(m => m.id), ignoreTool = false, fail = {} } = behaviour;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url: req.url, body: json });
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: models.map(id => ({ id, object: "model", context_length: 262144 })) }));
    }
    if (req.url === "/v1/chat/completions") {
      if (fail[json.model]) {
        res.writeHead(fail[json.model], { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Backend request failed" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const toolMsg = json.messages.find(m => m.role === "tool");
      if (!toolMsg) {
        // Turn 1: stream a tool call in two argument fragments, like real servers do.
        return res.end(sse([
          { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "need the file" } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":" } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"package.json\"}" } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]));
      }
      const name = ignoreTool ? "something-else" : JSON.parse(toolMsg.content).name;
      return res.end(sse([
        { choices: [{ index: 0, delta: { content: "The name is " } }] },
        { choices: [{ index: 0, delta: { content: `\`${name}\`.` } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { baseUrl, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("parseSse reassembles streamed tool-call fragments", () => {
  const parsed = parseSse(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read_", arguments: "{\"pa" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: "th\":1}" } }] } }] },
    { choices: [{ delta: { reasoning: "hm" }, finish_reason: "tool_calls" }] },
  ]));
  assert.deepEqual(parsed.calls, [{ id: "a", name: "read_file", arguments: "{\"path\":1}" }]);
  assert.equal(parsed.reasoning, "hm");
  assert.equal(parsed.finish, "tool_calls");
});

test("a full doctor run passes and sends each model's reasoning switch", async t => {
  const gmi = await mockGmi();
  t.after(gmi.close);
  const report = await runDoctor({ baseUrl: gmi.baseUrl, key: "test-key", timeoutMs: 5000 });
  assert.equal(report.ok, true);
  const pairs = MODELS.reduce((n, m) => n + Object.keys(m.reasoning).length, 0);
  assert.equal(report.results.length, pairs);

  const chats = gmi.requests.filter(r => r.url === "/v1/chat/completions").map(r => r.body);
  const flashOff = chats.find(b => b.model === "deepseek-ai/DeepSeek-V4.1-Flash" && b.thinking?.type === "disabled");
  assert.ok(flashOff, "deepseek off sends thinking.type=disabled");
  assert.ok(chats.some(b => b.model === "Qwen/Qwen3.8-Max" && b.enable_thinking === true));
  assert.ok(chats.every(b => b.stream === true && Array.isArray(b.tools)));
  // The second turn carries the assistant tool call and the tool result.
  const second = chats.find(b => b.messages.some(m => m.role === "tool"));
  assert.equal(second.messages.at(-2).tool_calls[0].function.arguments, "{\"path\":\"package.json\"}");
});

test("a model that ignores the tool result fails the check", async t => {
  const gmi = await mockGmi({ ignoreTool: true });
  t.after(gmi.close);
  const r = await checkRoute({ baseUrl: gmi.baseUrl, key: "test-key" }, MODELS[0], "off");
  assert.equal(r.ok, false);
  assert.match(r.detail, /did not use the tool result/u);
});

test("backend errors and missing models are reported, not hidden", async t => {
  const gmi = await mockGmi({
    models: MODELS.slice(1).map(m => m.id),
    fail: { [MODELS[1].id]: 400 },
  });
  t.after(gmi.close);
  const report = await runDoctor({ baseUrl: gmi.baseUrl, key: "test-key" });
  assert.equal(report.ok, false);
  assert.deepEqual(report.catalogue.missing, [MODELS[0].id]);
  const failed = report.results.filter(r => !r.ok);
  assert.ok(failed.length > 0 && failed.every(r => r.model === MODELS[1].id));
  assert.match(failed[0].detail, /HTTP 400/u);
});

test("listModels returns ids and context lengths", async t => {
  const gmi = await mockGmi({ models: ["a/b"] });
  t.after(gmi.close);
  assert.deepEqual(await listModels({ baseUrl: gmi.baseUrl, key: "test-key" }), [
    { id: "a/b", name: "a/b", contextLength: 262144 },
  ]);
});

test("CLI: missing key exits 2 with a hint and no request", async () => {
  const r = await runCli(["doctor"], {});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /GMI_API_KEY is not set/u);
});

test("CLI: rejected key exits 1 and never echoes the key", async t => {
  const gmi = await mockGmi();
  t.after(gmi.close);
  const r = await runCli(["doctor", "--base-url", gmi.baseUrl], { GMI_API_KEY: "wrong-secret-value" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /key was rejected/u);
  assert.doesNotMatch(r.stdout + r.stderr, /wrong-secret-value/u);
});

test("CLI: doctor --model narrows the run; models lists with markers", async t => {
  const gmi = await mockGmi();
  t.after(gmi.close);
  const env = { GMI_API_KEY: "test-key" };
  const one = await runCli(["doctor", "--base-url", gmi.baseUrl, "--model", MODELS[0].id, "--level", "off"], env);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /1\/1 model × reasoning-level checks passed/u);

  const list = await runCli(["models", "--base-url", gmi.baseUrl], env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`★ ${MODELS[0].id.replace(/[.]/gu, "\\.")}`, "u"));

  const bad = await runCli(["doctor", "--base-url", gmi.baseUrl, "--model", "nope/nope"], env);
  assert.equal(bad.code, 2);
});
