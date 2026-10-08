/**
 * modules/chatContext/stateStore.js
 *
 * Persistent conversation state for the chat context layer.
 *
 * Storage: Supabase table `di_conversation_state` (jsonb column).
 *
 * Public API:
 *   loadState(conversationId)              → object (empty {} if none)
 *   saveState(conversationId, partialState) → merged object
 *   clearState(conversationId)             → deletes row
 *
 * Merge semantics:
 *   - New keys are added
 *   - Existing keys are overwritten
 *   - A key set to `null` is deleted from the state
 *
 * No LLM. No keyword logic. Pure storage.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const TABLE = 'di_conversation_state';

/**
 * Fetch the current state for a conversation.
 * @param {string} conversationId
 * @returns {Promise<object>} state object (never null — empty {} if none)
 */
async function loadState(conversationId) {
  if (!conversationId) return {};

  const { data, error } = await supabase
    .from(TABLE)
    .select('state')
    .eq('conversation_id', conversationId)
    .maybeSingle();

  if (error) {
    console.log(`[chatContext.stateStore] loadState error: ${error.message}`);
    return {};
  }

  if (!data || !data.state) return {};
  return data.state;
}

/**
 * Merge the provided partial state into the stored state and persist.
 * A key whose value is `null` is deleted.
 *
 * @param {string} conversationId
 * @param {object} partialState
 * @returns {Promise<object>} the full merged state that was written
 */
async function saveState(conversationId, partialState) {
  if (!conversationId) throw new Error('saveState: conversationId required');
  if (!partialState || typeof partialState !== 'object') {
    throw new Error('saveState: partialState must be an object');
  }

  const current = await loadState(conversationId);

  const merged = { ...current };
  for (const [key, value] of Object.entries(partialState)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from(TABLE)
    .upsert(
      {
        conversation_id: conversationId,
        state: merged,
        updated_at: nowIso,
      },
      { onConflict: 'conversation_id' }
    );

  if (error) {
    console.log(`[chatContext.stateStore] saveState error: ${error.message}`);
    throw new Error(`saveState failed: ${error.message}`);
  }

  return merged;
}

/**
 * Delete the state row for a conversation. Used mostly for testing.
 * @param {string} conversationId
 */
async function clearState(conversationId) {
  if (!conversationId) return;

  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('conversation_id', conversationId);

  if (error) {
    console.log(`[chatContext.stateStore] clearState error: ${error.message}`);
  }
}

module.exports = { loadState, saveState, clearState };