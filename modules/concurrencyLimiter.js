/**
 * concurrencyLimiter.js
 * =======================
 * Simple in-process semaphore that caps how many pipelines can be inside
 * the LLM classification stage at the same time. Fetch/dedup/quality-filter
 * stages are NOT gated -- only the LLM stage, since that's what actually
 * hits Novita's rate limit. Jobs queue here and wait their turn instead of
 * all firing simultaneously.
 */

const MAX_CONCURRENT_LLM_JOBS = Number(process.env.MAX_CONCURRENT_LLM_JOBS) || 3;

let activeCount = 0;
const waitQueue = [];

// Call before starting LLM processing. Resolves once a slot is free.
const acquireLLMSlot = (jobId) => {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeCount < MAX_CONCURRENT_LLM_JOBS) {
        activeCount++;
        console.log(`[ConcurrencyLimiter] ${jobId} acquired slot (${activeCount}/${MAX_CONCURRENT_LLM_JOBS} active)`);
        resolve();
      } else {
        console.log(`[ConcurrencyLimiter] ${jobId} waiting for slot (${activeCount}/${MAX_CONCURRENT_LLM_JOBS} active, ${waitQueue.length} queued ahead)`);
        waitQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
};

// Call in a finally{} block after LLM processing completes (success or fail).
const releaseLLMSlot = (jobId) => {
  activeCount = Math.max(0, activeCount - 1);
  console.log(`[ConcurrencyLimiter] ${jobId} released slot (${activeCount}/${MAX_CONCURRENT_LLM_JOBS} active)`);
  const next = waitQueue.shift();
  if (next) next();
};

module.exports = { acquireLLMSlot, releaseLLMSlot };