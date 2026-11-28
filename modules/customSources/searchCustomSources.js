/**
 * modules/customSources/searchCustomSources.js
 *
 * Finds the pieces of a client's custom sources that best match a question.
 * Search by meaning only (no AI writing here). Used now by the test script
 * scripts/askCustomSources.js, and later by the DI chat (step 8, search).
 *
 * In:  { question, clientId, limit?, sourceIds? }
 * Out: [ { score, sourceId, sourceName, title, heading, sheet, pageFrom, pageTo,
 *          pieceNo, text, url, publishedAt, readAt } ]   best first
 *
 * Rules:
 *   - Always filtered by client_id. A client never sees another client's pieces.
 *   - The question is turned into a vector with the same model as the pieces.
 *   - Pieces below SEARCH_MIN_SCORE are left out.
 */

const { QDRANT_COLLECTION, SEARCH_LIMIT, SEARCH_MIN_SCORE } = require('./customSourceConfig');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let shared = null;
function realDeps() {
  if (!shared) {
    const { QdrantClient } = require('@qdrant/js-client-rest');
    let embedFn = null;
    shared = {
      qdrant: new QdrantClient({
        url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false, timeout: 20000,
      }),
      async embed(text) {
        if (!embedFn) {
          try {
            const pipelineModule = require('../llmRelevanceProcessor');
            if (typeof pipelineModule.embedText === 'function') embedFn = pipelineModule.embedText;
          } catch (e) { /* below */ }
          if (!embedFn) {
            const { pipeline } = require('@xenova/transformers');
            const model = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
            embedFn = async (t) => Array.from((await (await model)(t, { pooling: 'mean', normalize: true })).data);
          }
        }
        return embedFn(text);
      },
    };
  }
  return shared;
}

/**
 * @param {object} input  { question, clientId, limit, sourceIds }
 * @param {object} [deps] { qdrant, embed }
 */
async function searchCustomSources({ question, clientId, limit = SEARCH_LIMIT, sourceIds = null }, deps = {}) {
  const text = String(question || '').trim();
  if (!text) throw new Error('searchCustomSources: the question is empty');
  if (!UUID.test(String(clientId || ''))) throw new Error('searchCustomSources: a valid clientId is needed');

  const real = deps.qdrant && deps.embed ? null : realDeps();
  const qdrant = deps.qdrant || real.qdrant;
  const embed = deps.embed || real.embed;

  const must = [{ key: 'client_id', match: { value: clientId } }];
  if (Array.isArray(sourceIds) && sourceIds.length) must.push({ key: 'source_id', match: { any: sourceIds } });

  const vector = await embed(text);
  let hits;
  try {
    hits = await qdrant.search(QDRANT_COLLECTION, {
      vector,
      limit,
      score_threshold: SEARCH_MIN_SCORE,
      with_payload: true,
      filter: { must },
    });
  } catch (e) {
    if (/not found|doesn't exist/i.test(e.message)) return []; // no source was ever saved
    throw e;
  }

  return hits
    .filter((h) => h.payload && h.payload.client_id === clientId) // belt and braces
    .map((h) => ({
      score: Math.round(h.score * 1000) / 1000,
      sourceId: h.payload.source_id,
      sourceName: h.payload.source_name,
      title: h.payload.title,
      heading: h.payload.heading || null,
      sheet: h.payload.sheet || null,
      pageFrom: h.payload.page_from ?? null,
      pageTo: h.payload.page_to ?? null,
      pieceNo: h.payload.piece_no,
      text: h.payload.text,
      url: h.payload.url || null,
      publishedAt: h.payload.published_at || null,
      readAt: h.payload.read_at || null,
    }));
}

module.exports = { searchCustomSources };
