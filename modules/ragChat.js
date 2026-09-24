const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@xenova/transformers');
const { callLLM } = require('./llmClient');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { StringOutputParser } = require('@langchain/core/output_parsers');
const { RunnableSequence } = require('@langchain/core/runnables');
const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
const { AIMessage } = require('@langchain/core/messages');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { setupPolicyCollection } = require('./llmRelevanceProcessor'); // CHANGED: new
const { classifyIntent } = require('./decisionIntelligence/classifyIntent');
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';

const RAG_MODULE_PROMPTS = {
  '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960': 'rag_chat_policy_v1',                      // Policy & Risk
  '55c5ee19-bfca-468b-81b3-b89ca4f303c8': 'rag_chat_market_dynamics_v1',      // Market Dynamics
  '2eb989fd-0ea0-4320-b73a-f7eb8b970473': 'rag_chat_forward_outlook_v1',      // Forward Outlook
};

function stripCitationMarkers(text) {
  if (!text) return text;
  return String(text)
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

// ── Shared formatting contract injected into every RAG prompt ────────────────
const SHARED_FORMATTING_RULES = `FORMATTING RULES — apply to every answer without exception:

Structure the answer as a professional intelligence report:
1. Open with a one-paragraph executive summary that directly answers the question.
2. Follow with clearly labelled sections using "## Section Name" for each major theme.
3. Use "- " bullets for lists and "  - " (two-space indent + dash) for sub-bullets.
4. When comparing multiple items that each have several attributes, format them as:
   • Item Name
      - Attribute 1: value
      - Attribute 2: value
      - Attribute 3: value
5. Close with a short "## Implications" or "## What This Means" section when relevant.

Hard prohibitions:
- Never use tables. Never use the "|" character. Never use HTML tags such as <br>.
- Never insert citation markers anywhere in the answer text — no [1], no [1,3],
  no (Signal 1), no (Article 1), no (Source 1), no (Ref 1). The CITED_SOURCES
  line at the very top of your response is the ONLY place numbers may appear.
- Do not mention phrases such as "According to the provided articles",
  "Based on the retrieved context", or "The signals state".
- Do not repeat information. Do not invent or modify names, dates, numbers,
  organizations, regulations, or titles.

Preserve exactly:
- Organization names, jurisdiction names, regulation/legislation names,
  product names, dates, deadlines, numerical values, and monetary figures.`;

const getRagPromptTemplate = async (moduleId) => {
  const promptId = RAG_MODULE_PROMPTS[moduleId] || 'rag_chat_policy_v1';

  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', promptId)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    throw new Error(`Could not load RAG prompt '${promptId}': ${error?.message}`);
  }

  return data.prompt_template.includes('{FORMATTING_RULES}')
    ? data.prompt_template.replace('{FORMATTING_RULES}', SHARED_FORMATTING_RULES)
    : data.prompt_template;
};

// ── Local embedding model ────────────────────────────────────────────────────
let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return embedderPromise;
};
const embedText = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

// ── LangChain wrapper for LM Studio ─────────────────────────────────────────
class GroqChat extends BaseChatModel {
  constructor() {
    super({});
  }

  _llmType() {
    return 'groq';
  }

  async _generate(messages) {
    const formatted = messages.map(m => ({
      role: m._getType() === 'human' ? 'user' : m._getType() === 'system' ? 'system' : 'assistant',
      content: m.content,
    }));

    const content = await callLLM(formatted, { temperature: 0.1, max_tokens: 1200, timeout: 180000 });

    return {
      generations: [{ message: new AIMessage(content), text: content }],
    };
  }
}

