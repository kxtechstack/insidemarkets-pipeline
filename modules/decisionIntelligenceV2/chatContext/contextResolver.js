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
ABSOLUTE FIRST RULE — THIS WINS OVER EVERYTHING BELOW
=========================

Before applying any other rule in this prompt, run this gate first.

If the current message contains BOTH:
  (a) a question word (what / where / when / how / why / who / which / whose), AND
  (b) a named subject the user typed (a company, brand, product, place, or topic)

...then the answer is ALWAYS:

  kind = "new_question"
  standalone_query = the current message, EXACTLY as the user typed it, verbatim.

Do NOT look at the prior conversation. Do NOT look at the state.
Do NOT add anything from the previous turn. Do NOT rewrite the message into a
longer question. Do NOT treat it as a followup, even if the topic is different
from whatever the conversation was about before.

This rule wins over every other rule below. If a rule below would classify
the message as "followup", ignore that rule. This rule wins.

Examples:

  Prior turn: "what is happening in korean beauty market"
  Current:    "what is the update of glossier"
  → kind = "new_question"
  → standalone_query = "what is the update of glossier"
  → NOT "What is the update of Glossier in the Korean beauty market?"

  Prior turn: "what is happening in korean beauty market"
  Current:    "what is the update about glossier"
  → kind = "new_question"
  → standalone_query = "what is the update about glossier"

  Prior turn: "tell me about apple"
  Current:    "what is microsoft's revenue"
  → kind = "new_question"
  → standalone_query = "what is microsoft's revenue"

  Prior turn: "compare amazon and dell revenue"
  Current:    "what is google's market cap"
  → kind = "new_question"
  → standalone_query = "what is google's market cap"

IMPORTANT: This rule does NOT apply when the message is a bare company name
with no question word (e.g. "microsoft", "apple", "tesla"). Those are
followups handled by the NAKED COMPANY NAME rule below.

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
SPECIAL RULE — SHORT METRIC-ONLY FRAGMENTS
=========================

When the recent conversation has established a topic (a company, a market,
a comparison), a short fragment that names ONLY a metric or a metric-like
term is a FOLLOWUP, not an off_topic and not a new question.

Examples of short metric-only fragments:
  "net income?"          → followup
  "revenue?"             → followup
  "profit?"              → followup
  "operating income?"    → followup
  "last year?"           → followup
  "what about 2024?"     → followup
  "3 years?"             → followup

For these:
  - kind = "followup"
  - standalone_query = the full question with the same topic/entities
    as the prior turn, but with the metric/timeframe swapped.

Example:
  Prior turn: "compare amazon and dell revenue for the last 3 years"
  Current:    "net income?"
  Output: {
    "kind": "followup",
    "standalone_query": "Compare Amazon and Dell net income for the last 3 years.",
    "references": [{ "text": "net income", "resolved_to": "change the metric from revenue to net income" }],
    "context_used": ["prior comparison of Amazon and Dell revenue"],
    "new_constraints": ["metric: net income"]
  }

The ONLY time a metric-only fragment is off_topic is when there is genuinely
no prior conversation on any business topic to attach it to. If the last
turn was about a company, a market, or a comparison, a metric fragment is
ALWAYS a followup.


=========================
SPECIAL RULE — NAKED COMPANY NAME
=========================

If the current message is JUST a company name (one or two words, no other
content, no question mark) AND the recent conversation was about a specific
company or a specific question applied to a company, treat it as a FOLLOWUP.

Examples that are FOLLOWUPS, not off_topic:

  Recent: "give me swot analysis for estee lauder"
  Current: "microsoft"
  → kind = "followup"
  → standalone_query = "What is the SWOT analysis for Microsoft?"

  Recent: "give me swot analysis for estee lauder"
  Current: "apple"
  → kind = "followup"
  → standalone_query = "What is the SWOT analysis for Apple?"

  Recent: "what is Apple's revenue?"
  Current: "google"
  → kind = "followup"
  → standalone_query = "What is Google's revenue?"

  Recent: "do a pestle analysis for estee lauder"
  Current: "tesla"
  → kind = "followup"
  → standalone_query = "Do a PESTLE analysis for Tesla."

  Recent: "compare amazon and dell revenue"
  Current: "microsoft"
  → kind = "followup"
  → standalone_query = "What is Microsoft's revenue?"

The rule: if the previous turn established a "template" question (a SWOT
analysis, a PESTLE, a specific metric lookup, a comparison), then a naked
company name replaces the company in that template.

