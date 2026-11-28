# Changelog

## v0.1.0 — 2026-11-28

First release.

- DSH bundle that adds a `gmi` route to the stock `llm-pi-ai` adapter, pointing at GMI Cloud's
  OpenAI-compatible Inference Engine (`https://api.gmi-serving.com/v1`), keyed by the
  `GMI_API_KEY` credential reference.
- Seven models, each checked against the live endpoint for streamed tool calls across a multi-turn
  tool loop and for every reasoning level it offers: DeepSeek V4.1 Flash, DeepSeek V4 Pro 0813,
  DeepSeek V4 Flash, Kimi K2.7 Code, GLM-5.3, Qwen3.8 Max, MiniMax M3.
- Per-model `thinkingFormat` (`deepseek` / `zai` / `qwen` / `openai`), so the DSH reasoning picker
  sends each vendor's own switch; output caps probed per model.
- `dsh-provider-gmi doctor` / `models` CLI (zero dependencies) to re-run the checks with your key.
- 14 offline tests against a mock GMI server; CI on Node 22 and 24; tag-triggered npm publish with
  provenance.
