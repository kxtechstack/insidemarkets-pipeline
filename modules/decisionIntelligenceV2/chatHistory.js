/**
 * modules/decisionIntelligence/chatHistory.js
 *
 * Persistence for Decision Intelligence chat history.
 * Backend-mediated: uses the service key, enforces user_id ownership
 * in code (no reliance on RLS). Mirrors bookmarks' ownership shape
 * (user_id -> admin.client_users.id, client_id as text).
 */

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function makeTitle(question) {
  const t = (question || '').trim().replace(/\s+/g, ' ');
  return t.length > 80 ? t.slice(0, 77) + '...' : t;
}

async function createConversation({ clientId, userId, firstQuestion }) {
  const { data, error } = await supabase
    .from('di_conversations')
    .insert({
      client_id: String(clientId),
      user_id: userId,
      title: makeTitle(firstQuestion),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function appendMessage({ conversationId, role, content, type = null, payload = null }) {
  const { error } = await supabase
    .from('di_messages')
    .insert({
      conversation_id: conversationId,
      role,
      content,
      type,
      payload,
    });
  if (error) throw error;
}

async function listConversations({ userId, limit = 100 }) {
  const { data, error } = await supabase
    .from('di_conversations')
    .select('id, title, created_at, updated_at')
    .eq('user_id', userId)
    .is('deleted_at', null)                       // hide soft-deleted
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function loadConversation({ conversationId, userId }) {
  const { data: convo, error: cErr } = await supabase
    .from('di_conversations')
    .select('id, title, created_at, updated_at')
    .eq('id', conversationId)
    .eq('user_id', userId)          // ownership check
    .is('deleted_at', null)         // hide soft-deleted
    .single();
  if (cErr || !convo) throw new Error('Conversation not found');

  const { data: messages, error: mErr } = await supabase
    .from('di_messages')
    .select('id, role, content, type, payload, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (mErr) throw mErr;

  return { conversation: convo, messages: messages || [] };
}

/**
 * Soft-delete: hide the conversation from the user, but preserve their
 * QUESTIONS for analytics. Wipes assistant ANSWERS (content + payload).
 * The row itself stays so we can count "how many users deleted this".
 *
 *  - di_conversations.deleted_at = now()      (hides from list + load)
 *  - di_messages where role='assistant'       (content = NULL, payload = NULL)
 *  - di_messages where role='user'            (untouched)
 */
async function deleteConversation({ conversationId, userId }) {
  // Verify ownership first
  const { data: convo, error: fetchErr } = await supabase
    .from('di_conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .single();
  if (fetchErr || !convo) throw new Error('Conversation not found');

  // 1. Soft-delete the conversation (hide from user)
  const { error: updErr } = await supabase
    .from('di_conversations')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', conversationId)
    .eq('user_id', userId);
  if (updErr) throw updErr;

  // 2. Wipe assistant message content + payload, keep user messages
  const { error: msgErr } = await supabase
    .from('di_messages')
    .update({ content: null, payload: null })
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant');
  if (msgErr) throw msgErr;
}

// --- Suggested questions -------------------------------------------------

/**
 * Fetches suggested questions for a surface, merging client-specific rows
 * over generic ones (client_id IS NULL), and fills templates using the
 * client's industry + company name.
 */
async function getSuggestedQuestions({ clientId, surface, category = null, industry = null, companyName = null }) {
  let query = supabase
    .from('di_suggested_questions')
    .select('id, client_id, category, surface, title, question, description, icon_name, sort_order, is_template')
    .eq('surface', surface)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (category) query = query.eq('category', category);

  // Generic (client_id IS NULL) OR this client's
  const { data, error } = await query.or(`client_id.is.null,client_id.eq.${clientId}`);
  if (error) throw error;

  // Dedupe: prefer client-specific row over generic with the same title
  const byTitle = new Map();
  for (const row of data || []) {
    const key = `${row.title}|${row.category}`;
    const existing = byTitle.get(key);
    if (!existing || (row.client_id && !existing.client_id)) {
      byTitle.set(key, row);
    }
  }

  const fill = (q) => {
    let out = q;
    if (industry)   out = out.replace(/\{industry\}/g, industry);
    if (companyName) out = out.replace(/\{client_name\}/g, companyName);
    // Any leftover placeholders get a neutral fallback so we never render "{industry}"
    out = out.replace(/\{[a-z_]+\}/gi, 'your sector');
    return out;
  };

  return [...byTitle.values()]
  .sort((a, b) => a.sort_order - b.sort_order)
  .map(row => ({
    id: row.id,
    category: row.category,
    surface: row.surface,
    title: row.is_template ? fill(row.title) : row.title,  // ← now filled
    question: row.is_template ? fill(row.question) : row.question,
    description: row.description,
    icon_name: row.icon_name,
    is_template: row.is_template,
  }));
}

module.exports = {
  createConversation, appendMessage,
  listConversations, loadConversation, deleteConversation,
  getSuggestedQuestions,
};