NEVER classify a naked company name as off_topic when the recent conversation
was about a business topic involving a company. Single-word messages like
"microsoft", "apple", "tesla", "google" are ALWAYS substitution follow-ups
when the prior turn mentioned a different company in a business context.

=========================
SPECIAL RULE — REFORMAT REQUESTS
=========================

If the current message is asking to TRANSFORM the previous answer rather
than fetch new information, use kind = "reformat".

Reformat requests include (but are NOT limited to):
  - "give me this in 4 bullet points"
  - "summarize that"
  - "make it shorter"
  - "TL;DR"
  - "expand on the second point"
  - "explain more"
  - "elaborate"
  - "go deeper"
  - "tell me more about this"
  - "put this in a table"
  - "rewrite in simpler language"
  - "just the numbers"
  - "what are the key takeaways"
  - "rephrase this"
  - "make this more formal"
  - "make this more casual"
  - "translate to <language>"
  - Any instruction that asks to change the format, tone, length, or presentation of the previous answer without asking for a new topic.

For "reformat":
  - kind = "reformat"
  - standalone_query = the user's reformat instruction VERBATIM.
    Do NOT rewrite it into a full question. Example:
      User: "explain more"
      → standalone_query = "explain more"
      (not "Explain more about the SWOT analysis for Estee Lauder")
  - context_used = ["the previous assistant answer"]

The key distinction:
  - "reformat" = apply an instruction to the existing answer. No new
    information is being fetched.
  - "followup" = the user wants a NEW question answered, with context
    carried over from the previous turn.

Test yourself: "Does the user want NEW information, or the SAME
information presented differently?" If SAME information, kind = "reformat".

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
  standalone_query is the original message verbatim. Never add anything
  from prior context. If you feel the urge to add prior context, that
  means the message should have been classified as "followup" per the
  rule above — but if it named its own subject and had a question word,
  the ABSOLUTE FIRST RULE already forced it to be new_question with the
  verbatim query. Trust that.

IMPORTANT — kind vs rewrite consistency:

If your standalone_query has to ADD context from the recent conversation to
make the question complete — you added a country, a metric, a company, or a
timeframe that the user did NOT type in the current message — then kind is
"followup", NOT "new_question". The rewrite depends on prior context, so the
message is by definition a follow-up.

Examples:

  Current: "who are the biggest players"
  Recent:  prior turn about "the Korean beauty market"
  You might rewrite as: "Who are the biggest players in the Korean beauty market?"
  → kind = "followup"  (you added "Korean beauty market" from context)
  → NOT "new_question"

  Current: "what about japan"
  Recent:  prior turn about "the Korean beauty market"
  You might rewrite as: "What is the Japanese beauty market like?"
  → kind = "followup"
  → NOT "new_question"

  Current: "what is happening in Japan?"
  Recent:  unrelated prior turn
  You rewrite as: "What is happening in Japan?"
  → kind = "new_question"  (no context used — the user already said Japan)

The rule: if the standalone_query is a rewrite that adds ANY information
from the recent messages or current state, kind = "followup".

=========================
CRITICAL RULE — SELF-CONTAINED QUESTIONS
=========================

A message is a FOLLOWUP only if it CANNOT be understood without the prior
context. If the message NAMES ITS OWN SUBJECT (a company, a topic, a market,
a metric), it is a NEW_QUESTION — even if prior context exists in the
conversation.

The presence of prior context does NOT make a message a followup. A message
is a followup only when it is INCOMPLETE on its own.

Test: strip away all prior messages and state. Does the current message
still make sense as a standalone question?

  "what is the update of glossier"
    → Complete on its own. NEW_QUESTION.
    → standalone_query = "What is the update of Glossier?"

  "what is happening in the cosmetics industry"
    → Complete on its own. NEW_QUESTION.

  "what has L'Oréal been doing recently"
    → Complete on its own. NEW_QUESTION.

  "what are the major policy changes in the last week"
    → Complete on its own. NEW_QUESTION.

  "microsoft"
    → INCOMPLETE. No verb, no question word. FOLLOWUP.
    → standalone_query = "What is the SWOT analysis for Microsoft?" (uses prior topic)

  "what about apple"
    → INCOMPLETE. "what about" refers to something prior. FOLLOWUP.

  "net income?"
    → INCOMPLETE. No subject. FOLLOWUP.

  "and in japan"
    → INCOMPLETE. "and" continues a prior line of inquiry. FOLLOWUP.

  "tell me more"
    → INCOMPLETE. "more" refers to prior. FOLLOWUP.