// ── RAG chain using LangChain ────────────────────────────────────────────────
// CHANGED: askQuestion now takes moduleId and filters Qdrant search by it,
// so chat answers on one module's tab don't pull in content from other modules.
// ── Shared answer post-processor ─────────────────────────────────────────────
// Strips: leading filler, CITED_SOURCES line, leaked inline citation markers
//         ((Signal n) / (Article n) / [n] / [1,3]), HTML breaks, tables.
// KEEPS: markdown headers (##), bold (**), bullets (- / •), sub-bullets.
const cleanRagAnswer = (raw) => {
  let out = raw;

  // 1. Remove leading conversational filler
  out = out
    .replace(/^According to the (provided )?policy articles[:,-]?\s*/i, '')
    .replace(/^According to the (provided )?market signals[:,-]?\s*/i, '')
    .replace(/^According to the (provided )?trend signals[:,-]?\s*/i, '')
    .replace(/^According to the articles[:,-]?\s*/i, '')
    .replace(/the articles state that\s*/gi, '')
    .replace(/the signals state that\s*/gi, '')
    .replace(/Based on the retrieved context[:,-]?\s*/gi, '');

  // 2. Extract & strip CITED_SOURCES line (tolerant of whitespace/periods)
  const citedMatch = out.match(/^\s*CITED_SOURCES:\s*(none|[\d,\s]+)\s*[\.\n]/i);
  let citedIndices = new Set();
  if (citedMatch) {
    const val = citedMatch[1].toLowerCase().trim();
    if (val !== 'none') {
      citedIndices = new Set(
        val.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
      );
    }
    out = out.replace(/^\s*CITED_SOURCES:\s*(none|[\d,\s]+)\s*[\.\n]+/i, '');
  }

  // 3. Strip leaked inline citation markers the LLM snuck in
out = out
  .replace(/\s*\((?:Signal|Article|Source|Ref|Reference)\s*\d+\)/gi, '')
  .replace(/\s*\[(?:Signal|Article|Source|Ref|Reference)\s*\d+\]/gi, '')
  .replace(/\s*\[(\d+(?:\s*,\s*\d+)*)\]/g, '')
  .replace(/\s*\((?:see|ref\.?|refer to)\s+(?:Signal|Article|Source)\s*\d+\)/gi, '')
  .replace(/\b(?:Signal|Article|Source|Reference)s?\s+\d+\b/gi, '');   // ← NEW LINE

  // 4. HTML + markdown table → bullet fallback (belt & braces)
  out = out
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/^\|?-{3,}(\|-{3,})*\|?\s*$/gm, '')
    .replace(/^\s*\|\s*/gm, '• ')
    .replace(/\s*\|\s*/g, '  —  ');

  // 5. Collapse whitespace
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return { answer: out, citedIndices };
};

