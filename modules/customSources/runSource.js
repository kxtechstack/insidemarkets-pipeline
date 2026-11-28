/**
 * modules/customSources/runSource.js
 *
 * Runs all the steps for one custom source, in order:
 *
 *   1. receiveSource  load the row and check it
 *   2. fetchSource    get the file or page, safely
 *   3. readText       turn it into text parts with page numbers
 *   4. checkText      is the text good enough? (failed = stop here, nothing saved)
 *   5. cutPieces      cut into pieces for search
 *   6. saveSource     save the pieces and vectors (new version first, then remove the old)
 *   7. reportRun      tell the admin console: tick or Retry, and the log message
 *
 * Every run ends with a report, also when something breaks. A problem we
 * know (SourceError) shows its plain message. Anything else shows
 * "Something went wrong" plus the error text.
 *
 * One source runs only once at a time (in this server).
 */

const { receiveSource } = require('./receiveSource');
const { fetchSource } = require('./fetchSource');
const { readText } = require('./readText');
const { checkText } = require('./checkText');
const { cutPieces } = require('./cutPieces');
const { saveSource } = require('./saveSource');
const { reportRun } = require('./reportRun');
const { SourceError } = require('./sourceError');

const running = new Set();
const isRunning = (sourceId) => running.has(sourceId);

/**
 * @param {string} sourceId
 * @param {object} [deps]  passed on to each step (the tests pass fake ones)
 * @returns {{ status, message, documentId, pieceCount }}
 */
async function runSource(sourceId, deps = {}) {
  if (running.has(sourceId)) return { status: 'skipped', message: 'This source is already running.' };
  running.add(sourceId);
  const startedAt = Date.now();
  let job = null;
  let result;

  try {
    job = await receiveSource(sourceId, deps);
    const fetched = await fetchSource(job, deps);
    const read = await readText(job, fetched, deps);
    const check = checkText(fetched, read);

    if (check.status === 'failed') {
      result = { status: 'failed', message: check.message, documentId: null, pieceCount: 0 };
    } else {
      const cut = cutPieces(job, read);
      if (cut.pieces.length === 0) {
        result = { status: 'failed', message: `${check.message} No pieces could be made from the text.`, documentId: null, pieceCount: 0 };
      } else {
        const saved = await saveSource({ job, read, check, cut }, deps);
        result = {
          status: check.status, // ok or warning
          message: [check.message, ...cut.notes, ...saved.notes].join(' '),
          documentId: saved.documentId,
          pieceCount: saved.pieceCount,
        };
      }
    }
  } catch (e) {
    const known = e instanceof SourceError;
    if (!known) console.error(`[CustomSources] Run of ${sourceId} broke:`, e);
    if (!job && e.source) job = e.source; // the row was read before the problem: log under its client
    result = {
      status: 'failed',
      message: known ? e.message : `Something went wrong while reading this source: ${e.message}`,
      documentId: null,
      pieceCount: 0,
      code: known ? e.code : 'ERROR',
    };
  } finally {
    running.delete(sourceId);
  }

  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  result.message = `${result.message} (${seconds} s)`.trim();
  await reportRun({
    sourceId: (job && job.sourceId) || sourceId,
    clientId: job && job.clientId,
    sourceName: job && job.sourceName,
    status: result.status,
    message: result.message,
    documentId: result.documentId,
  }, deps).catch((e) => console.error(`[CustomSources] Report failed: ${e.message}`));

  console.log(`[CustomSources] ${job ? `"${job.sourceName}"` : sourceId}: ${result.status}, ${result.pieceCount} pieces. ${result.message}`);
  return result;
}

module.exports = { runSource, isRunning };