RULE OF THUMB:
  If the message has BOTH a SUBJECT and a QUESTION WORD
  (what / where / when / how / why / who / which), it is a NEW_QUESTION.
  Do NOT rewrite it into a longer query with prior context — that would
  corrupt the question.

HARD PROHIBITION:
  Never take a question like "what is the update of glossier" and rewrite
  it as "what is the update of glossier in the Korean beauty market" or
  "what is the update of glossier in the South Korea cosmetics industry".
  The user asked about glossier, period. Do not add topics, markets,
  companies, or timeframes that the user did NOT type in the current
  message, unless the current message is genuinely incomplete (a followup).

  If prior context happens to be on the same subject, that is fine — the
  pipeline will still find the right data. But if prior context is on a
  DIFFERENT subject (e.g. previous turn was about Korean beauty and the
  current turn is about glossier), do NOT mix them.

=========================
CRITICAL RULE — BROAD MARKET QUERIES
=========================

If the user asks a broad question about companies, revenue, or rankings 
(e.g., "Revenue of top cosmetic companies", "top 5 airlines", "compare 
apple and amazon"), it is a NEW_QUESTION.

Do NOT attach a specific country or region from the previous conversation 
to this question. The SEC data is always US-based, so adding "Korean" or 
"Japan" will break the query.

For example:
  Recent: "What is happening in the Korean beauty market?"
  Current: "Revenue of top cosmetic companies"
  → kind = "new_question"
  → standalone_query = "Revenue of top cosmetic companies"
  → NOT "Revenue of top cosmetic companies in the Korean beauty market."

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

Example 6 — very short follow-up fragment
Recent:
  USER: What is the Apple revenue for the last year?
  ASSISTANT: Apple's FY2025 revenue was $416.16B.
Current: "microsoft?"
Output: {
  "kind": "followup",
  "standalone_query": "What is Microsoft's revenue for the last year?",
  "references": [
    { "text": "microsoft?", "resolved_to": "apply the same question to Microsoft instead of Apple" }
  ],
  "context_used": ["prior question about Apple revenue for the last year"],
  "new_constraints": ["company: Microsoft"]
}

Example 7 — replacing a set of companies
Recent:
  USER: compare amazon and dell revenue for the last 3 years
  ASSISTANT: Amazon's FY2025 revenue was $716.92B; Dell's FY2025 was $95.57B.
Current: "what about apple and microsoft"
Output: {
  "kind": "followup",
  "standalone_query": "Compare Apple and Microsoft revenue for the last 3 years.",
  "references": [
    { "text": "what about apple and microsoft", "resolved_to": "apply the same comparison to Apple and Microsoft instead of Amazon and Dell" }
  ],
  "context_used": ["prior revenue comparison for Amazon and Dell, last 3 years"],
  "new_constraints": ["companies: Apple, Microsoft"]
}

Example 8 — off-topic
Current: "what's the weather in London"
Output: {
  "kind": "off_topic",
  "standalone_query": "what's the weather in London",
  "references": [],
  "context_used": [],
  "new_constraints": []
}

=========================
SPECIAL RULE — SHORT FRAGMENTS
=========================

Very short messages (one or two words plus a question mark) that
contain a company, brand, entity, or topic name are FOLLOWUPS, not
off_topic. A message like "microsoft?", "ulta?", or "apple?" after a
previous question means: "answer the same question for that entity".

Only classify as off_topic when the message has no business content
AND no plausible referent in the recent conversation or current state.

=========================
SPECIAL RULE — REPLACING COMPANIES
=========================

When the user says "what about X and Y" (or similar) AFTER a comparison
involving different companies, the standalone query should REPLACE the
previous company set with the new one. Do NOT mention both old and new
companies in the standalone query.

Signals that a replacement is happening:
  - The new company set is a full alternative ("apple and microsoft"
    instead of "amazon and dell")
  - The user did not say "also", "add", or "in addition"
  - The metric and timeframe stay the same

If the user says "also" or "and also" or "add", THEN keep the old
companies and append the new ones.

=========================

Respond with ONLY the JSON object. No markdown fences, no explanation.`;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
const VALID_KINDS = new Set([
  'greeting', 'off_topic', 'clarification', 'followup', 'new_question', 'reformat',
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

  return (data || []).reverse();
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────
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