/**
 * modules/decisionIntelligenceV2/chatContext/contextResolver.js
 *
 * Reads the new user message, recent messages, and current conversation
 * state, then produces a standalone query for the existing pipeline.
 *
 * One LLM call. No keyword logic.
 *
 * Public API:
 *   resolveContext({ conversationId, userMessage, currentState })
 *     → { kind, standalone_query, references, context_used, new_constraints }
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../../llmClient');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const RECENT_MESSAGE_LIMIT = 10;

// ─────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────
const RESOLVER_PROMPT = `You are a context resolver for a market intelligence chat assistant.

You read (1) the current user message, (2) recent messages from this conversation,
and (3) the current structured state of the conversation. Your job is to
produce a single self-contained question that the rest of the system can
answer WITHOUT looking at any of this history.

Return ONLY this JSON object:

{
  "kind": "greeting" | "off_topic" | "clarification" | "followup" | "new_question",
  "standalone_query": "<the current message rewritten as a complete, standalone question>",
  "references": [
    { "text": "<pronoun or fragment from the current message>", "resolved_to": "<what it refers to>" }
  ],
  "context_used": ["<short descriptions of prior context this depends on>"],
  "new_constraints": ["<constraints or facts the current message adds to the conversation>"]
}

=========================
KIND RULES
=========================

- "greeting"      = hello, hi, thanks, bye, ok, or any short social message
                    with no informational content.
- "off_topic"     = not about business / market / finance.
- "clarification" = too vague to act on, even with full context
                    (e.g. "asdf", "hmm", "???").
- "followup"      = depends on the previous messages or the current state
                    to be understood. Pronouns ("they", "it", "that"),
                    ellipses ("and in UAE?", "what about SMEs?"),
                    answers to prior questions ("yes", "no", "do that"),
                    comparisons ("compare the first two"), all fall here.
- "new_question"  = a fresh business question that stands on its own.

=========================
STANDALONE_QUERY RULES
=========================

- For "greeting", "off_topic", "clarification":
  put the ORIGINAL message verbatim in standalone_query.

- For "followup":
  rewrite the message into a complete question, filling in EVERY missing
  reference from the recent messages and current state. No pronouns, no
  ellipses, no "the previous", no "that". Complete and specific.

- For "new_question":
  standalone_query is normally the original message verbatim, UNLESS the
  current state contains constraints the user clearly intends to keep
  (e.g. same market, same product). In that case prepend those constraints
  explicitly to the query.

=========================
EXAMPLES
=========================

Example 1 — greeting
Current: "hi"
Output: {
  "kind": "greeting",
  "standalone_query": "hi",
  "references": [],
  "context_used": [],
  "new_constraints": []
}

Example 2 — first business question, no prior context
Current: "What is the optimal pricing strategy for our SaaS product in Saudi Arabia?"
Output: {
  "kind": "new_question",
  "standalone_query": "What is the optimal pricing strategy for our SaaS product in Saudi Arabia?",
  "references": [],
  "context_used": [],
  "new_constraints": ["product: SaaS", "market: Saudi Arabia", "topic: pricing strategy"]
}

Example 3 — follow-up using pronoun and prior topic
Recent: assistant previously explained pricing for a SaaS product in Saudi Arabia.
Current: "What if we target SMEs instead?"
Output: {
  "kind": "followup",
  "standalone_query": "For the SaaS product in Saudi Arabia discussed previously, how does the optimal pricing strategy change if we target SMEs instead?",
  "references": [
    { "text": "we", "resolved_to": "the company and its SaaS product in Saudi Arabia" },
    { "text": "instead", "resolved_to": "instead of the previously discussed target segment" }
  ],
  "context_used": ["SaaS product", "Saudi Arabia", "pricing strategy"],
  "new_constraints": ["target_segment: SMEs"]
}

Example 4 — short affirmative answering a prior question
Recent: assistant asked whether the user wants a comparison of two companies.
Current: "yes"
Output: {
  "kind": "followup",
  "standalone_query": "Yes — please compare the two companies as proposed.",
  "references": [
    { "text": "yes", "resolved_to": "the comparison proposed by the assistant" }
  ],
  "context_used": ["pending comparison of two companies"],
  "new_constraints": []
}

Example 5 — new question with a geographic shift
Recent: prior discussion about Saudi Arabia.
Current: "And in UAE?"
Output: {
  "kind": "followup",
  "standalone_query": "Apply the same analysis to the UAE market instead of Saudi Arabia.",
  "references": [
    { "text": "And", "resolved_to": "continue the same line of analysis" },
    { "text": "in UAE", "resolved_to": "change the market to the UAE" }
  ],
  "context_used": ["prior analysis", "Saudi Arabia"],
  "new_constraints": ["market: UAE"]
}

Example 6 — off-topic
Current: "what's the weather in London"
Output: {
  "kind": "off_topic",
  "standalone_query": "what's the weather in London",
  "references": [],
  "context_used": [],
  "new_constraints": []
}

=========================

Respond with ONLY the JSON object. No markdown fences, no explanation.`;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
const VALID_KINDS = new Set([
  'greeting', 'off_topic', 'clarification', 'followup', 'new_question',
]);

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

function fallbackResult(userMessage) {
  return {
    kind: 'new_question',
    standalone_query: String(userMessage || ''),
    references: [],
    context_used: [],
    new_constraints: [],
    _fallback: true,
  };
}

function sanitize(parsed, userMessage) {
  const out = fallbackResult(userMessage);
  if (!parsed || typeof parsed !== 'object') return out;

  if (typeof parsed.kind === 'string' && VALID_KINDS.has(parsed.kind)) {
    out.kind = parsed.kind;
  }

  if (typeof parsed.standalone_query === 'string' && parsed.standalone_query.trim()) {
    out.standalone_query = parsed.standalone_query.trim();
  } else {
    out.standalone_query = String(userMessage || '');
  }

  if (Array.isArray(parsed.references)) {
    out.references = parsed.references
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({
        text: typeof r.text === 'string' ? r.text : '',
        resolved_to: typeof r.resolved_to === 'string' ? r.resolved_to : '',
      }))
      .filter((r) => r.text && r.resolved_to);
  }

  if (Array.isArray(parsed.context_used)) {
    out.context_used = parsed.context_used
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => c.trim());
  }

  if (Array.isArray(parsed.new_constraints)) {
    out.new_constraints = parsed.new_constraints
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => c.trim());
  }

  out._fallback = false;
  return out;
}

async function loadRecentMessages(conversationId, limit = RECENT_MESSAGE_LIMIT) {
  if (!conversationId) return [];
  const { data, error } = await supabase
    .from('di_messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.log(`[contextResolver] loadRecentMessages error: ${error.message}`);
    return [];
  }

  // Reverse so oldest-first
  return (data || []).reverse();
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────
/**
 * @param {object} args
 * @param {string} args.conversationId
 * @param {string} args.userMessage
 * @param {object} args.currentState  - from stateStore.loadState()
 * @returns {Promise<{
 *   kind: 'greeting'|'off_topic'|'clarification'|'followup'|'new_question',
 *   standalone_query: string,
 *   references: Array<{text: string, resolved_to: string}>,
 *   context_used: string[],
 *   new_constraints: string[],
 * }>}
 */
