/**
 * scripts/cleanCustomSourceVectors.js
 *
 * Finds search vectors in Qdrant (collection custom_source_pieces) whose
 * document no longer exists in custom_source_documents. That happens when a
 * source is deleted in the admin console (it deletes the database rows but
 * cannot reach Qdrant), or when a run broke half way.
 *
 * Run:
 *   node scripts/cleanCustomSourceVectors.js            only shows what it found
 *   node scripts/cleanCustomSourceVectors.js --delete   also deletes those vectors
 *
 * Search already ignores these vectors (it only uses live documents), so this
 * is housekeeping: it frees space and keeps Qdrant tidy.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { QDRANT_COLLECTION } = require('../modules/customSources/customSourceConfig');

async function main() {
  const doDelete = process.argv.includes('--delete');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false, timeout: 60000 });

  // 1. Every document id that has vectors in Qdrant (with its source name and client)
  const inQdrant = new Map(); // document_id -> { count, sourceName, clientId }
  let offset = null;
  do {
    const page = await qdrant.scroll(QDRANT_COLLECTION, {
      limit: 1000, offset, with_payload: ['document_id', 'source_name', 'client_id'], with_vector: false,
    });
    for (const point of page.points) {
      const id = point.payload.document_id;
      const entry = inQdrant.get(id) || { count: 0, sourceName: point.payload.source_name, clientId: point.payload.client_id };
      entry.count += 1;
      inQdrant.set(id, entry);
    }
    offset = page.next_page_offset;
  } while (offset !== null && offset !== undefined);

  // 2. Which of them still exist in Supabase
  const ids = [...inQdrant.keys()];
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('custom_source_documents').select('id').in('id', ids.slice(i, i + 200));
    if (error) throw new Error(`Could not read custom_source_documents: ${error.message}`);
    (data || []).forEach((d) => existing.add(d.id));
  }

  const orphans = ids.filter((id) => !existing.has(id));
  console.log(`\nQdrant has vectors for ${ids.length} documents. ${existing.size} still exist, ${orphans.length} do not.`);
  for (const id of orphans) {
    const e = inQdrant.get(id);
    console.log(`  no document: ${id}  "${e.sourceName}"  client ${e.clientId}  (${e.count} vectors)`);
  }
  if (!orphans.length) return;
  if (!doDelete) {
    console.log('\nNothing deleted. Run again with --delete to delete these vectors.');
    return;
  }
  for (let i = 0; i < orphans.length; i += 100) {
    await qdrant.delete(QDRANT_COLLECTION, { wait: true, filter: { must: [{ key: 'document_id', match: { any: orphans.slice(i, i + 100) } }] } });
  }
  console.log(`\nDeleted the vectors of ${orphans.length} documents that no longer exist.`);
}

main().catch((e) => {
  console.error('Clean-up crashed:', e.message);
  process.exitCode = 1;
});
