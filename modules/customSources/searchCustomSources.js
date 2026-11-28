/**
 * modules/customSources/searchCustomSources.js
 *
 * Finds the pieces of a client's custom sources that best match a question.
 * No AI writing here. Used now by the test script scripts/askCustomSources.js,
 * and later by the DI chat (step 8, search).
 *
 * Two searches, then combined:
 *   1. Meaning search (Qdrant): pieces that mean the same as the question.
 *   2. Word search (Postgres, custom_source_word_search): pieces that share
 *      the question's words. Words come from the client's own pieces, grammar
 *      from Postgres's English dictionary ("driving" = "drive"). Rare words
 *      count more, heading words count double. No word list of ours.
 *   Combined: a piece gets 1 / (SEARCH_MIX_K + its place) from each list it is
 *   in. A piece high in either list comes up; a piece in both comes up most.
 *   If word search is not there (SQL not run) or fails, meaning search alone
 *   is used, and the result says so (wordSearch: 'off').
 *
 * In:  { question, clientId, limit?, sourceIds? }
 * Out: { results: [ { score, meaningScore, wordPlace, sourceId, documentId, sourceName, title,
 *                     heading, sheet, pageFrom, pageTo, pieceNo, text, url, publishedAt, readAt } ],
 *        wordSearch: 'on' | 'off', wordSearchProblem }
 *
 * Rules:
 *   - Always filtered by client_id. A client never sees another client's pieces.
 *   - Only pieces of documents that still exist in custom_source_documents.
 *   - The same text twice (the same file added twice) is shown once.
 */

const {
  QDRANT_COLLECTION, SEARCH_LIMIT, SEARCH_MIN_SCORE, SEARCH_POOL, SEARCH_MIX_K, WORD_SEARCH_FUNCTION,
} = require('./customSourceConfig');

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

// 1. Meaning search: [{ id, score, payload }]
async function meaningSearch(qdrant, embed, question, clientId, documentIds) {
  const vector = await embed(question);
  try {
    return await qdrant.search(QDRANT_COLLECTION, {
      vector,
      limit: SEARCH_POOL,
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
}

// 2. Word search: { ids: [piece ids, best first], problem }
async function wordSearch(db, question, clientId, documentIds) {
  try {
    const { data, error } = await db.rpc(WORD_SEARCH_FUNCTION, {
      p_client_id: clientId, p_query: question, p_document_ids: documentIds, p_limit: SEARCH_POOL,
    });
    if (error) return { ids: [], problem: error.message };
    return { ids: (data || []).map((row) => row.id), problem: null };
  } catch (e) {
    return { ids: [], problem: e.message };
  }
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
  if (documentIds.length === 0) return { results: [], wordSearch: 'on', wordSearchProblem: null };

  const [meaningHits, words] = await Promise.all([
    meaningSearch(qdrant, embed, text, clientId, documentIds),
    wordSearch(db, text, clientId, documentIds),
  ]);

  // Combine the two lists
  const byId = new Map();
  const entry = (id) => {
    if (!byId.has(id)) byId.set(id, { id, score: 0, meaningScore: null, wordPlace: null, payload: null });
    return byId.get(id);
  };
  meaningHits.forEach((hit, i) => {
    const e = entry(String(hit.id));
    e.score += 1 / (SEARCH_MIX_K + i + 1);
    e.meaningScore = Math.round(hit.score * 1000) / 1000;
    e.payload = hit.payload;
  });
  words.ids.forEach((id, i) => {
    const e = entry(String(id));
    e.score += 1 / (SEARCH_MIX_K + i + 1);
    e.wordPlace = i + 1;
  });

  // Pieces found only by words: get their text from Qdrant (the point id is the piece id)
  const missing = [...byId.values()].filter((e) => !e.payload).map((e) => e.id);
  if (missing.length) {
    const points = await qdrant.retrieve(QDRANT_COLLECTION, { ids: missing, with_payload: true, with_vector: false });
    for (const point of points) {
      const e = byId.get(String(point.id));
      if (e) e.payload = point.payload;
    }
  }

  const ranked = [...byId.values()]
    .filter((e) => e.payload && e.payload.client_id === clientId && documentIds.includes(e.payload.document_id)) // belt and braces
    .sort((p, q) => q.score - p.score);

  const seen = new Set();
  const results = [];
  for (const e of ranked) {
    const key = String(e.payload.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (seen.has(key)) continue; // the same text again
    seen.add(key);
    const p = e.payload;
    results.push({
      score: Math.round(e.score * 10000) / 10000,
      meaningScore: e.meaningScore,
      wordPlace: e.wordPlace,
      sourceId: p.source_id,
      documentId: p.document_id,
      sourceName: p.source_name,
      title: p.title,
      heading: p.heading || null,
      sheet: p.sheet || null,
      pageFrom: p.page_from ?? null,
      pageTo: p.page_to ?? null,
      pieceNo: p.piece_no,
      text: p.text,
      url: p.url || null,
      publishedAt: p.published_at || null,
      readAt: p.read_at || null,
    });
    if (results.length >= limit) break;
  }

  return { results, wordSearch: words.problem ? 'off' : 'on', wordSearchProblem: words.problem };
}

module.exports = { searchCustomSources };
