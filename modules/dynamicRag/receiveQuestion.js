/**
 * modules/dynamicRag/receiveQuestion.js
 *
 * STEP 1 of the manager's doc — "User submits question".
 *
 * Job: take the request from the chat screen, make sure it is a proper,
 * allowed request, give it an ID and save it. Nothing more.
 *
 *   1. Basic checks   — question is there, not empty, not too long;
 *                       clientId + userId are there.
 *   2. Access check   — this user belongs to this client, user is active,
 *                       client is active.
 *   3. Conversation   — continue the given chat, or start a new one.
 *   4. Request ID     — a new unique ID for this one question.
 *   5. Save           — store the question EXACTLY as typed.
 *
 * What Step 1 does NOT do: understand the question, search any data,
 * decide if it is in scope, or write an answer. Those are later steps.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { ChatError } = require('./chatError');
const { MAX_QUESTION_CHARS, TITLE_MAX_CHARS } = require('./chatConfig');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres error "invalid input syntax for type uuid": the ID is not even a
// valid ID, so the row cannot exist. We treat it as "not found".
const PG_INVALID_TEXT = '22P02';

// Characters you cannot see: zero-width spaces, control characters.
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF\u0000-\u001F\u007F-\u009F]/g;

// ── 1. Basic checks (no database needed) ─────────────────────────────────
function checkBasics(body) {
  const { question, clientId, userId, conversationId } = body || {};

  if (typeof question !== 'string') {
    throw new ChatError(400, 'MISSING_QUESTION', 'Please type a question.');
  }
  // Invisible characters (they come from copy-paste) do not count as a question.
  if (question.replace(INVISIBLE_CHARS, '').trim().length === 0) {
    throw new ChatError(400, 'EMPTY_QUESTION', 'Please type a question.');
  }
  if (question.length > MAX_QUESTION_CHARS) {
    throw new ChatError(
      400,
      'QUESTION_TOO_LONG',
      `Your question is too long. Please keep it under ${MAX_QUESTION_CHARS} characters.`
    );
  }
  if (!clientId || !userId) {
    throw new ChatError(400, 'MISSING_FIELDS', 'clientId and userId are required.');
  }
  if (conversationId && !UUID_RE.test(String(conversationId))) {
    throw new ChatError(400, 'INVALID_CONVERSATION_ID', 'This chat could not be found.');
  }

  return {
    question,                       // untouched — exactly what the user typed
    clientId: String(clientId),
    userId: String(userId),
    conversationId: conversationId ? String(conversationId) : null,
  };
}

// ── 2. Access check ──────────────────────────────────────────────────────
async function checkAccess(clientId, userId) {
  // Both lookups at the same time — they don't depend on each other.
  const [userRes, clientRes] = await Promise.all([
    supabase
      .schema('admin')
      .from('client_users')
      .select('id, client_id, is_active')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .schema('admin')
      .from('clients')
      .select('id, status')
      .eq('id', clientId)
      .maybeSingle(),
  ]);

  // User
  if (userRes.error && userRes.error.code !== PG_INVALID_TEXT) {
    throw new Error(`user lookup failed: ${userRes.error.message}`);
  }
  const user = userRes.error ? null : userRes.data;
  if (!user) {
    throw new ChatError(403, 'USER_NOT_FOUND', 'Your account could not be found. Please log in again.');
  }
  if (String(user.client_id) !== clientId) {
    throw new ChatError(403, 'USER_NOT_IN_CLIENT', 'You do not have access to this workspace.');
  }
  if (user.is_active === false) {
    throw new ChatError(403, 'USER_INACTIVE', 'Your account is not active. Please contact your admin.');
  }

  // Client
  if (clientRes.error && clientRes.error.code !== PG_INVALID_TEXT) {
    throw new Error(`client lookup failed: ${clientRes.error.message}`);
  }
  const client = clientRes.error ? null : clientRes.data;
  if (!client) {
    throw new ChatError(403, 'CLIENT_NOT_FOUND', 'This workspace could not be found.');
  }
  // Same rule as the rest of server.js: no status = fine, otherwise must be "active".
  if (client.status && String(client.status).toLowerCase() !== 'active') {
    throw new ChatError(403, 'CLIENT_INACTIVE', 'This workspace is not active. Please contact your admin.');
  }
}

// ── 3. Conversation: continue or start ───────────────────────────────────
function makeTitle(question) {
  const t = question.trim().replace(/\s+/g, ' ');
  return t.length > TITLE_MAX_CHARS ? t.slice(0, TITLE_MAX_CHARS - 3) + '...' : t;
}

async function getOrCreateConversation({ conversationId, clientId, userId, question }) {
  if (conversationId) {
    const { data, error } = await supabase
      .from('dr_conversations')
      .select('id, client_id, user_id, deleted_at')
      .eq('id', conversationId)
      .maybeSingle();

    if (error) throw new Error(`conversation lookup failed: ${error.message}`);
    if (!data || data.deleted_at) {
      throw new ChatError(404, 'CONVERSATION_NOT_FOUND', 'This chat could not be found.');
    }
    // A user can only continue their OWN chat in their OWN workspace.
    if (data.client_id !== clientId || data.user_id !== userId) {
      throw new ChatError(403, 'CONVERSATION_NOT_YOURS', 'This chat could not be found.');
    }

    // Move the chat to the top of the list.
    const { error: updErr } = await supabase
      .from('dr_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);
    if (updErr) throw new Error(`conversation update failed: ${updErr.message}`);

    return { id: conversationId, isNew: false };
  }

  const { data, error } = await supabase
    .from('dr_conversations')
    .insert({ client_id: clientId, user_id: userId, title: makeTitle(question) })
    .select('id')
    .single();

  if (error) throw new Error(`conversation create failed: ${error.message}`);
  return { id: data.id, isNew: true };
}

// ── 5. Save the question ─────────────────────────────────────────────────
async function saveUserMessage({ requestId, conversationId, clientId, userId, question }) {
  const { data, error } = await supabase
    .from('dr_messages')
    .insert({
      request_id: requestId,
      conversation_id: conversationId,
      client_id: clientId,
      user_id: userId,
      role: 'user',
      content: question,
    })
    .select('created_at')
    .single();

  if (error) throw new Error(`saving the question failed: ${error.message}`);
  return data.created_at;
}

// ── Step 1 main ──────────────────────────────────────────────────────────
/**
 * @param {object} body  the JSON the chat screen sent
 * @returns the request object that every later step receives:
 *   { request_id, conversation_id, is_new_conversation,
 *     client_id, user_id, original_query, received_at }
 * @throws ChatError for problems the user should be told about
 */
async function receiveQuestion(body) {
  const input = checkBasics(body);

  await checkAccess(input.clientId, input.userId);

  const conversation = await getOrCreateConversation(input);

  const requestId = crypto.randomUUID();

  const receivedAt = await saveUserMessage({
    requestId,
    conversationId: conversation.id,
    clientId: input.clientId,
    userId: input.userId,
    question: input.question,
  });

  return {
    request_id: requestId,
    conversation_id: conversation.id,
    is_new_conversation: conversation.isNew,
    client_id: input.clientId,
    user_id: input.userId,
    original_query: input.question,
    received_at: receivedAt,
  };
}

module.exports = { receiveQuestion };
