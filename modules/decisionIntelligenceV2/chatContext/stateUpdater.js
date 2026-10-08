/**
 * modules/decisionIntelligenceV2/chatContext/stateUpdater.js
 *
 * After the pipeline produces an answer, extract new facts about the
 * conversation into the state.
 *
 * One LLM call. No keyword logic.
 *
 * Handles TOPIC SWITCHES — when the user moves from one subject to a
 * completely unrelated one, topic-specific fields are cleared rather
 * than appended to.
 *
 * Public API:
 *   updateState({ conversationId, userMessage, answer, currentState })
 *     → { updatedState, changed_keys }
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../../llmClient');
const { saveState, loadState } = require('./stateStore');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────
const UPDATER_PROMPT = `You maintain the structured state of an ongoing market
intelligence conversation.

You will be given (1) the current state, (2) the latest user message, and
(3) the assistant's answer to that message.

Your job: return a NEW state object that reflects any facts, decisions,
constraints, or questions that were established or changed by this exchange.

Return ONLY this JSON:

{
  "state": { ... new state object ... },
  "changed_keys": ["<key>", "<key>"]
}

=========================
RULES
=========================

1. PRESERVE what is still true.
   If the current state has { "market": "Saudi Arabia" } and the exchange
   doesn't change it, keep it in the new state.

2. ADD new facts.
   If the user's message or the answer establishes a new topic, entity,
   market, product, segment, objective, pricing model, competitor, or
   constraint, add it as a key.

3. UPDATE existing facts.
   If the exchange changes a value (e.g. the user says "actually, in UAE"),
   replace the old value with the new one.

4. DELETE stale facts.
   Set a key to null in the new state object to remove it.
   Only do this when the exchange explicitly abandons that fact.

5. OPEN_QUESTIONS.
   Maintain an "open_questions" array — questions raised in the
   conversation that haven't been resolved yet. Add new ones. Remove
   any that were answered in this exchange.

6. Keep it COMPACT.
   - Use short, clear keys: "market", "product", "topic", "segment",
     "objective", "competitors", "constraints", "entities", "open_questions".
   - Values are strings, arrays of strings, or small objects.
   - Do NOT put long prose summaries in the state.

7. NO CHANGES.
   If the exchange doesn't establish anything new and doesn't change
   anything, return the SAME state and an empty changed_keys array.

=========================
TOPIC SWITCHING
=========================

Before updating the state, decide whether the current exchange is a
CONTINUATION of the existing topic or a SWITCH to a new topic.

CONTINUATION means: the user is refining, extending, or asking a
follow-up about the same subject. Signs:
- Same company, product, market, or industry.
- Same question type (still about pricing, still about revenue, etc.).
- The user says "instead", "also", "what about", "and", "the same", etc.

SWITCH means: the user has moved to a completely unrelated subject. Signs:
- Different companies, industries, or markets.
- Different question type (was pricing, now revenue comparison).
- A completely fresh, unrelated ask.

On a TOPIC SWITCH:
- CLEAR all topic-specific fields: "competitors", "entities",
  "revenue_data", "open_questions", "constraints", "pricing_model",
  "pricing_approach", "segment", and any other field that only made
  sense for the previous topic.
- UPDATE the "topic" field to describe the new topic.
- KEEP cross-cutting fields ONLY if they still clearly apply (e.g. the
  same company, same product, same market mentioned by name in the
  new exchange). Otherwise clear them too.
- Do NOT append new entities to the old entities list. Start fresh.

On a CONTINUATION:
- MERGE as before — add new facts, update changed ones, keep the rest.
- Append new items to arrays (competitors, entities, open_questions)
  rather than overwriting them.

=========================
EXAMPLES
=========================

Example 1 — first business question, empty state
Current state: {}
User: "What is the optimal pricing strategy for our B2B SaaS product in Saudi Arabia?"
Answer: "Value-based pricing is recommended..."
Output: {
  "state": {
    "product": "B2B SaaS",
    "market": "Saudi Arabia",
    "topic": "pricing strategy"
  },
  "changed_keys": ["product", "market", "topic"]
}

Example 2 — continuation, new segment
Current state: {
  "product": "B2B SaaS",
  "market": "Saudi Arabia",
  "topic": "pricing strategy"
}
User: "What if we target SMEs instead?"
Output: {
  "state": {
    "product": "B2B SaaS",
    "market": "Saudi Arabia",
    "topic": "pricing strategy",
    "segment": "SMEs"
  },
  "changed_keys": ["segment"]
}

Example 3 — continuation, market change
Current state: {
  "market": "Saudi Arabia",
  "topic": "digital banking"
}
User: "And in UAE?"
Output: {
  "state": {
    "market": "UAE",
    "topic": "digital banking"
  },
  "changed_keys": ["market"]
}

Example 4 — TOPIC SWITCH, drop prior topic fields
Current state: {
  "product": "B2B SaaS",
  "market": "Saudi Arabia",
  "topic": "pricing strategy",
  "segment": "SMEs",
  "competitors": ["Asaya", "MBK Partners"],
  "open_questions": ["How can we balance growth with acquisition?"]
}
User: "Compare Estée Lauder and Ulta on their recent revenue."
Output: {
  "state": {
    "topic": "revenue comparison",
    "entities": ["Estée Lauder", "Ulta"]
  },
  "changed_keys": ["topic", "entities", "product", "market", "segment", "competitors", "open_questions"]
}
(Note: product, market, segment, competitors, and old open_questions
were all CLEARED because they belonged to the previous topic.)

Example 5 — TOPIC SWITCH after a company-set query
Current state: {
  "topic": "revenue comparison",
  "entities": ["Estée Lauder", "Ulta"],
  "revenue_data": { "Estée Lauder": "$14.33B", "Ulta": "$11.30B" }
}
User: "What's happening in the UAE skincare market?"
Output: {
  "state": {
    "topic": "UAE skincare market overview",
    "market": "UAE"
  },
  "changed_keys": ["topic", "market", "entities", "revenue_data"]
}
(Note: the entities list and revenue_data were CLEARED —
they belonged to the previous topic.)

=========================

Respond with ONLY the JSON object. No markdown fences, no explanation.`;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function stripFences(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
}

function findBalancedJson(s) {
  const first = s.indexOf('{');
  if (first === -1) return null;
  let depth = 0;
  for (let i = first; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return s.slice(first, i + 1);
    }
  }
  return null;
}

function diffState(currentState, newState) {
  const changed = [];
  const allKeys = new Set([
    ...Object.keys(currentState || {}),
    ...Object.keys(newState || {}),
  ]);
  for (const k of allKeys) {
    const a = JSON.stringify(currentState?.[k] ?? null);
    const b = JSON.stringify(newState?.[k] ?? null);
    if (a !== b) changed.push(k);
  }
  return changed;
}

function buildPatch(currentState, newState) {
  const patch = {};
  for (const [k, v] of Object.entries(newState || {})) {
    if (v === null) {
      patch[k] = null;   // explicit delete
    } else {
      patch[k] = v;
    }
  }
  // Delete keys the LLM dropped entirely (present in current, absent in new)
  for (const k of Object.keys(currentState || {})) {
    if (!(k in (newState || {}))) {
      patch[k] = null;
    }
  }
  return patch;
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────
async function updateState({ conversationId, userMessage, answer, currentState }) {
  const safeCurrent = currentState && typeof currentState === 'object' ? currentState : {};

  const stateBlock = Object.keys(safeCurrent).length > 0
    ? JSON.stringify(safeCurrent, null, 2)
    : '{}';

  const userPrompt =
    `CURRENT STATE:\n${stateBlock}\n\n` +
    `USER MESSAGE:\n${userMessage}\n\n` +
    `ASSISTANT ANSWER:\n${answer}`;

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: UPDATER_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0, max_tokens: 900, timeout: 45000 }
    );
  } catch (err) {
    console.log(`[stateUpdater] LLM call failed: ${err.message}`);
    return { updatedState: safeCurrent, changed_keys: [] };
  }

  if (process.env.DI_V2_DEBUG_LLM === '1') {
    console.log('[stateUpdater] RAW LLM OUTPUT:');
    console.log(raw);
    console.log('[stateUpdater] END RAW');
  }

  const stripped = stripFences(raw);
  const jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock) {
    console.log(`[stateUpdater] no JSON found in: ${stripped.slice(0, 200)}`);
    return { updatedState: safeCurrent, changed_keys: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (err) {
    console.log(`[stateUpdater] JSON parse failed: ${err.message}`);
    return { updatedState: safeCurrent, changed_keys: [] };
  }

  if (!parsed || typeof parsed.state !== 'object' || parsed.state === null) {
    console.log(`[stateUpdater] missing state object`);
    return { updatedState: safeCurrent, changed_keys: [] };
  }

  const newState = parsed.state;
  const computedChanged = diffState(safeCurrent, newState);
  const llmChanged = Array.isArray(parsed.changed_keys)
    ? parsed.changed_keys.filter((k) => typeof k === 'string')
    : [];

  const changed_keys = [...new Set([...computedChanged, ...llmChanged])];

  const patch = buildPatch(safeCurrent, newState);

  if (conversationId && Object.keys(patch).length > 0) {
    try {
      await saveState(conversationId, patch);
    } catch (err) {
      console.log(`[stateUpdater] saveState failed: ${err.message}`);
    }
  }

  const merged = conversationId ? await loadState(conversationId) : newState;

  console.log(
    `[stateUpdater] changed_keys=[${changed_keys.join(', ')}] ` +
    `state_keys=[${Object.keys(merged).join(', ')}]`
  );

  return { updatedState: merged, changed_keys };
}

module.exports = {
  updateState,
  UPDATER_PROMPT,
  diffState,
  buildPatch,
};