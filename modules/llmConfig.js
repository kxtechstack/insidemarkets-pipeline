/**
 * llmConfig.js
 * ============
 * SINGLE SOURCE OF TRUTH for which LLM provider/model/key the whole
 * pipeline uses. To switch providers, change ONLY the values below
 * (or the matching .env vars) — never edit llmClient.js, ragChat.js,
 * or anywhere else.
 */

// 27 Nov 2026: Novita retired Llama 3.1 8B (26 Nov). The new model
// (tencent/hy4-flash) "thinks" before answering unless the call says
// "thinking": {"type": "disabled"}; other providers want other settings.
// So the extra settings sent with EVERY AI call come from .env too:
//   LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}
// Missing or empty -> what was always sent: {"reasoning_effort":"low"}.
// Not a JSON object -> the same default, and the problem is logged once.
// It can never change model, messages, temperature or max_tokens.
const DEFAULT_EXTRA_BODY = { reasoning_effort: 'low' };
function readExtraBody(raw) {
  if (raw == null || String(raw).trim() === '') return { body: DEFAULT_EXTRA_BODY, problem: null };
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
    return { body: v, problem: null };
  } catch (e) {
    return { body: DEFAULT_EXTRA_BODY, problem: `LLM_EXTRA_BODY is not a JSON object (${e.message}), so ${JSON.stringify(DEFAULT_EXTRA_BODY)} is sent` };
  }
}
const extra = readExtraBody(process.env.LLM_EXTRA_BODY);

module.exports = {
  apiUrl: process.env.LLM_API_URL || 'https://api.novita.ai/v3/openai/chat/completions',
  apiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL || 'meta-llama/llama-3.1-8b-instruct',
  extraBody: extra.body,
  extraBodyProblem: extra.problem,
  readExtraBody,
  DEFAULT_EXTRA_BODY,
};