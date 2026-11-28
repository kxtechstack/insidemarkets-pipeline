/**
 * modules/customSources/deleteSource.js
 *
 * Removes a custom source everywhere, so nothing is left behind for the
 * chat to find:
 *
 *   1. the search data in Qdrant (all pieces of the source)
 *   2. the saved text (custom_source_documents; the pieces go with them)
 *   3. the uploaded file in storage (custom-source-files)
 *   4. the source row in the admin console (admin.custom_data_sources)
 *
 * The order matters. If step 1 or 2 fails we STOP and keep the row, so the
 * admin can press Delete again. A stray file in storage (step 3) is noted
 * but does not stop the delete: the chat never reads storage.
 * The run log rows stay (their link to the source becomes empty).
 *
 * Also when the row is already gone (the admin console removed it first),
 * steps 1 to 3 still run for that source id, so the leftovers are cleaned.
 *
 * deleteClientSources does the same for every source of one client
 * (used before a client is deleted).
 */

const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { QDRANT_COLLECTION, STORAGE_BUCKET } = require('./customSourceConfig');
const { isRunning } = require('./runSource');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_LIST_PAGE = 1000;
const STORAGE_MAX_DEPTH = 3;

let shared = null;
function realDeps() {
  if (!shared) {
    shared = {
      db: createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY),
      qdrant: new QdrantClient({
        url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false, timeout: 20000,
      }),
    };
  }
  return shared;
}
const depsOf = (deps) => {
  const real = deps.db && deps.qdrant ? null : realDeps();
  return { db: deps.db || real.db, qdrant: deps.qdrant || real.qdrant };
};

// Sources being deleted now (Run now waits for these)
const deleting = new Set();
const isDeleting = (id) => deleting.has(id);

class DeleteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// 1. Qdrant. A collection that does not exist yet = nothing to remove.
async function removeVectors(qdrant, key, value) {
  try {
    await qdrant.delete(QDRANT_COLLECTION, { wait: true, filter: { must: [{ key, match: { value } }] } });
  } catch (e) {
    if (/not.?found|doesn.?t exist|does not exist|404/i.test(String(e.message))) return;
    throw new DeleteError(500, `The search data could not be removed (${e.message}). Nothing else was deleted. Please try again.`);
  }
}

// 2. The saved text (the pieces go with the documents: on delete cascade)
async function removeDocuments(db, column, value) {
  const { error } = await db.from('custom_source_documents').delete().eq(column, value);
  if (error) throw new DeleteError(500, `The saved text could not be removed (${error.message}). The search data is already gone. Please try again.`);
}

// 3. Files in storage. Never throws: returns a note on a problem.
async function removeFiles(db, paths) {
  const list = paths.map((p) => String(p || '').replace(/^\/+/, '')).filter(Boolean);
  if (!list.length) return null;
  try {
    const { error } = await db.storage.from(STORAGE_BUCKET).remove(list);
    if (error) return `The uploaded file could not be removed from storage (${error.message}).`;
  } catch (e) {
    return `The uploaded file could not be removed from storage (${e.message}).`;
  }
  return null;
}

// every file under a folder of the bucket (folders inside it too)
async function filesUnder(db, folder, depth = 0) {
  const out = [];
  for (let offset = 0; ; offset += STORAGE_LIST_PAGE) {
    const { data, error } = await db.storage.from(STORAGE_BUCKET).list(folder, { limit: STORAGE_LIST_PAGE, offset });
    if (error) throw new Error(error.message);
    for (const item of data || []) {
      const full = `${folder}/${item.name}`;
      if (item.id) out.push(full);
      else if (depth < STORAGE_MAX_DEPTH) out.push(...await filesUnder(db, full, depth + 1));
    }
    if (!data || data.length < STORAGE_LIST_PAGE) break;
  }
  return out;
}

/**
 * @returns {{ deleted: true, sourceId, rowFound, notes }}
 * @throws DeleteError (status 400 / 409 / 500, message for the admin)
 */
