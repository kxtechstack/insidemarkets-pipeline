/**
 * modules/customSources/reportRun.js
 *
 * Step 7 of reading a custom source: tell the admin console how it went.
 *
 *   admin.custom_data_sources  last_run_status = success / failed (the green tick or the Retry button)
 *                              last_run_at     = now (the admin console waits for this to change)
 *                              last_article_id = the new document id (only when it worked)
 *   custom_source_run_log      one row: status success / warning / failed, and the full message
 *
 * A warning still counts as "success" on the source row, because the text
 * was saved. The warning itself is in the log row.
 *
 * Reporting never throws: if it fails, it is written to the server log.
 */

const { createClient } = require('@supabase/supabase-js');
const { LOG_MESSAGE_MAX_CHARS } = require('./customSourceConfig');

let sharedDb = null;
function defaultDb() {
  if (!sharedDb) sharedDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return sharedDb;
}

/**
 * @param {object} run { sourceId, clientId, sourceName, status: ok|warning|failed, message, documentId }
 * @param {object} [deps] { db }
 */
async function reportRun(run, deps = {}) {
  const db = deps.db || defaultDb();
  const worked = run.status !== 'failed';
  const message = String(run.message || '').slice(0, LOG_MESSAGE_MAX_CHARS);

  const update = { last_run_status: worked ? 'success' : 'failed', last_run_at: new Date().toISOString() };
  if (worked && run.documentId) update.last_article_id = run.documentId;
  const { error: rowError } = await db.schema('admin').from('custom_data_sources').update(update).eq('id', run.sourceId);
  if (rowError) console.error(`[CustomSources] Could not update the source row ${run.sourceId}: ${rowError.message}`);

  if (!run.clientId) return; // the source was not found, so there is no client to log under
  const { error: logError } = await db.from('custom_source_run_log').insert({
    source_id: run.sourceId,
    client_id: run.clientId,
    source_name: run.sourceName || null,
    status: run.status === 'ok' ? 'success' : run.status,
    error_message: message || null,
    content_id: worked ? run.documentId || null : null,
  });
  if (logError) console.error(`[CustomSources] Could not write the run log for ${run.sourceId}: ${logError.message}`);
}

module.exports = { reportRun };
