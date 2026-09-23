/**
 * llmConfig.js
 * ============
 * SINGLE SOURCE OF TRUTH for which LLM provider/model/key the whole
 * pipeline uses. To switch providers, change ONLY the values below
 * (or the matching .env vars) — never edit llmClient.js, ragChat.js,
 * or anywhere else.
 */
module.exports = {
  apiUrl: process.env.LLM_API_URL || 'https://api.novita.ai/v3/openai/chat/completions',
  apiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL || 'meta-llama/llama-3.1-8b-instruct',
};