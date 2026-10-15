/**
 * mem0Adapter.js
 * =====================
 * Isolated adapter for Mem0. Exposes the same three functions as stateStore.js
 * (loadState, saveState, clearState) so contextResolver and stateUpdater
 * don't know which implementation is being used.
 *
 * On ANY failure, silently falls back to the existing stateStore.js.
 *
 * Uses:
 *   - Novita (OpenAI-compatible) for the LLM — same one the app already uses
 *   - FastEmbed for embeddings — local, no API key
 *   - Qdrant for vector storage — same one the app already uses
 */

const { Memory } = require('mem0ai/oss');
const fallback = require('./stateStore');

let memoryClient = null;
let mem0Available = false;

function initMem0() {
  try {
    memoryClient = new Memory({
      llm: {
        provider: 'openai',
        config: {
          apiKey: process.env.LLM_API_KEY,
          // Novita's baseURL is often the full chat/completions endpoint.
          // Mem0 expects the base path, so we strip the suffix if present.
          baseURL: process.env.LLM_API_URL?.replace(/\/chat\/completions$/, ''),
          model: process.env.LLM_MODEL || 'meta-llama/llama-3.1-8b-instruct',
          temperature: 0.1,
        },
      },
      embedder: {
        provider: 'fastembed',
        config: {
          // This local model produces 384-dimension vectors, which matches
          // the size of your existing Qdrant collections. No API key needed.
          model: 'fast-all-MiniLM-L6-v2',
        },
      },
      vectorStore: {
        provider: 'qdrant',
        config: {
          // Use the same env vars your existing Qdrant client uses.
          url: process.env.QDRANT_URL || 'http://localhost:6333',
          apiKey: process.env.QDRANT_API_KEY || undefined,
          // Use a separate collection so Mem0 data is isolated from your main pipeline.
          collectionName: 'mem0_conversation_memories',
        },
      },
    });
    mem0Available = true;
    console.log('[mem0Adapter] Mem0 initialized successfully');
  } catch (err) {
    console.log(`[mem0Adapter] Mem0 init failed: ${err.message} — falling back to stateStore`);
    mem0Available = false;
  }
}

initMem0();

/**
 * Load state for a conversation. Returns the same object shape as stateStore.
 * The conversationId is used as the "user_id" scope in Mem0.
 */
async function loadState(conversationId) {
  if (!mem0Available) {
    return fallback.loadState(conversationId);
  }

  try {
    const results = await memoryClient.search('', {
      filters: { user_id: conversationId },
      topK: 100,
    });

    if (!results || !results.results) return {};

    const state = {};
    for (const r of results.results) {
      const text = String(r.memory || '');
      const match = text.match(/^([a-z_]+):\s*(.+)$/i);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (state[key]) {
          if (Array.isArray(state[key])) state[key].push(value);
          else state[key] = [state[key], value];
        } else {
          state[key] = value;
        }
      } else {
        if (!state.facts) state.facts = [];
        state.facts.push(text);
      }
    }
    return state;
  } catch (err) {
    console.log(`[mem0Adapter] loadState failed: ${err.message} — falling back`);
    return fallback.loadState(conversationId);
  }
}

/**
 * Save state for a conversation. Mem0 extracts facts from the text you send it.
 */
async function saveState(conversationId, partialState) {
  if (!mem0Available) {
    return fallback.saveState(conversationId, partialState);
  }

  try {
    const lines = Object.entries(partialState || {})
      .filter(([_, v]) => v !== null && v !== undefined)
      .map(([k, v]) => {
        const value = Array.isArray(v) ? v.join(', ') : String(v);
        return `${k}: ${value}`;
      });

    if (lines.length === 0) return fallback.loadState(conversationId);

    const text = lines.join('\n');

    await memoryClient.add(
      [{ role: 'user', content: text }],
      { userId: conversationId }
    );

    return await loadState(conversationId);
  } catch (err) {
    console.log(`[mem0Adapter] saveState failed: ${err.message} — falling back`);
    return fallback.saveState(conversationId, partialState);
  }
}

/**
 * Clear all state for a conversation.
 */
async function clearState(conversationId) {
  try {
    return await fallback.clearState(conversationId);
  } catch (err) {
    console.log(`[mem0Adapter] clearState failed: ${err.message}`);
  }
}

module.exports = { loadState, saveState, clearState };