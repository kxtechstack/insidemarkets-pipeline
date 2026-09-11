/**
 * modules/decisionIntelligence/retrieveClientData.js
 *
 * Retrieval for List/Inference questions in the Decision Intelligence
 * chat -- searches the CLIENT'S OWN collected data (never SEC filings),
 * across all existing modules at once instead of one moduleId at a time
 * like ragChat.js's askQuestion() does.
 *
 * Reuses the exact same embedding + Qdrant pattern already proven in
 * ragChat.js/marketInsights.js: @xenova/transformers for embeddings,
 * qdrant.search() (not .query()) against the policy_articles collection.
 */

const { pipeline } = require('@xenova/transformers');
const { QdrantClient } = require('@qdrant/js-client-rest');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});
const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';

// The 3 modules that actually have live data today. Find Opportunities,
// Competitive Radar, and Voice of Customer aren't built yet -- add their
// module_id values here once they exist, no other change needed.
const LIVE_MODULE_IDS = [
  '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960', // Policy & Risk
  '55c5ee19-bfca-468b-81b3-b89ca4f303c8', // Market Dynamics
  '2eb989fd-0ea0-4320-b73a-f7eb8b970473', // Forward Outlook
];

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return embedderPromise;
};

async function embedText(text) {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Searches the client's own data across all existing modules for a given
 * question, scored and deduplicated by article.
 *
 * @param {string} question
 * @param {string} clientId
 * @param {string} industry
 * @param {number} limitPerModule - how many hits to pull per module before merging
 * @returns {Promise<Array>} matching chunks with payload (title, url, chunk_text, module_id, ...)
 */
async function retrieveClientData(question, clientId, industry, limitPerModule = 10) {
  const questionVector = await embedText(question);

  const allResults = [];
  for (const moduleId of LIVE_MODULE_IDS) {
    const results = await qdrant.search(POLICY_COLLECTION, {
      vector: questionVector,
      limit: limitPerModule,
      filter: {
        must: [
          { key: 'client_id', match: { value: clientId } },
          { key: 'industry', match: { value: industry } },
          { key: 'module_id', match: { value: moduleId } },
        ],
      },
      with_payload: true,
    });
    allResults.push(...results);
  }

  // Same relevance floor ragChat.js uses, then dedupe by article/title and
  // sort by score so the strongest matches across all modules come first.
  const filtered = allResults.filter(r => r.score >= 0.20);
  const seen = new Set();
  const deduped = [];
  for (const r of filtered.sort((a, b) => b.score - a.score)) {
    const key = r.payload.url || r.payload.title;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  return deduped;
}

module.exports = { retrieveClientData, embedText, LIVE_MODULE_IDS };