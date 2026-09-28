/**
 * modules/decisionIntelligence/customSourceRetrieval.js
 *
 * Retrieves relevant chunks from the client's UPLOADED custom data sources
 * (PDFs / websites / plain text), stored in Qdrant collection
 * `custom_source_content` by modules/customSourceProcessor.js.
 *
 * Distinct from retrieveClientData.js:
 *   - retrieveClientData searches `policy_articles` (ingested pipeline signals)
 *   - THIS searches `custom_source_content` (client-uploaded documents)
 *
 * Payload schema (confirmed live on 2026-09-28):
 *   {
 *     content_id, client_id, source_id, source_name, source_type,
 *     title, chunk_index, chunk_text
 *   }
 *
 * NOTE: no `industry`, `module_id`, `url`, `article_id`, or `published_date`
 * on these payloads. So this function filters by client_id ONLY.
 *
 * Score floor: measured live -- the genuinely-relevant hit for a real
 * question scored 0.427, with relevant-but-weaker hits in the 0.33-0.39
 * range. Random noise sits below ~0.25. Default floor of 0.30 catches
 * the good hits without flooding the LLM with noise.
 */

const { QdrantClient } = require('@qdrant/js-client-rest');
const { embedText } = require('./retrieveClientData');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const CUSTOM_SOURCE_COLLECTION =
  process.env.CUSTOM_SOURCE_QDRANT_COLLECTION || 'custom_source_content';

const DEFAULT_MIN_SCORE = Number(process.env.CUSTOM_SOURCE_SCORE_FLOOR) || 0.30;
const DEFAULT_LIMIT = Number(process.env.CUSTOM_SOURCE_TOP_K) || 3;

/**
 * @param {string} question
 * @param {string} clientId
 * @param {number} [limit]      max chunks to return (default 3)
 * @param {number} [minScore]   cosine similarity floor (default 0.30)
 * @returns {Promise<Array>}    array of { id, score, payload } -- same shape
 *                              as retrieveClientData's return, so downstream
 *                              code can treat them uniformly
 */
async function retrieveCustomSourceData(
  question,
  clientId,
  limit = DEFAULT_LIMIT,
  minScore = DEFAULT_MIN_SCORE
) {
  if (!question || !clientId) return [];

  try {
    const vector = await embedText(question);

    // Over-fetch, then dedupe by content_id so one document can't dominate
    // the context with several near-identical chunks.
    const hits = await qdrant.search(CUSTOM_SOURCE_COLLECTION, {
      vector,
      limit: limit * 3,
      filter: {
        must: [{ key: 'client_id', match: { value: clientId } }],
      },
      with_payload: true,
    });

    const passing = hits.filter((h) => h.score >= minScore);

    const seenContentIds = new Set();
    const deduped = [];
    for (const h of passing) {
      const cid = h.payload?.content_id;
      if (!cid) continue;
      if (seenContentIds.has(cid)) continue;
      seenContentIds.add(cid);
      deduped.push(h);
      if (deduped.length >= limit) break;
    }

    console.log(
      `[customSourceRetrieval] query="${String(question).slice(0, 60)}" | ` +
      `${hits.length} raw hits, ${passing.length} above ${minScore}, ` +
      `${deduped.length} after dedupe`
    );
    deduped.forEach((d, i) => {
      console.log(
        `  [${i + 1}] score=${d.score.toFixed(3)} | source="${d.payload.source_name}" ` +
        `| chunk ${d.payload.chunk_index}`
      );
    });

    return deduped;
  } catch (err) {
    // Never throw -- a custom-source hiccup must not break the chat.
    console.log(`[customSourceRetrieval] Search failed: ${err.message}`);
    return [];
  }
}

module.exports = { retrieveCustomSourceData, CUSTOM_SOURCE_COLLECTION };