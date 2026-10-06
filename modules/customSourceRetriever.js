const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@xenova/transformers');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const CUSTOM_COLLECTION = process.env.CUSTOM_SOURCE_QDRANT_COLLECTION || 'custom_source_content';
const TOP_K = Number(process.env.CUSTOM_RETRIEVAL_TOP_K) || 6;
const MIN_SCORE = Number(process.env.CUSTOM_RETRIEVAL_MIN_SCORE) || 0.3;

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return embedderPromise;
};

const embedQuery = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

const retrieveCustomChunks = async (question, clientId) => {
  const vector = await embedQuery(question);

  const results = await qdrant.search(CUSTOM_COLLECTION, {
    vector,
    limit: TOP_K,
    score_threshold: MIN_SCORE,
    with_payload: true,
    filter: {
      must: [{ key: 'client_id', match: { value: clientId } }],
    },
  });

  return results.map(r => ({
    score: r.score,
    source_name: r.payload.source_name,
    title: r.payload.title,
    chunk_index: r.payload.chunk_index,
    text: r.payload.chunk_text,
  }));
};

module.exports = { retrieveCustomChunks };