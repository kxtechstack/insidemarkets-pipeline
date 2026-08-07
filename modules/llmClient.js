/**
 * llmClient.js
 * ==============
 * Single shared entry point for all LLM calls in the pipeline.
 * Currently backed by Groq. If we ever switch providers again,
 * this is the ONLY file that needs to change — every other module
 * just calls callLLM() and doesn't know or care what's behind it.
 */

const axios = require('axios');

const LLM_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const LLM_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

/**
 * @param {Array} messages - standard [{ role, content }, ...] array
 * @param {Object} options
 * @param {number} options.temperature
 * @param {number} options.max_tokens
 * @param {number} options.timeout - ms
 * @returns {Promise<string>} the raw text content of the LLM's reply
 */
const callLLM = async (messages, options = {}) => {
  const {
    temperature = 0.2,
    max_tokens = 1000,
    timeout = 120000,
  } = options;

  const response = await axios.post(LLM_API_URL, {
    model: LLM_MODEL,
    messages,
    temperature,
    max_tokens,
  }, {
    timeout,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
  });

  return response.data.choices[0].message.content.trim();
};

module.exports = { callLLM };