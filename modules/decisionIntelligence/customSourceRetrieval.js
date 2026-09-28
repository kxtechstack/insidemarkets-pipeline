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

const DEFAULT_MIN_SCORE = Number(process.env.CUSTOM_SOURCE_SCORE_FLOOR) || 0.28;
const DEFAULT_LIMIT = Number(process.env.CUSTOM_SOURCE_TOP_K) || 5;

async function retrieveCustomSourceData(
  question,
  clientId,
  limit = DEFAULT_LIMIT,
  minScore = DEFAULT_MIN_SCORE
) {
  if (!question || !clientId) return [];

  try {
    const vector = await embedText(question);

    const hits = await qdrant.search(CUSTOM_SOURCE_COLLECTION, {
      vector,
      limit: limit * 3,
      filter: {
        must: [{ key: 'client_id', match: { value: clientId } }],
      },
      with_payload: true,
    });

    const passing = hits.filter((h) => h.score >= minScore);

    // Dedupe by (content_id, chunk_index) PROXIMITY, not by content_id alone.
    // A single uploaded document shares one content_id across all its
    // chunks -- deduping by content_id alone collapses the entire document
    // to a single chunk, which loses most of the content. Instead, keep
    // multiple chunks from the same document, skipping only ADJACENT
    // chunks (index N and N+1) which are near-duplicates because of the
    // 50-word chunk overlap.
    const seenKeys = new Set();
    const deduped = [];
    for (const h of passing) {
      const cid = h.payload?.content_id;
      const ci = h.payload?.chunk_index;
      if (cid === undefined || ci === undefined) continue;

      const thisKey = `${cid}:${ci}`;
      const prevKey = `${cid}:${ci - 1}`;
      const nextKey = `${cid}:${ci + 1}`;

      if (
        seenKeys.has(thisKey) ||
        seenKeys.has(prevKey) ||
        seenKeys.has(nextKey)
      ) {
        continue;
      }
      seenKeys.add(thisKey);
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
    console.log(`[customSourceRetrieval] Search failed: ${err.message}`);
    return [];
  }
}

module.exports = { retrieveCustomSourceData, CUSTOM_SOURCE_COLLECTION };