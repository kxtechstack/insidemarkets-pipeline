/**
 * llmClient.js
 * ==============
 * Single shared entry point for all LLM calls in the pipeline.
 * Currently backed by Novita. If we ever switch providers again,
 * this is the ONLY file that needs to change — every other module
 * just calls callLLM() and doesn't know or care what's behind it.
 *
 * Includes automatic retry on 429 (rate limit) errors, using Groq's
 * retry-after header when available.
 */

const axios = require('axios');

const LLM_API_URL = process.env.LLM_API_URL || 'https://api.novita.ai/v3/openai/chat/completions';
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
        reasoning_effort: 'low',
      }, {
        timeout,
        headers: {
          'Content-Type': 'application/json',
          ...(LLM_API_KEY ? { 'Authorization': `Bearer ${LLM_API_KEY}` } : {}),
        },
      });

      const content = response.data.choices[0].message.content;
      if (!content || content.trim() === '') {
        console.log(`  [llmClient] WARNING: Empty response. finish_reason=${response.data.choices[0].finish_reason}, full response:`, JSON.stringify(response.data));
      }
      return (content || '').trim();

    } catch (err) {
      const status = err.response?.status;

      if (status === 429 && attempt < maxRetries) {
        const retryAfterHeader = err.response.headers['retry-after'];
        const rawWaitMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : attempt * 5000; // fallback: 5s, 10s, 15s...

        // Cap the wait. Groq sometimes returns retry-after values in the
        // hundreds or thousands of seconds (e.g. 426000ms = 7 minutes).
        // Sleeping that long blocks the pipeline and prevents the circuit
        // breaker from ever firing. If Groq asks for more than 60s, we give
        // up on this attempt -- the article will be marked 'failed' by the
        // caller and picked up again on the next pipeline run (it's not
        // committed to dedup, thanks to the commit-on-success fix).
        const MAX_RETRY_WAIT_MS = 60 * 1000;
        const waitMs = Math.min(rawWaitMs, MAX_RETRY_WAIT_MS);

        if (rawWaitMs > MAX_RETRY_WAIT_MS) {
          console.log(`  [llmClient] 429 rate limited, Groq asked for ${rawWaitMs}ms (${Math.round(rawWaitMs/1000)}s) — capping at ${MAX_RETRY_WAIT_MS}ms (attempt ${attempt}/${maxRetries})`);
        } else {
          console.log(`  [llmClient] 429 rate limited, retrying in ${waitMs}ms (attempt ${attempt}/${maxRetries})`);
        }
        await sleep(waitMs);
        continue;
      }

      // NEW LINE — logs Groq's actual error message instead of just the status code
      console.log(`  [llmClient] Request failed. status=${status}, url=${LLM_API_URL}, model=${LLM_MODEL}, response=`, JSON.stringify(err.response?.data));

      throw err;
    }
  }
};

module.exports = { callLLM };