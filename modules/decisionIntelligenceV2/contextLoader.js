/**
 * modules/decisionIntelligenceV2/contextLoader.js
 *
 * Loads recent chat history and rewrites follow-up questions
 * ("explain more", "where is this from") into standalone questions.
 */

const { loadConversation } = require('../decisionIntelligence/chatHistory');

const { callLLM } = require('../llmClient');

function summarizeAssistant(m) {
  const p = m.payload || {};
  if (p.type === 'list') {
    const titles = (p.items || [])
      .slice(0, 8)
      .map(i => i.title || i.headline || '')
      .filter(Boolean)
      .join(' | ');
    return `List answer: ${titles}`;
  }
  return JSON.stringify(p.report || m.content || '').slice(0, 1500);
}

async function loadContext({ question, conversationId, userId }) {
  // first message of a chat: nothing to resolve
  if (!conversationId) return { standaloneQuestion: question, history: [] };

  let history = [];
  try {
    const loaded = await loadConversation({ conversationId, userId });
    history = loaded.messages || [];
  } catch (e) {
    console.log(`[contextLoader] history load failed: ${e.message}`);
    return { standaloneQuestion: question, history: [] };
  }

  const recent = history.slice(-4); // last 2 Q&A pairs
  if (recent.length === 0) return { standaloneQuestion: question, history };

  const convo = recent
    .map(m => `${m.role}: ${m.role === 'assistant' ? summarizeAssistant(m) : m.content}`)
    .join('\n');

  const prompt = `You rewrite follow-up questions in a market intelligence chat.

Conversation so far:
${convo}

Latest user message: ${question}

If the latest message depends on the conversation (uses words like "this", "that", "they", "explain more", "where is this data from", "why"), rewrite it as ONE complete standalone question that includes the topic from the previous answer.
If it is already a complete standalone question, return it unchanged.
Return ONLY the question text. No quotes, no explanation.`;

  try {
    const out = await callLLM(
      [
        { role: 'system', content: 'You rewrite follow-up questions into standalone questions. Return only the question text.' },
        { role: 'user', content: prompt },
      ],
      { temperature: 0, max_tokens: 200, timeout: 20000 }
    );
    const q = String(out || '').trim().replace(/^["']|["']$/g, '');
    return { standaloneQuestion: q.length > 3 ? q : question, history };
  } catch (err) {
    console.log(`[contextLoader] rewrite failed, using original: ${err.message}`);
    return { standaloneQuestion: question, history }; // never break the chat
  }
}

module.exports = { loadContext };