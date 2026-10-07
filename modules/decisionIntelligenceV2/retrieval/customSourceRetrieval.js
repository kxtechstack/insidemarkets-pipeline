/**
 * modules/decisionIntelligenceV2/retrieval/customSourceRetrieval.js
 *
 * Retrieves chunks from the client's uploaded documents
 * (Qdrant collection: custom_source_content).
 *
 * Mirrors the existing modules/decisionIntelligence/customSourceRetrieval.js
 * but stripped to what V2 needs — no URL enrichment yet (added at Stage 6).
 */

const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@xenova/transformers');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const CUSTOM_COLLECTION =
  process.env.CUSTOM_SOURCE_QDRANT_COLLECTION || 'custom_source_content';

const DEFAULT_LIMIT = Number(process.env.CUSTOM_SOURCE_TOP_K) || 10;
const DEFAULT_MIN_SCORE = Number(process.env.CUSTOM_SOURCE_SCORE_FLOOR) || 0.28;

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedderPromise;
};

const embedText = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

async function retrieveCustomSourceHits(question, clientId, opts = {}) {
  const limit    = opts.limit    ?? DEFAULT_LIMIT;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;

  if (!question || !clientId) return [];

  try {
    const vector = await embedText(question);
    const hits = await qdrant.search(CUSTOM_COLLECTION, {
      vector,
      limit: Math.max(limit * 3, 20),
      filter: { must: [{ key: 'client_id', match: { value: clientId } }] },
      with_payload: true,
    });

    const passing = hits.filter((h) => h.score >= minScore);

    const seen = new Set();
    const out = [];
    for (const h of passing) {
      const cid = h.payload?.content_id;
      const ci = h.payload?.chunk_index;
      if (cid === undefined || ci === undefined) continue;
      const key = `${cid}:${ci}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(h);
      if (out.length >= limit) break;
    }

    return out;
  } catch (err) {
    console.log(`[customSourceRetrieval] search failed: ${err.message}`);
    return [];
  }
}

module.exports = { retrieveCustomSourceHits, CUSTOM_COLLECTION };