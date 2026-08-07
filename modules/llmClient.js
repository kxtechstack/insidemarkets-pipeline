/**
 * llmClient.js
 * ==============
 * Single shared entry point for all LLM calls in the pipeline.
 * Currently backed by Groq. If we ever switch providers again,
 * this is the ONLY file that needs to change — every other module
 * just calls callLLM() and doesn't know or care what's behind it.
 *
 * Includes automatic retry on 429 (rate limit) errors, using Groq's
 * retry-after header when available.
 */

const axios = require('axios');

const LLM_API_URL = process.env.LLM_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {Array} messages - standard [{ role, content }, ...] array
 * @param {Object} options
 * @param {number} options.temperature
 * @param {number} options.max_tokens
 * @param {number} options.timeout - ms
 * @param {number} options.maxRetries - retries on 429 specifically (default 4)
 * @returns {Promise<string>} the raw text content of the LLM's reply
 */
const callLLM = async (messages, options = {}) => {
  const {
    temperature = 0.2,
    max_tokens = 1000,
    timeout = 120000,
    maxRetries = 4,
  } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(LLM_API_URL, {
        model: LLM_MODEL,
        messages,
        temperature,
        max_tokens,
      }, {
        timeout,
        headers: {
          'Content-Type': 'application/json',
          ...(LLM_API_KEY ? { 'Authorization': `Bearer ${LLM_API_KEY}` } : {}),
        },
      });

      return response.data.choices[0].message.content.trim();

    } catch (err) {
      const status = err.response?.status;

      if (status === 429 && attempt < maxRetries) {
        const retryAfterHeader = err.response.headers['retry-after'];
        const waitMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : attempt * 5000; // fallback: 5s, 10s, 15s...

        console.log(`  [llmClient] 429 rate limited, retrying in ${waitMs}ms (attempt ${attempt}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }

      throw err;
    }
  }
};

module.exports = { callLLM };