async function resolveContext({ conversationId, userMessage, currentState }) {
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    return fallbackResult(userMessage);
  }

  let recentMessages = [];
  try {
    recentMessages = await loadRecentMessages(conversationId);
  } catch (err) {
    console.log(`[contextResolver] failed to load recent messages: ${err.message}`);
  }

  const stateBlock = (currentState && Object.keys(currentState).length > 0)
    ? JSON.stringify(currentState, null, 2)
    : '(empty)';

  const messagesBlock = recentMessages.length > 0
    ? recentMessages.map((m) => `${m.role.toUpperCase()}: ${m.content || ''}`).join('\n')
    : '(none)';

  const userPrompt =
    `CURRENT CONVERSATION STATE:\n${stateBlock}\n\n` +
    `RECENT MESSAGES (oldest first):\n${messagesBlock}\n\n` +
    `CURRENT USER MESSAGE:\n${userMessage}`;

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: RESOLVER_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0, max_tokens: 700, timeout: 45000 }
    );
  } catch (err) {
    console.log(`[contextResolver] LLM call failed: ${err.message}`);
    return fallbackResult(userMessage);
  }

  if (process.env.DI_V2_DEBUG_LLM === '1') {
    console.log('[contextResolver] RAW LLM OUTPUT:');
    console.log(raw);
    console.log('[contextResolver] END RAW');
  }

  const stripped = stripFences(raw);
  const jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock) {
    console.log(`[contextResolver] no JSON found in: ${stripped.slice(0, 200)}`);
    return fallbackResult(userMessage);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (err) {
    console.log(`[contextResolver] JSON parse failed: ${err.message}`);
    return fallbackResult(userMessage);
  }

  const result = sanitize(parsed, userMessage);

  console.log(
    `[contextResolver] kind=${result.kind} ` +
    `refs=${result.references.length} ` +
    `context_used=${result.context_used.length} ` +
    `new_constraints=${result.new_constraints.length}`
  );

  return result;
}

module.exports = {
  resolveContext,
  loadRecentMessages,
  RESOLVER_PROMPT,
  RECENT_MESSAGE_LIMIT,
};