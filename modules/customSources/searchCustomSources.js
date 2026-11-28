/**
 * modules/customSources/searchCustomSources.js
 *
 * Finds the pieces of a client's custom sources that best match a question.
 * Search by meaning only (no AI writing here). Used now by the test script
 * scripts/askCustomSources.js, and later by the DI chat (step 8, search).
 *
 * In:  { question, clientId, limit?, sourceIds? }
 * Out: [ { score, sourceId, documentId, sourceName, title, heading, sheet,
 *          pageFrom, pageTo, pieceNo, text, url, publishedAt, readAt } ]   best first
 *
 * Rules:
 *   - Always filtered by client_id. A client never sees another client's pieces.
 *   - Only pieces of documents that still exist in custom_source_documents.
 *     So an old version, or a source deleted in the admin console, never
 *     shows up, even when its vectors are still in Qdrant.
 *   - The same text twice (the same file added twice) is shown once.
 *   - The question is turned into a vector with the same model as the pieces.
 *   - Pieces below SEARCH_MIN_SCORE are left out.
 */

const { QDRANT_COLLECTION, SEARCH_LIMIT, SEARCH_MIN_SCORE } = require('./customSourceConfig');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let shared = null;
function realDeps() {
  if (!shared) {
    const { createClient } = require('@supabase/supabase-js');
    const { QdrantClient } = require('@qdrant/js-client-rest');
    shared = {
      db: createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY),
      qdrant: new QdrantClient({
        url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false, timeout: 20000,
      }),
      embed: require('./embedText').embedText,
    };
  }
  return shared;
}

// The ids of the client's documents that exist now (one per source)
async function liveDocumentIds(db, clientId, sourceIds) {
  let query = db.from('custom_source_documents').select('id').eq('client_id', clientId);
  if (Array.isArray(sourceIds) && sourceIds.length) query = query.in('source_id', sourceIds);
  const { data, error } = await query;
  if (error) throw new Error(`Could not read the custom source documents: ${error.message}`);
  return (data || []).map((d) => d.id);
}

/**
 * @param {object} input  { question, clientId, limit, sourceIds }
 * @param {object} [deps] { db, qdrant, embed }
 */
async function searchCustomSources({ question, clientId, limit = SEARCH_LIMIT, sourceIds = null }, deps = {}) {
  const text = String(question || '').trim();
  if (!text) throw new Error('searchCustomSources: the question is empty');
  if (!UUID.test(String(clientId || ''))) throw new Error('searchCustomSources: a valid clientId is needed');

  const real = deps.db && deps.qdrant && deps.embed ? null : realDeps();
  const db = deps.db || real.db;
  const qdrant = deps.qdrant || real.qdrant;
  const embed = deps.embed || real.embed;

  const documentIds = await liveDocumentIds(db, clientId, sourceIds);
  if (documentIds.length === 0) return [];

  const vector = await embed(text);
  let hits;
  try {
    hits = await qdrant.search(QDRANT_COLLECTION, {
      vector,
      limit: limit * 2, // room for repeats that are dropped below
      score_threshold: SEARCH_MIN_SCORE,
      with_payload: true,
      filter: {
        must: [
          { key: 'client_id', match: { value: clientId } },
          { key: 'document_id', match: { any: documentIds } },
        ],
      },
    });
  } catch (e) {
    if (/not found|doesn't exist/i.test(e.message)) return []; // no source was ever saved
    throw e;
  }

  const seen = new Set();
  const results = [];
  for (const h of hits) {
    if (!h.payload || h.payload.client_id !== clientId) continue; // belt and braces
    const key = String(h.payload.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (seen.has(key)) continue; // the same text again
    seen.add(key);
    results.push({
      score: Math.round(h.score * 1000) / 1000,
      sourceId: h.payload.source_id,
      documentId: h.payload.document_id,
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
    });
    if (results.length >= limit) break;
  }
  return results;
}

module.exports = { searchCustomSources };
