/**
 * modules/customSources/saveSource.js
 *
 * Step 6 of reading a custom source: save the pieces, safely.
 *
 * In:  job (receiveSource.js), read (readText.js), check (checkText.js), cut (cutPieces.js)
 * Out: { documentId, pieceCount, notes }
 *
 * What is saved:
 *   - custom_source_documents: one row (title, pages, characters, check result)
 *   - custom_source_pieces:    one row per piece (text, heading, pages ...)
 *   - Qdrant custom_source_pieces: one vector per piece, with client_id,
 *     source_id, document_id and the text, so search can filter by client.
 *
 * Safe swap (the old version stays until the new one is fully saved):
 *   1. Turn every piece into a vector first (nothing written yet).
 *   2. Write the new document row, the piece rows, then the vectors.
 *   3. Only now remove the old version (its rows and its vectors).
 *   If step 2 fails, the half-written new version is removed and the old
 *   version is still there. If step 3 fails, the run still works and the
 *   notes say an old copy was left (the next run removes it).
 *
 * The vectors use the same model and settings as the rest of the platform
 * (embedText.js), so the DI chat can search them later.
 */

const { randomUUID } = require('crypto');
const { QDRANT_COLLECTION, VECTOR_SIZE, QDRANT_BATCH, DB_BATCH } = require('./customSourceConfig');

// ── Real connections (the tests pass fake ones) ─────────────────────────
let shared = null;
function realDeps() {
  if (!shared) {
    const { createClient } = require('@supabase/supabase-js');
    const { QdrantClient } = require('@qdrant/js-client-rest');
    shared = {
      db: createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY),
      qdrant: new QdrantClient({
        url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false, timeout: 60000,
      }),
      embed: require('./embedText').embedText, // the same model and settings as the DI chat
    };
  }
  return shared;
}

// ── The Qdrant collection (made once, the first time it is needed) ──────
let collectionReady = null;
async function ensureCollection(qdrant) {
  const { collections } = await qdrant.getCollections();
  if (!collections.some((c) => c.name === QDRANT_COLLECTION)) {
    try {
      await qdrant.createCollection(QDRANT_COLLECTION, { vectors: { size: VECTOR_SIZE, distance: 'Cosine' } });
      console.log(`[CustomSources] Made the Qdrant collection "${QDRANT_COLLECTION}"`);
    } catch (e) {
      if (!/already exists/i.test(e.message)) throw e;
    }
  }
  for (const field of ['client_id', 'source_id', 'document_id']) {
    try {
      await qdrant.createPayloadIndex(QDRANT_COLLECTION, { field_name: field, field_schema: 'keyword', wait: true });
    } catch (e) {
      if (!/already exists/i.test(e.message)) console.log(`[CustomSources] Index note for "${field}": ${e.message}`);
    }
  }
}

// A database error with a hint when it is the "backend key" problem
function dbError(what, error) {
  const hint = /row-level security|permission denied/i.test(error.message)
    ? ' The backend key (SUPABASE_KEY) must be the service key, because these tables are closed to the browser key.'
    : '';
  return new Error(`${what}: ${error.message}.${hint}`);
}

async function inBatches(items, size, job) {
  for (let i = 0; i < items.length; i += size) await job(items.slice(i, i + size));
}

/**
 * @param {object} input { job, read, check, cut }
 * @param {object} [deps] { db, qdrant, embed }
 */
async function saveSource({ job, read, check, cut }, deps = {}) {
  const real = deps.db && deps.qdrant && deps.embed ? null : realDeps();
  const db = deps.db || real.db;
  const qdrant = deps.qdrant || real.qdrant;
  const embed = deps.embed || real.embed;
  const notes = [];
  const pieces = cut.pieces;
  if (pieces.length === 0) throw new Error('saveSource: there are no pieces to save');

  if (deps.qdrant) await ensureCollection(qdrant); // tests: every time
  else {
    if (!collectionReady) collectionReady = ensureCollection(qdrant).catch((e) => { collectionReady = null; throw e; });
    await collectionReady;
  }

  // 1. Vectors first: if the model fails, nothing is written
  const vectors = [];
  for (const piece of pieces) {
    const vector = await embed(piece.searchText);
    if (!Array.isArray(vector) || vector.length !== VECTOR_SIZE) {
      throw new Error(`saveSource: the search model gave a vector of size ${vector && vector.length}, expected ${VECTOR_SIZE}`);
    }
    vectors.push(vector);
  }

  // 2. Write the new version
  const documentId = randomUUID();
  const readAt = new Date().toISOString();
  try {
    const { error: docError } = await db.from('custom_source_documents').insert({
      id: documentId,
      source_id: job.sourceId,
      client_id: job.clientId,
      title: read.title || job.sourceName,
      page_count: read.pageCount || 0,
      char_count: check.summary.chars,
      piece_count: pieces.length,
      check_status: check.status,
      check_notes: check.message,
      read_at: readAt,
    });
    if (docError) throw dbError('Could not save the document row', docError);

    const rows = pieces.map((piece) => ({
      id: randomUUID(),
      document_id: documentId,
      source_id: job.sourceId,
      client_id: job.clientId,
      piece_no: piece.pieceNo,
      page_from: piece.pageFrom,
      page_to: piece.pageTo,
      heading: piece.heading,
      text: piece.text,
      word_count: piece.wordCount,
    }));
    await inBatches(rows, DB_BATCH, async (batch) => {
      const { error } = await db.from('custom_source_pieces').insert(batch);
      if (error) throw dbError('Could not save the piece rows', error);
    });

    const points = rows.map((row, i) => ({
      id: row.id,
      vector: vectors[i],
      payload: {
        client_id: job.clientId,
        source_id: job.sourceId,
        document_id: documentId,
        piece_id: row.id,
        piece_no: row.piece_no,
        source_name: job.sourceName,
        source_type: job.sourceType,
        title: read.title || job.sourceName,
        heading: pieces[i].heading,
        sheet: pieces[i].sheet,
        page_from: row.page_from,
        page_to: row.page_to,
        text: row.text,
        url: job.url || null,
        published_at: read.publishedAt || null,
        read_at: readAt,
      },
    }));
    await inBatches(points, QDRANT_BATCH, async (batch) => {
      await qdrant.upsert(QDRANT_COLLECTION, { wait: true, points: batch });
    });
  } catch (e) {
    // Remove the half-written new version. The old version is untouched.
    await qdrant.delete(QDRANT_COLLECTION, {
      wait: true, filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
    }).catch((err) => console.error(`[CustomSources] Could not remove new vectors after a failure: ${err.message}`));
    const { error: undoError } = await db.from('custom_source_documents').delete().eq('id', documentId);
    if (undoError) console.error(`[CustomSources] Could not remove the new document row after a failure: ${undoError.message}`);
    throw e;
  }

  // 3. The new version is complete: remove the old version(s) of this source
  try {
    await qdrant.delete(QDRANT_COLLECTION, {
      wait: true,
      filter: {
        must: [{ key: 'source_id', match: { value: job.sourceId } }],
        must_not: [{ key: 'document_id', match: { value: documentId } }],
      },
    });
  } catch (e) {
    notes.push(`An older copy of the search data could not be removed (${e.message}). The next run removes it.`);
  }
  const { error: oldError } = await db.from('custom_source_documents').delete()
    .eq('source_id', job.sourceId).neq('id', documentId);
  if (oldError) notes.push(`An older copy of the saved text could not be removed (${oldError.message}). The next run removes it.`);

  return { documentId, pieceCount: pieces.length, notes };
}

module.exports = { saveSource, ensureCollection };
