/**
 * chatContext/discreteStateStore.js
 *
 * Discrete-facts implementation of the state store. Same public API as
 * stateStore.js (loadState, saveState, clearState), but stores facts as
 * rows in `di_conversation_memories` instead of one JSON blob.
 *
 * External callers (contextResolver.js, stateUpdater.js, route.js) do NOT
 * need to know which implementation is active — this module returns the
 * same shape `stateStore.js` does: a plain object whose keys are fact
 * types and whose values are strings or arrays of strings.
 *
 * Examples:
 *   loadState(convId)
 *     → { topic: "SWOT analysis", entities: ["Apple"] }
 *
 *   saveState(convId, { topic: "SWOT analysis", entities: ["Apple"] })
 *     → writes two fact rows:
 *         (type=topic, value="SWOT analysis")
 *         (type=company, value="Apple")
 *
 * The state shape stays compatible with what the resolver prompt already
 * expects, so no prompt changes are needed.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const TABLE = 'di_conversation_memories';

// Map internal state keys → fact_type values stored in the DB.
// The resolver prompt talks in terms of "topic", "entities", "market",
// "metric", "timeframe". We translate those to typed fact rows.
//
// Note: `entities` is a special case — it's an array. Each item becomes
// its own row with fact_type = 'company' (or 'entity' if we can't tell).
const KEY_TO_TYPE = {
  topic:       'topic',
  market:      'market',
  metric:      'metric',
  timeframe:   'timeframe',
  segment:     'segment',
  product:     'product',
  objective:   'objective',
};

// The reverse — which state keys should appear when we load.
const TYPE_TO_KEY = {
  topic:       'topic',
  market:      'market',
  metric:      'metric',
  timeframe:   'timeframe',
  segment:     'segment',
  product:     'product',
  objective:   'objective',
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function isArrayKey(key) {
  return key === 'entities' || key === 'competitors';
}

function arrayItemType(key) {
  if (key === 'entities') return 'company';
  if (key === 'competitors') return 'competitor';
  return 'entity';
}

function arrayItemKey(factType) {
  if (factType === 'company' || factType === 'entity') return 'entities';
  if (factType === 'competitor') return 'competitors';
  return factType;
}

// ─────────────────────────────────────────────────────────────────────────
// loadState — returns an object shaped like the old JSON blob
// ─────────────────────────────────────────────────────────────────────────
async function loadState(conversationId) {
  if (!conversationId) return {};

  const { data, error } = await supabase
    .from(TABLE)
    .select('fact_type, fact_value')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) {
    console.log(`[discreteStateStore] loadState error: ${error.message}`);
    return {};
  }

  const out = {};
  for (const row of data || []) {
    const { fact_type, fact_value } = row;

    // Array-type facts accumulate into arrays
    if (fact_type === 'company' || fact_type === 'entity' || fact_type === 'competitor') {
      const key = arrayItemKey(fact_type);
      if (!Array.isArray(out[key])) out[key] = [];
      if (!out[key].includes(fact_value)) out[key].push(fact_value);
      continue;
    }

    // Scalar facts go under their mapped key
    const key = TYPE_TO_KEY[fact_type] || fact_type;
    // If a key appears twice with different values (shouldn't happen because
    // of the unique constraint, but just in case), keep the latest.
    out[key] = fact_value;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// saveState — merges the new facts into the existing rows
//
// Merge semantics (matches old stateStore.js):
//   - new scalar keys overwrite existing rows of that type
//   - arrays are additive
//   - a key set to null deletes all rows of that type
// ─────────────────────────────────────────────────────────────────────────
async function saveState(conversationId, partialState) {
  if (!conversationId) throw new Error('saveState: conversationId required');
  if (!partialState || typeof partialState !== 'object') {
    throw new Error('saveState: partialState must be an object');
  }

  // Handle deletions first
  const deleteTypes = new Set();
  for (const [key, value] of Object.entries(partialState)) {
    if (value === null) {
      if (isArrayKey(key)) {
        deleteTypes.add(arrayItemType(key));
      } else {
        deleteTypes.add(KEY_TO_TYPE[key] || key);
      }
    }
  }

  if (deleteTypes.size > 0) {
    for (const factType of deleteTypes) {
      const { error } = await supabase
        .from(TABLE)
        .delete()
        .eq('conversation_id', conversationId)
        .eq('fact_type', factType);
      if (error) {
        console.log(`[discreteStateStore] delete ${factType} error: ${error.message}`);
      }
    }
  }

  // Build the rows to insert
  const rowsToInsert = [];

  for (const [key, value] of Object.entries(partialState)) {
    if (value === null) continue; // handled above

    if (isArrayKey(key)) {
      const arr = Array.isArray(value) ? value : [value];
      const factType = arrayItemType(key);
      for (const item of arr) {
        const v = String(item || '').trim();
        if (!v) continue;
        rowsToInsert.push({
          conversation_id: conversationId,
          fact_type: factType,
          fact_value: v,
        });
      }
      continue;
    }

    // Scalar — before inserting, delete any prior scalar of the same type
    // so we don't accumulate multiple values for a single-valued field.
    const factType = KEY_TO_TYPE[key] || key;
    const v = String(value || '').trim();
    if (!v) continue;

    const { error: delErr } = await supabase
      .from(TABLE)
      .delete()
      .eq('conversation_id', conversationId)
      .eq('fact_type', factType);
    if (delErr) {
      console.log(`[discreteStateStore] scalar delete ${factType} error: ${delErr.message}`);
    }

    rowsToInsert.push({
      conversation_id: conversationId,
      fact_type: factType,
      fact_value: v,
    });
  }

  if (rowsToInsert.length > 0) {
    const { error } = await supabase
      .from(TABLE)
      .upsert(rowsToInsert, {
        onConflict: 'conversation_id,fact_type,fact_value',
        ignoreDuplicates: true,
      });
    if (error) {
      console.log(`[discreteStateStore] insert error: ${error.message}`);
      throw new Error(`saveState failed: ${error.message}`);
    }
  }

  // Return the full merged state — same contract as old stateStore
  return await loadState(conversationId);
}

// ─────────────────────────────────────────────────────────────────────────
// clearState — delete all facts for a conversation
// ─────────────────────────────────────────────────────────────────────────
async function clearState(conversationId) {
  if (!conversationId) return;

  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('conversation_id', conversationId);

  if (error) {
    console.log(`[discreteStateStore] clearState error: ${error.message}`);
  }
}

module.exports = { loadState, saveState, clearState };