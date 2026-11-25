/**
 * modules/dynamicRag/chatHistory.js
 *
 * The addresses around the chat that the dashboard's DI tab uses:
 *
 *   GET    /dynamic-rag/conversations          the person's chats, newest first
 *          -> { conversations: [{ id, title, updated_at }] }
 *   GET    /dynamic-rag/conversations/:id      one chat, every question and answer
 *          -> { conversation: { id, title, updated_at },
 *               messages: [{ id, role ('user' | 'assistant'), content, created_at, payload }] }
 *   DELETE /dynamic-rag/conversations/:id      hide a chat (deleted_at is set; never removed
 *          -> { ok: true }                       for good, so nothing is lost by mistake)
 *   GET    /dynamic-rag/suggested-questions?surface=home|library
 *          -> { questions: [{ id, category, title, question, description, icon_name }] }
 *
 * Who is asking comes from the login token (chatAccess.js), never from the
 * screen. A person only ever sees, opens or deletes their OWN chats in
 * their OWN workspace; anything else is "This chat could not be found."
 * (the same words, so nobody can tell if another person's chat exists).
 *
 * Suggested questions are rows of public.dr_suggested_questions (nothing
 * written in the code): is_active, the surface (home / library), for one
 * client (client_id) or for every client (client_id empty), in sort_order.
 */

const { createClient } = require('@supabase/supabase-js');
const { ChatError } = require('./chatError');
const { whoIsAsking } = require('./chatAccess');
const { HISTORY_MAX_CHATS, HISTORY_MAX_MESSAGES } = require('./chatConfig');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = () => new ChatError(404, 'CONVERSATION_NOT_FOUND', 'This chat could not be found.');

// ── The tables (tests give a fake store) ─────────────────────────────────
let supabase = null;
function realStore() {
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const must = (res, what) => { if (res.error) throw new Error(`${what} failed: ${res.error.message}`); return res.data; };
  return {
    async conversations(clientId, userId, limit) {
      return must(await supabase.from('dr_conversations').select('id, title, updated_at')
        .eq('client_id', clientId).eq('user_id', userId).is('deleted_at', null)
        .order('updated_at', { ascending: false }).limit(limit), 'chat list') || [];
    },
    async conversation(id) {
      return must(await supabase.from('dr_conversations').select('id, client_id, user_id, title, updated_at, deleted_at')
        .eq('id', id).maybeSingle(), 'chat lookup');
    },
    async messages(conversationId, limit) {
      return must(await supabase.from('dr_messages').select('id, role, content, created_at, payload')
        .eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(limit), 'messages') || [];
    },
    async hide(id) {
      must(await supabase.from('dr_conversations').update({ deleted_at: new Date().toISOString() }).eq('id', id), 'delete');
    },
    async suggested(clientId, surface) {
      return must(await supabase.from('dr_suggested_questions')
        .select('id, client_id, category, title, question, description, icon_name, sort_order')
        .eq('is_active', true).eq('surface', surface)
        .or(`client_id.is.null,client_id.eq.${clientId}`)
        .order('sort_order', { ascending: true }), 'suggested questions') || [];
    },
  };
}
let store = null;
/** Tests: a fake store; null = the real tables. */
function useHistoryStore(s) { store = s; }
const db = () => store || realStore();

// ── The jobs (no web part: easy to test) ─────────────────────────────────
async function ownChat(who, id) {
  if (!who.clientId || !who.userId) throw new ChatError(400, 'MISSING_FIELDS', 'clientId and userId are required.');
  if (!UUID_RE.test(String(id || ''))) throw NOT_FOUND();
  const c = await db().conversation(String(id));
  if (!c || c.deleted_at || String(c.client_id) !== who.clientId || String(c.user_id) !== who.userId) throw NOT_FOUND();
  return c;
}

async function listChats(who) {
  if (!who.clientId || !who.userId) throw new ChatError(400, 'MISSING_FIELDS', 'clientId and userId are required.');
  const rows = await db().conversations(who.clientId, who.userId, HISTORY_MAX_CHATS);
  return { conversations: rows.map((c) => ({ id: c.id, title: c.title || '', updated_at: c.updated_at })) };
}

async function openChat(who, id) {
  const c = await ownChat(who, id);
  const rows = await db().messages(c.id, HISTORY_MAX_MESSAGES);
  return {
    conversation: { id: c.id, title: c.title || '', updated_at: c.updated_at },
    messages: rows.map((m) => ({ id: m.id, role: m.role, content: m.content || '', created_at: m.created_at, payload: m.payload || null })),
  };
}

async function deleteChat(who, id) {
  const c = await ownChat(who, id);
  await db().hide(c.id);
  return { ok: true };
}

const SURFACES = ['home', 'library'];
async function suggestedQuestions(who, surface) {
  if (!UUID_RE.test(String(who.clientId || ''))) throw new ChatError(400, 'MISSING_FIELDS', 'clientId and userId are required.');
  const s = SURFACES.includes(String(surface)) ? String(surface) : 'home';
  const rows = await db().suggested(who.clientId, s);
  return {
    questions: rows.map((q) => ({
      id: q.id, category: q.category || 'decision', title: q.title || '', question: q.question,
      description: q.description || null, icon_name: q.icon_name || null,
    })),
  };
}

// ── The web addresses ────────────────────────────────────────────────────
function send(res, fn) {
  return fn().then((out) => res.json(out)).catch((err) => {
    if (err instanceof ChatError) return res.status(err.httpStatus).json({ ok: false, error: { code: err.code, message: err.message } });
    console.error('[DynamicRAG] chat history error:', err.message);
    return res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' } });
  });
}

function registerChatHistoryRoutes(app) {
  app.get('/dynamic-rag/conversations', (req, res) => send(res, async () => listChats(await whoIsAsking(req))));
  app.get('/dynamic-rag/conversations/:id', (req, res) => send(res, async () => openChat(await whoIsAsking(req), req.params.id)));
  app.delete('/dynamic-rag/conversations/:id', (req, res) => send(res, async () => deleteChat(await whoIsAsking(req), req.params.id)));
  app.get('/dynamic-rag/suggested-questions', (req, res) => send(res, async () => suggestedQuestions(await whoIsAsking(req), req.query.surface)));
}

module.exports = { registerChatHistoryRoutes, listChats, openChat, deleteChat, suggestedQuestions, useHistoryStore };
