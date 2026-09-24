/**
 * processedQueue.js
 * ===================
 * After articles survive URL dedup, topic dedup, and quality filtering,
 * they get pushed into a SEPARATE Redis queue from the raw fetch queue.
 *
 * Raw queue   : raw:<jobId>        -- temporary holding for newly fetched
 *                                     articles, emptied during dedup/filter
 * Processed Q : processed:<jobId> -- final clean articles, ready to be
 *                                     pulled in batches for LLM relevance
 *                                     classification (tomorrow's work)
 *
 * Kept as its own module (separate from queueManager.js) so the raw-fetch
 * queue logic and the post-filter queue logic don't get tangled together.
 */

const { redis } = require('./queueManager');

const PROCESSED_QUEUE_EXPIRY_SECONDS = 86400; // 24 hours, same as raw queue

// Push the final, fully-filtered articles into the processed queue
const pushToProcessedQueue = async (articles, jobId) => {
  const queueKey = `processed:${jobId}`;

  if (!articles || articles.length === 0) {
    console.log(`[ProcessedQueue] No articles to push for ${queueKey} (0 survived filtering)`);
    return queueKey;
  }

  for (const article of articles) {
    await redis.rpush(queueKey, JSON.stringify(article));
  }

  await redis.expire(queueKey, PROCESSED_QUEUE_EXPIRY_SECONDS);

  console.log(`[ProcessedQueue] Pushed ${articles.length} clean articles to ${queueKey}`);
  return queueKey;
};

// Check how many articles are waiting in the processed queue
const getProcessedQueueLength = async (queueKey) => {
  return await redis.llen(queueKey);
};

// Pull a batch from the processed queue (this is what tomorrow's LLM step will use)
const pullProcessedBatch = async (queueKey, batchSize = 10) => {
  const batch = [];
  for (let i = 0; i < batchSize; i++) {
    const item = await redis.lpop(queueKey);
    if (!item) break;
    const article = typeof item === 'string' ? JSON.parse(item) : item;
    batch.push(article);
  }
  return batch;
};

// ── Reliable pull with crash recovery ────────────────────────────────────────
// Moves items from the main queue into a per-job "processing" list using
// RPOPLPUSH instead of a destructive LPOP. If the process crashes or stalls
// mid-batch, the article is still sitting in the processing list -- not
// lost -- and recoverProcessingList() below moves it back to the main
// queue on the next run.
const pullProcessedBatchReliable = async (queueKey, processingKey, batchSize = 10) => {
  const pulled = [];
  for (let i = 0; i < batchSize; i++) {
    const raw = await redis.rpoplpush(queueKey, processingKey);
    if (!raw) break;
    const article = typeof raw === 'string' ? JSON.parse(raw) : raw;
    pulled.push({ raw, article });
  }
  return pulled;
};

// Call once an article's outcome (completed/skipped/failed) has been
// successfully logged -- removes it from the processing list so it's no
// longer considered "in flight."
const clearFromProcessing = async (processingKey, rawItem) => {
  await redis.lrem(processingKey, 1, rawItem);
};

// Call BEFORE pulling any new batch for a job. Recovers any articles left
// stranded in the processing list by a previous crashed/stalled attempt
// (stale-job-watcher kill, container restart, unhandled exception) by
// pushing them back onto the main queue so they get picked up again
// instead of silently vanishing.
const recoverProcessingList = async (queueKey, processingKey) => {
  const leftover = await redis.lrange(processingKey, 0, -1);
  if (leftover.length > 0) {
    console.log(`[ProcessedQueue] Recovering ${leftover.length} in-flight article(s) from a previous crashed attempt`);
    for (const item of leftover) {
      await redis.rpush(queueKey, item);
    }
    await redis.del(processingKey);
  }
  return leftover.length;
};

module.exports = {
  pushToProcessedQueue,
  getProcessedQueueLength,
  pullProcessedBatch,
  pullProcessedBatchReliable,
  clearFromProcessing,
  recoverProcessingList
};