async function deleteSource(sourceId, deps = {}) {
  if (!UUID.test(String(sourceId || ''))) throw new DeleteError(400, 'Not a valid source id');
  if (isRunning(sourceId)) throw new DeleteError(409, 'This source is running now. Please wait until it ends, then delete it.');
  if (deleting.has(sourceId)) throw new DeleteError(409, 'This source is already being deleted.');
  deleting.add(sourceId);
  try {
    const { db, qdrant } = depsOf(deps);
    const { data: row, error } = await db.schema('admin').from('custom_data_sources')
      .select('id, client_id, storage_path').eq('id', sourceId).maybeSingle();
    if (error) throw new DeleteError(500, `Could not read the source: ${error.message}`);

    await removeVectors(qdrant, 'source_id', sourceId);
    await removeDocuments(db, 'source_id', sourceId);
    const notes = [];
    const fileNote = await removeFiles(db, [row && row.storage_path]);
    if (fileNote) notes.push(fileNote);

    if (row) {
      const { error: rowError } = await db.schema('admin').from('custom_data_sources').delete().eq('id', sourceId);
      if (rowError) throw new DeleteError(500, `The search data and text were removed, but the source row could not be deleted (${rowError.message}). Please try again.`);
    }
    console.log(`[CustomSources] Deleted source ${sourceId}${row ? '' : ' (row was already gone, leftovers cleaned)'}${notes.length ? `: ${notes.join(' ')}` : ''}`);
    return { deleted: true, sourceId, rowFound: Boolean(row), notes };
  } finally {
    deleting.delete(sourceId);
  }
}

/**
 * Every source of one client: search data, saved text, the client's storage
 * folder, the source rows. The client row itself is NOT touched.
 * @returns {{ deleted: true, clientId, sources, files, notes }}
 */
async function deleteClientSources(clientId, deps = {}) {
  if (!UUID.test(String(clientId || ''))) throw new DeleteError(400, 'Not a valid client id');
  const { db, qdrant } = depsOf(deps);
  const { data: rows, error } = await db.schema('admin').from('custom_data_sources')
    .select('id, storage_path').eq('client_id', clientId);
  if (error) throw new DeleteError(500, `Could not read the sources of this client: ${error.message}`);
  const ids = (rows || []).map((r) => r.id);
  const busy = ids.filter((id) => isRunning(id) || deleting.has(id));
  if (busy.length) throw new DeleteError(409, `${busy.length} sources of this client are running or being deleted now. Please wait, then try again.`);
  ids.forEach((id) => deleting.add(id));
  try {
    await removeVectors(qdrant, 'client_id', clientId);
    await removeDocuments(db, 'client_id', clientId);

    const notes = [];
    let files = [];
    try {
      files = await filesUnder(db, clientId);
    } catch (e) {
      notes.push(`The files in storage could not be listed (${e.message}).`);
    }
    // also files saved outside the client's folder (older uploads)
    const paths = [...new Set([...files, ...(rows || []).map((r) => String(r.storage_path || '').replace(/^\/+/, '')).filter(Boolean)])];
    const fileNote = await removeFiles(db, paths);
    if (fileNote) notes.push(fileNote);

    if (ids.length) {
      const { error: rowError } = await db.schema('admin').from('custom_data_sources').delete().eq('client_id', clientId);
      if (rowError) throw new DeleteError(500, `The search data and text were removed, but the source rows could not be deleted (${rowError.message}). Please try again.`);
    }
    console.log(`[CustomSources] Deleted ${ids.length} sources of client ${clientId} (${paths.length} files)${notes.length ? `: ${notes.join(' ')}` : ''}`);
    return { deleted: true, clientId, sources: ids.length, files: fileNote ? 0 : paths.length, notes };
  } finally {
    ids.forEach((id) => deleting.delete(id));
  }
}

module.exports = { deleteSource, deleteClientSources, isDeleting, DeleteError };
