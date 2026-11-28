// The generated bundle patch: in sync with the table, and every model entry
// valid by the rules DSH's llm-pi-ai adapter enforces when it loads a route.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { renderPatch } from "../lib/patch.mjs";
import { MODELS, reasoningParams } from "../lib/models.mjs";

const patchFile = new URL("../cordis.patch.yml", import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("committed cordis.patch.yml matches lib/models.mjs", () => {
  assert.equal(fs.readFileSync(patchFile, "utf8"), renderPatch());
});

test("package.json points DSH at the bundle patch and ships it", () => {
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.ok(pkg.files.includes("cordis.patch.yml"));
  assert.ok(pkg.keywords.includes("dsh-plugin"), "the plugin market indexes the dsh-plugin keyword");
  // npm 11 silently drops a bin whose path starts with "./" at publish time.
  for (const [name, target] of Object.entries(pkg.bin)) {
    assert.doesNotMatch(target, /^\.\//u, `bin ${name} must not start with ./`);
    assert.ok(fs.existsSync(new URL(`../${target}`, import.meta.url)), `bin ${name} points at a missing file`);
  }
  // DSH ships prereleases (0.2.2-rc.5); a plain >=0.2.0 would refuse them.
  assert.match(pkg.engines.dsh, /-0$/u);
});

test("the patch never carries a secret, only the credential reference", () => {
  const text = fs.readFileSync(patchFile, "utf8");
  assert.match(text, /apiKeyEnv: GMI_API_KEY/u);
  assert.doesNotMatch(text, /apiKey:|Bearer|sk-|eyJ/u);
});

test("model ids are unique and capacities are sane", () => {
  const ids = MODELS.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of MODELS) {
    assert.ok(Number.isInteger(m.contextWindow) && m.contextWindow > 0, m.id);
    assert.ok(Number.isInteger(m.maxTokens) && m.maxTokens > 0, m.id);
    assert.ok(m.maxTokens <= 131072, `${m.id}: GMI caps some models at 131072 output tokens`);
    assert.ok(m.maxTokens < m.contextWindow, m.id);
  }
});

// Mirrors resolveModelReasoning() in @deepseek-ai/dsh-llm-pi-ai: only "off"
// may be valueless, values must be non-empty, and at least one level beyond
// "off" must exist — otherwise DSH refuses the whole route at load time.
test("reasoningEfforts follow llm-pi-ai's validation rules", () => {
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  for (const m of MODELS) {
    const entries = Object.entries(m.reasoning);
    assert.ok(entries.some(([level]) => level !== "off"), `${m.id} offers no level beyond off`);
    for (const [level, wire] of entries) {
      assert.ok(levels.has(level), `${m.id}: unknown level ${level}`);
      if (wire === null) assert.equal(level, "off", `${m.id}: only off may be valueless`);
      else assert.ok(typeof wire === "string" && wire.length > 0, `${m.id}.${level}`);
    }
    assert.ok(["deepseek", "zai", "qwen", "openai"].includes(m.thinkingFormat), m.id);
  }
});

test("reasoningParams produces the wire shape each format expects", () => {
  const byFormat = f => MODELS.find(m => m.thinkingFormat === f);
  assert.deepEqual(reasoningParams(byFormat("deepseek"), "off"), { thinking: { type: "disabled" } });
  assert.deepEqual(reasoningParams(byFormat("deepseek"), "high"), { thinking: { type: "enabled" }, reasoning_effort: "high" });
  assert.deepEqual(reasoningParams(byFormat("zai"), "off"), { thinking: { type: "disabled" } });
  assert.deepEqual(reasoningParams(byFormat("zai"), "high"), { thinking: { type: "enabled", clear_thinking: false } });
  assert.deepEqual(reasoningParams(byFormat("qwen"), "off"), { enable_thinking: false });
  assert.deepEqual(reasoningParams(byFormat("qwen"), "high"), { enable_thinking: true });
  assert.deepEqual(reasoningParams(byFormat("openai"), "off"), {});
  assert.deepEqual(reasoningParams(byFormat("openai"), "high"), { reasoning_effort: "high" });
  assert.throws(() => reasoningParams(byFormat("qwen"), "max"), /does not offer/u);
});