// ── RAG chain ────────────────────────────────────────────────────────────────
const askQuestion = async (question, clientId, industry, moduleId) => {

  // ── 0. Intent gate ───────────────────────────────────────────────────
  // Same LLM-driven classification the DI chat uses. Stops greetings,
  // off-topic questions, and clarifications from ever reaching Qdrant.
  // On any failure, classifyIntent() falls back to 'market_intelligence'
  // so real questions are never blocked.
  try {
    const intentResult = await classifyIntent(question);

    if (intentResult.intent !== 'market_intelligence') {
      const MODULE_LABELS = {
        '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960': 'Policy & Risk',
        '55c5ee19-bfca-468b-81b3-b89ca4f303c8': 'Market Dynamics',
        '2eb989fd-0ea0-4320-b73a-f7eb8b970473': 'Forward Outlook',
      };
      const moduleLabel = MODULE_LABELS[moduleId] || 'this module';

      // Module-specific topic descriptions — used for off-topic replies so
      // the user is told what THIS tab covers, not "market intelligence" in general.
      const MODULE_TOPICS = {
        '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960':
          'policy, regulations, licensing, and compliance',
        '55c5ee19-bfca-468b-81b3-b89ca4f303c8':
          'funding, investments, competitors, and market movements',
        '2eb989fd-0ea0-4320-b73a-f7eb8b970473':
          'emerging trends, innovations, and forward-looking developments',
      };
      const moduleTopics = MODULE_TOPICS[moduleId] || 'market intelligence';

      // Prefer the LLM-generated message from classifyIntent — it's the same
      // natural, contextual reply the DI tab uses. Off-topic is special-cased
      // so the reply names what THIS tab covers instead of "market intelligence".
      const llmMessage = (intentResult.message || '').trim();

      let reply;
      if (intentResult.intent === 'off_topic') {
        reply =
          `I'm built to help with ${moduleLabel} — ${moduleTopics}. ` +
          `I can't answer off-topic questions here. Is there something about ` +
          `${moduleTopics.split(',')[0].trim()} I can help you dig into?`;
      } else if (llmMessage) {
        reply = llmMessage;
      } else if (intentResult.intent === 'greeting') {
        reply = `Hi! Ask me anything about ${moduleLabel} — I'll pull from the signals in this tab.`;
      } else if (intentResult.intent === 'clarification') {
        reply = `Could you clarify what you'd like to know about ${moduleLabel}? Try asking about recent developments, key players, or trends.`;
      } else {
        reply = `I can only answer questions about ${moduleLabel}.`;
      }

      console.log(`[RAG] intent=${intentResult.intent} — short-circuiting before retrieval`);
      return { answer: reply, sources: [] };
    }
  } catch (err) {
    // If classification itself throws, log and fall through to normal flow.
    console.log(`[RAG] classifyIntent failed, proceeding with retrieval: ${err.message}`);
  }

  await setupPolicyCollection();

  // Step 1 — embed question, retrieve from Qdrant scoped to client + industry + module
  const questionVector = await embedText(question);

  const searchResults = await qdrant.search(POLICY_COLLECTION, {
    vector: questionVector,
    limit: 15,
    filter: {
      must: [
        { key: 'client_id', match: { value: clientId } },
        { key: 'industry',  match: { value: industry } },
        { key: 'module_id', match: { value: moduleId } },
      ],
    },
    with_payload: true,
  });

  const filteredResults = searchResults.filter(r => r.score >= 0.20);

  console.log('[RAG] Retrieved chunks:');
  filteredResults.forEach((r, i) => {
    console.log(`[${i + 1}] Score: ${r.score.toFixed(3)} | Title: ${r.payload.title}`);
    console.log(`     Chunk: ${r.payload.chunk_text.slice(0, 150)}`);
  });

  if (!filteredResults || filteredResults.length === 0) {
    return {
      answer: 'No relevant information found for your question in this module.',
      sources: [],
    };
  }

  // Step 2 — build context
  const context = filteredResults
    .map((r, i) => `[${i + 1}] ${r.payload.title}\n${r.payload.chunk_text}`)
    .join('\n\n');

  // Step 3 — LangChain RAG chain
  const llm = new GroqChat();
  const promptTemplate = await getRagPromptTemplate(moduleId);

  const prompt = ChatPromptTemplate.fromMessages([
    ['system', promptTemplate],
  ]);

  const chain = RunnableSequence.from([
    prompt,
    llm,
    new StringOutputParser(),
  ]);

  const rawAnswer = await chain.invoke({ context, question, industry });

  // Step 4 — clean + extract citations
  const { answer: cleanedAnswer, citedIndices } = cleanRagAnswer(rawAnswer);

  // Step 5 — resolve sources
  const NO_ANSWER_PATTERNS = [
    /don'?t have enough information/i,
    /no relevant (policy |market |trend )?information/i,
  ];
  const isNoAnswer = NO_ANSWER_PATTERNS.some(p => p.test(cleanedAnswer));

  // Bounds-check cited indices against what we actually retrieved
  const validIndices = new Set(
    [...citedIndices].filter(n => n >= 1 && n <= filteredResults.length)
  );

  let citedResults;
  if (isNoAnswer) {
    citedResults = [];
  } else if (validIndices.size > 0) {
    citedResults = filteredResults.filter((_, i) => validIndices.has(i + 1));
  } else {
    // LLM forgot to declare sources but did answer → show top 3 retrieved
    citedResults = filteredResults.slice(0, 3);
  }

  // Sanitize titles coming out of Qdrant — some chunks have been stored with
  // leading "••Title:" markers or trailing bullet characters. Strip them so
  // the sources panel always shows a clean article title.
  const cleanTitle = (t) =>
    (t || '')
      .replace(/^[•\-\*\s]*Title:\s*/i, '')
      .replace(/[•\*\s]+$/g, '')
      .trim();

  const sources = [...new Map(
    citedResults.map(r => [r.payload.url, {
      title: cleanTitle(r.payload.title),
      url:   r.payload.url,
    }])
  ).values()];

  return { answer: stripCitationMarkers(cleanedAnswer), sources };
};

module.exports = { askQuestion };
