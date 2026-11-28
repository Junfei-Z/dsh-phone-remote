/**
 * Renders cordis.patch.yml from the model table in ./models.mjs.
 *
 * Hand-rolled YAML on purpose: the output shape is fixed and small, and the
 * package stays zero-dependency. Strings are always JSON-quoted (valid YAML
 * flow scalars), so ids such as "Qwen/Qwen3.8-Max" never need escaping rules.
 */
import {
  API_KEY_ENV,
  BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DISPLAY_NAME,
  MODELS,
  PROVIDER_ID,
} from "./models.mjs";

const q = value => JSON.stringify(value);

export function renderPatch() {
  const lines = [
    "# GMI Cloud provider bundle for DeepSeek Harness.",
    "#",
    "# GENERATED from lib/models.mjs by `npm run gen` — edit that table, not this file.",
    "#",
    "# Configures DSH's stock llm-pi-ai adapter with GMI Cloud's OpenAI-compatible",
    "# Inference Engine. The key stays a credential reference (GMI_API_KEY), so no",
    "# secret is ever written into this file or into your profile.",
    "#",
    "# More GMI models: Settings -> Models -> GMI Cloud -> fetch available models,",
    "# or `npx dsh-provider-gmi models` to list what your key can reach.",
    "",
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    `      ${PROVIDER_ID}:`,
    `        displayName: ${q(DISPLAY_NAME)}`,
    `        apiKeyEnv: ${API_KEY_ENV}`,
    "        api: openai-completions",
    `        baseURL: ${q(BASE_URL)}`,
    `        defaultContextWindow: ${DEFAULT_CONTEXT_WINDOW}`,
    `        defaultMaxTokens: ${DEFAULT_MAX_TOKENS}`,
    "        defaultInput: [text]",
    "        models:",
  ];
  for (const model of MODELS) {
    lines.push(
      `          # ${model.note}`,
      `          - id: ${q(model.id)}`,
      `            name: ${q(model.name)}`,
      `            contextWindow: ${model.contextWindow}`,
      `            maxTokens: ${model.maxTokens}`,
      "            input: [text]",
      "            reasoningEfforts:",
    );
    for (const [level, wire] of Object.entries(model.reasoning)) {
      lines.push(wire === null ? `              ${level}:` : `              ${level}: ${q(wire)}`);
    }
    lines.push(
      "            compat:",
      `              thinkingFormat: ${model.thinkingFormat}`,
      `              supportsReasoningEffort: ${model.sendsEffort}`,
    );
  }
  return lines.join("\n") + "\n";
}
