/**
 * The curated GMI Cloud model table — the single source of truth.
 *
 * `cordis.patch.yml` is generated from this table (npm run gen), the doctor
 * CLI checks exactly these models, and the tests assert the two never drift.
 *
 * Every entry was checked against https://api.gmi-serving.com/v1 for:
 *   - streamed chat completions,
 *   - an OpenAI-style tool call followed by a tool result turn (the loop a
 *     coding agent runs), without echoing reasoning text back,
 *   - each reasoning level it declares, sent in the exact wire shape pi-ai
 *     produces for its `thinkingFormat`,
 *   - a 131072-token output cap (Qwen3.8 Max rejects anything above it).
 *
 * Model ids are pinned to dated snapshots where GMI offers one, so a route
 * keeps answering the same model until this table is deliberately changed.
 *
 * `reasoning` maps a DSH thinking level to the wire value pi-ai sends; a
 * `null` value for `off` means "send the format's own off switch" (or nothing,
 * for the openai format). Levels left out are not offered in the picker.
 */

export const PROVIDER_ID = "gmi";
export const DISPLAY_NAME = "GMI Cloud";
export const BASE_URL = "https://api.gmi-serving.com/v1";
export const API_KEY_ENV = "GMI_API_KEY";
export const DEFAULT_CONTEXT_WINDOW = 262144;
export const DEFAULT_MAX_TOKENS = 65536;

/** @typedef {"deepseek" | "zai" | "qwen" | "openai"} ThinkingFormat */

/**
 * @type {ReadonlyArray<{
 *   id: string, name: string, contextWindow: number, maxTokens: number,
 *   thinkingFormat: ThinkingFormat, sendsEffort: boolean,
 *   reasoning: Record<string, string | null>, note: string
 * }>}
 */
export const MODELS = Object.freeze([
  {
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    name: "DeepSeek V4.1 Flash · GMI",
    contextWindow: 1048575,
    maxTokens: 131072,
    thinkingFormat: "deepseek",
    sendsEffort: true,
    reasoning: { off: null, high: "high", max: "max" },
    note: "Default pick for everyday agent work.",
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Pro-0813",
    name: "DeepSeek V4 Pro 0813 · GMI",
    contextWindow: 1048575,
    maxTokens: 131072,
    thinkingFormat: "deepseek",
    sendsEffort: true,
    reasoning: { off: null, high: "high", max: "max" },
    note: "Dated snapshot of DeepSeek V4 Pro for harder tasks.",
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash · GMI",
    contextWindow: 1048575,
    maxTokens: 131072,
    thinkingFormat: "deepseek",
    sendsEffort: true,
    reasoning: { off: null, high: "high" },
    note: "Lightweight option for quick edits and subagents.",
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "Kimi K2.7 Code · GMI",
    contextWindow: 262144,
    maxTokens: 65536,
    thinkingFormat: "zai",
    sendsEffort: false,
    reasoning: { off: null, high: "high" },
    note: "Coding-tuned Kimi; thinking toggled with thinking.type.",
  },
  {
    id: "zai-org/GLM-5.3",
    name: "GLM-5.3 · GMI",
    contextWindow: 1048576,
    maxTokens: 131072,
    thinkingFormat: "zai",
    sendsEffort: false,
    reasoning: { off: null, high: "high" },
    note: "Thinking toggled with thinking.type.",
  },
  {
    id: "Qwen/Qwen3.8-Max",
    name: "Qwen3.8 Max · GMI",
    contextWindow: 262144,
    maxTokens: 131072,
    thinkingFormat: "qwen",
    sendsEffort: false,
    reasoning: { off: null, high: "high" },
    note: "Thinking toggled with enable_thinking; output capped at 131072.",
  },
  {
    id: "MiniMaxAI/MiniMax-M3",
    name: "MiniMax M3 · GMI",
    contextWindow: 1048576,
    maxTokens: 131072,
    thinkingFormat: "openai",
    sendsEffort: true,
    reasoning: { off: null, high: "high" },
    note: "Reasons only when reasoning_effort is sent.",
  },
]);

/**
 * The request fields pi-ai's openai-completions transport adds for one model
 * at one thinking level. Mirrors @earendil-works/pi-ai's dispatch for the four
 * formats this table uses, so the doctor sends what DSH will send.
 * @param {(typeof MODELS)[number]} model
 * @param {string} level - a key of `model.reasoning`
 * @returns {Record<string, unknown>}
 */
export function reasoningParams(model, level) {
  if (!(level in model.reasoning)) {
    throw new Error(`${model.id} does not offer reasoning level "${level}"`);
  }
  const effort = level === "off" ? undefined : model.reasoning[level];
  switch (model.thinkingFormat) {
    case "deepseek":
      if (!effort) return { thinking: { type: "disabled" } };
      return model.sendsEffort
        ? { thinking: { type: "enabled" }, reasoning_effort: effort }
        : { thinking: { type: "enabled" } };
    case "zai":
      return effort
        ? { thinking: { type: "enabled", clear_thinking: false } }
        : { thinking: { type: "disabled" } };
    case "qwen":
      return { enable_thinking: Boolean(effort) };
    case "openai":
      return effort && model.sendsEffort ? { reasoning_effort: effort } : {};
    default:
      throw new Error(`unknown thinkingFormat ${model.thinkingFormat}`);
  }
}
