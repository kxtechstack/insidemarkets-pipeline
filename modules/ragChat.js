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

  return data.prompt_template;
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

    const content = await callLLM(formatted, { temperature: 0.1, max_tokens: 500, timeout: 180000 });

    return {
      generations: [{ message: new AIMessage(content), text: content }],
    };
  }
}

// ── RAG chain using LangChain ────────────────────────────────────────────────
// CHANGED: askQuestion now takes moduleId and filters Qdrant search by it,
// so chat answers on one module's tab don't pull in content from other modules.
const askQuestion = async (question, clientId, industry, moduleId) => {

  await setupPolicyCollection(); // CHANGED: ensures module_id index exists before searching

  // Step 1 — embed question and retrieve from Qdrant
  const questionVector = await embedText(question);

  const searchResults = await qdrant.search(POLICY_COLLECTION, {
    vector: questionVector,
    limit: 15,
    filter: {
      must: [
        { key: 'client_id', match: { value: clientId } },
        { key: 'industry', match: { value: industry } },
        { key: 'module_id', match: { value: moduleId } }, // CHANGED: new
      ],
    },
    with_payload: true,
  });
    const filteredResults = searchResults.filter(r => r.score >= 0.20);


  console.log('[RAG] Retrieved chunks:');
  filteredResults.forEach((r, i) => {
    console.log(`[${i+1}] Score: ${r.score.toFixed(3)} | Title: ${r.payload.title}`);
    console.log(`     Chunk: ${r.payload.chunk_text.slice(0, 150)}`);
  });

  if (!filteredResults || filteredResults.length === 0) {
    return { answer: 'No relevant policy information found for your question.', sources: [] };
  }

  // Step 2 — build context
  const context = filteredResults
    .map((r, i) => `[${i + 1}] ${r.payload.title}\n${r.payload.chunk_text}`)
    .join('\n\n');

  // Step 3 — LangChain RAG chain
  const llm = new GroqChat();

  const promptTemplate = await getRagPromptTemplate(moduleId);

  const prompt = ChatPromptTemplate.fromMessages([
  ["system", promptTemplate]
]);

  const chain = RunnableSequence.from([
    prompt,
    llm,
    new StringOutputParser(),
  ]);

  const answer = await chain.invoke({
    context,
    question,
    industry
});

  let cleanedAnswer = answer
  .replace(/^According to the (provided )?policy articles[:,-]?\s*/i, "")
  .replace(/^According to the articles[:,-]?\s*/i, "")
  .replace(/the articles state that\s*/gi, "")
  .replace(/Based on the retrieved context[:,-]?\s*/gi, "")
  .replace(/\*\*(.*?)\*\*/g, '$1')
  .replace(/\*(.*?)\*/g, '$1')
  .replace(/#{1,6}\s/g, '')
  .replace(/^\s*[-*]\s/gm, '• ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();


  // Step 4 — only keep sources the LLM actually cited by [n] number in its answer.
  // filteredResults[i] corresponds to citation marker [i+1] in the context we built above.
  const citedIndices = new Set(
    [...cleanedAnswer.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1], 10))
  );

  const NO_ANSWER_PATTERNS = [
    /don'?t have enough information/i,
    /no relevant (policy )?information/i,
    /cannot answer/i,
    /unable to answer/i,
  ];
  const isNoAnswer = NO_ANSWER_PATTERNS.some(p => p.test(cleanedAnswer));

  let citedResults;
  if (isNoAnswer) {
    citedResults = []; // model said it couldn't answer — show no sources, even if some cleared the score filter
  } else if (citedIndices.size > 0) {
    citedResults = filteredResults.filter((_, i) => citedIndices.has(i + 1));
  } else {
    citedResults = filteredResults; // model gave a real answer but didn't cite — fall back to showing all retrieved (safer than showing none)
  }

  const sources = [...new Map(citedResults.map(r => [r.payload.url, {
    title: r.payload.title,
    url: r.payload.url,
  }])).values()];

  return { answer: cleanedAnswer, sources };

};

module.exports = { askQuestion };