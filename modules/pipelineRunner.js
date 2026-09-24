/* pipelineRunner.js */
const { fetchArticles } = require('./fetcher');
const { sortByNewest, pushToQueue, readBatch, getQueueLength, setStatus } = require('./queueManager');
const { removeUrlDuplicates } = require('./deduplicator');
const { removeSameTopicArticles } = require('./topicDedup');
const { filterLowQualityArticles } = require('./qualityFilter');
const { pushToProcessedQueue } = require('./processedQueue');
const { startJobTracking, updateJobStage, markFullyCompleted, failJobTracking } = require('./jobStatusTracker');
const { acquireLLMSlot, releaseLLMSlot } = require('./concurrencyLimiter');

// CHANGED: runPipeline now takes moduleId, threads it through dedup calls
// and processQueueInBatches. Also tracks currentStage so a crash logs the
// REAL stage it failed at, instead of the hardcoded 'unknown' from before.
const runPipeline = async (jobId, clientId, promptText, industry, moduleId, submoduleId, source, lookbackDays = 90) => {

  let currentStage = 'starting'; // CHANGED: new — tracks real stage for failJobTracking

  try {

    await startJobTracking(jobId, clientId, promptText, submoduleId);
    const { recordJobContext } = require('./jobStatusTracker');
    await recordJobContext(jobId, industry, moduleId);
    await setStatus(jobId, { status: 'fetching', message: `Calling ${source} API...` });
    currentStage = 'fetching'; // CHANGED

    // Step 1 - Fetch from selected source
    const articles = await fetchArticles(source, promptText, lookbackDays);
    console.log(`\n========== PROMPT SENT TO ${source.toUpperCase()} ==========\n`);
    console.log(promptText);
    console.log("Industry:", industry);

    await updateJobStage(jobId, 'fetching', { fetched: articles.length });
    await setStatus(jobId, { status: 'sorting', total: articles.length, message: `Fetched ${articles.length} articles` });

    // Step 2 - Sort newest first
    const sorted = sortByNewest(articles);
    console.log("\n========== SORTED ARTICLES ==========\n");

    sorted.slice(0, 99).forEach((article, index) => {
      console.log(`${index + 1}. ${article.publishedDate} | ${article.title}`);
    });

    // Step 3 - Push to Redis RAW queue
    const queueKey = await pushToQueue(sorted, jobId);
    const queueLength = await getQueueLength(queueKey);

    console.log("Raw Queue Key:", queueKey);
    console.log("Raw Queue Length:", queueLength);

    await updateJobStage(jobId, 'queued', { rawQueueKey: queueKey });
    await setStatus(jobId, { status: 'queued', total: sorted.length, queueKey, message: 'Pushed to Redis raw queue' });
    currentStage = 'queued'; // CHANGED

    // Step 4 - URL dedup in batches of 10
    let allCleanArticles = [];
    let processedCount = 0;
    const totalRawCount = await getQueueLength(queueKey);
    let startIndex = 0;

    currentStage = 'url_dedup'; // CHANGED
    while (startIndex < totalRawCount) {
      const batch = await readBatch(queueKey, startIndex, 10);
      // CHANGED: removeUrlDuplicates now scoped by moduleId, not just clientId
      const afterUrlCheck = await removeUrlDuplicates(batch, clientId, moduleId);
      allCleanArticles.push(...afterUrlCheck);
      processedCount += batch.length;
      startIndex += 10;

      await setStatus(jobId, {
        status: 'deduplicating',
        total: sorted.length,
        processed: processedCount,
        remaining: Math.max(totalRawCount - processedCount, 0),
        message: `Processed ${processedCount}/${sorted.length} for URL duplicates`
      });
    }

    // Level 2 - Topic dedup
    await updateJobStage(jobId, 'url_dedup', { afterUrlCheck: allCleanArticles.length });
    await setStatus(jobId, {
      status: 'topic_dedup',
      total: sorted.length,
      message: 'Running embedding-based topic dedup check...'
    });
    currentStage = 'topic_dedup'; // CHANGED

    // CHANGED: removeSameTopicArticles now scoped by moduleId, not just clientId
    const finalArticles = await removeSameTopicArticles(allCleanArticles, clientId, moduleId);

    // Level 3 - Quality filter
    await updateJobStage(jobId, 'topic_dedup', { afterTopicDedup: finalArticles.length });
    await setStatus(jobId, {
      status: 'quality_filter',
      total: sorted.length,
      message: 'Running quality filter (length, language, freshness)...'
    });
    currentStage = 'quality_filter'; // CHANGED

    const qualityCheckedArticles = await filterLowQualityArticles(finalArticles);

    // Step 5 - Push to processed queue
    const processedQueueKey = await pushToProcessedQueue(qualityCheckedArticles, jobId);

    await updateJobStage(jobId, 'pushed_to_processed', {
      afterQualityFilter: qualityCheckedArticles.length,
      pushedToQueue: qualityCheckedArticles.length,
      processedQueueKey,
    });

    await setStatus(jobId, {
      status: 'llm_processing',
      total: sorted.length,
      processedQueueKey,
      message: `Waiting for LLM slot...`
    });
    currentStage = 'llm_processing'; // CHANGED

    await acquireLLMSlot(jobId); // NEW — waits here if too many jobs are already classifying

    await setStatus(jobId, {
      status: 'llm_processing',
      total: sorted.length,
      processedQueueKey,
      message: `Running LLM relevance classification on ${qualityCheckedArticles.length} articles for industry: ${industry}...`
    });

    // Step 6 - LLM relevance classification + signal extraction
    // CHANGED: processQueueInBatches now takes moduleId before submoduleId
    let llmResult;
    try {
      llmResult = await processQueueInBatches(processedQueueKey, clientId, industry, jobId, moduleId, submoduleId);
    } finally {
      releaseLLMSlot(jobId); // NEW — always release, even on throw
    }

    // NEW: circuit breaker abort -- LLM failed N times in a row, so we
    // stopped trying. Pause the job (don't mark complete) and let the
    // rate-limit watcher resume it later. The Redis processed-queue still
    // holds the unprocessed articles; extend its TTL to survive the pause.
    if (llmResult.aborted) {
      const BACKOFF_MINUTES = [60, 360, 720, 720]; // 1h, 6h, 12h, 12h
      const { getJobResumeAttempts, markJobPaused } = require('./jobStatusTracker');
      const existingAttempts = await getJobResumeAttempts(jobId);
      const backoffIdx = Math.min(existingAttempts, BACKOFF_MINUTES.length - 1);
      const backoffMin = BACKOFF_MINUTES[backoffIdx];
      const resumeAt = new Date(Date.now() + backoffMin * 60 * 1000).toISOString();

      await setStatus(jobId, {
        status: 'paused_rate_limited',
        total: sorted.length,
        afterLlmRelevant: llmResult.relevant,
        afterLlmIrrelevant: llmResult.irrelevant,
        message: `LLM rate limited — paused. Will resume in ${backoffMin} min (attempt ${existingAttempts + 1}).`,
      });

      await markJobPaused(jobId, {
        reason: llmResult.reason || 'Circuit breaker tripped',
        resumeAt,
      });

      // Extend the Redis queue TTL so unprocessed articles survive the pause.
      const { redis } = require('./queueManager');
      await redis.expire(processedQueueKey, 7 * 24 * 60 * 60);

      console.log(`Pipeline PAUSED (rate limited): ${jobId}. Resume at ${resumeAt} (attempt ${existingAttempts + 1}).`);

      return; // do NOT markFullyCompleted
    }

    // Unified daily snapshot — runs for ALL 3 modules
    try {
      const { buildDailySnapshot } = require('./dailySnapshotBuilder');
      await buildDailySnapshot(clientId, moduleId, industry);
    } catch (snapErr) {
      console.error(`[Pipeline] Daily snapshot generation failed (non-fatal): ${snapErr.message}`);
    }
    await updateJobStage(jobId, 'llm_processing', {
      afterLlm: llmResult.relevant,
      storedFinal: llmResult.relevant,
    });

    // TEMP (testing only): manually chain promotion + weekly scoring right
    // after the pipeline finishes, so the full flow can be validated in one
    // run during development. In production this should NOT run inline —
    // promotion and scoring need their own independent schedule (e.g. daily
    // and weekly cron), decoupled from how often /run fires. Remove this
    // block once a real scheduler exists.
    if (moduleId === FORWARD_OUTLOOK_MODULE_ID) {
      try {
        const { runPromotionCheck, runWeeklyScoring } = require('./trendClustering');
        console.log('\n[TEMP] Running promotion check + weekly scoring inline for testing...');
        await runPromotionCheck(moduleId, clientId, industry);
        await runWeeklyScoring(moduleId, clientId, industry);
      } catch (tempErr) {
        console.error('[TEMP] Promotion/scoring chain failed:', tempErr.message);
      }
    }

    // DONE
    await setStatus(jobId, {
      status: 'completed',
      total: sorted.length,
      afterUrlCheck: allCleanArticles.length,
      afterTopicDedup: finalArticles.length,
      afterQualityFilter: qualityCheckedArticles.length,
      afterLlmRelevant: llmResult.relevant,
      afterLlmIrrelevant: llmResult.irrelevant,
      message: `Done! ${llmResult.relevant} relevant articles stored in Qdrant + Supabase, ${llmResult.irrelevant} marked irrelevant.`
    });

    await markFullyCompleted(jobId);

    console.log('Pipeline completed:', jobId);
    console.log(`Total: ${sorted.length}, After URL check: ${allCleanArticles.length}, After Topic Dedup: ${finalArticles.length}, After Quality Filter: ${qualityCheckedArticles.length}`);
    console.log(`LLM Relevant: ${llmResult.relevant}, LLM Irrelevant: ${llmResult.irrelevant}`);

  } catch (error) {
    console.error('Pipeline error:', error);
    await setStatus(jobId, { status: 'failed', error: error.message });
    await failJobTracking(jobId, currentStage, error.message); // CHANGED: was 'unknown', now the real stage
  } finally {
    // TEMP: releaseLock disabled since acquireLock is also disabled in /run above
    // await releaseLock(clientId, submoduleId);
    console.log(`Lock released for client: ${clientId}, submodule: ${submoduleId}`);
  }
};

// CHANGED: new — shared entry point for both the /run route (manual trigger)
// and scheduler.js (automatic trigger). Generates the jobId and fires
// runPipeline in the background, exactly like /run used to do inline.
const triggerPipelineRun = (clientId, promptText, industry, moduleId, submoduleId, source, lookbackDays = 90) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  runPipeline(jobId, clientId, promptText, industry, moduleId, submoduleId, source || 'Exa', lookbackDays);
  return jobId;
};

// NEW (Stage 4): resume a paused_rate_limited job. Skips fetch/dedup/quality
// filter entirely and jumps straight back into LLM processing using the
// Redis processed-queue that was left intact when the job paused.
const resumePipelineRun = async (jobId) => {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const { data: job, error } = await supabase
    .from('pipeline_job_status')
    .select('*')
    .eq('job_id', jobId)
    .single();

  if (error || !job) {
    console.error(`[Resume] Job ${jobId} not found: ${error?.message}`);
    return;
  }

  if (job.status !== 'paused_rate_limited') {
    console.log(`[Resume] Job ${jobId} is not paused (status: ${job.status}), skipping`);
    return;
  }

  // Cap: if we've already resumed N times, give up.
  const MAX_RESUME_ATTEMPTS = 4;
  if ((job.resume_attempts || 0) > MAX_RESUME_ATTEMPTS) {
    console.log(`[Resume] Job ${jobId} exceeded max resume attempts (${MAX_RESUME_ATTEMPTS}). Marking permanently failed.`);
    await supabase.from('pipeline_job_status').update({
      status: 'permanently_failed',
      error_message: `Rate limit persisted after ${MAX_RESUME_ATTEMPTS} resume attempts`,
      updated_at: new Date().toISOString(),
    }).eq('job_id', jobId);
    return;
  }

  const processedQueueKey = job.processed_queue_key;
  if (!processedQueueKey) {
    console.error(`[Resume] Job ${jobId} missing processed_queue_key, cannot resume`);
    await supabase.from('pipeline_job_status').update({
      status: 'failed',
      error_message: 'Missing processed_queue_key',
      updated_at: new Date().toISOString(),
    }).eq('job_id', jobId);
    return;
  }

  const { setStatus } = require('./queueManager');
  const { processQueueInBatches } = require('./llmRelevanceProcessor');
  const { markFullyCompleted, failJobTracking, getJobResumeAttempts, markJobPaused } = require('./jobStatusTracker');

  console.log(`[Resume] Job ${jobId} — resuming (attempt ${(job.resume_attempts || 0) + 1}/${MAX_RESUME_ATTEMPTS})`);

  await setStatus(jobId, {
    status: 'llm_processing',
    message: `Resuming after rate limit (attempt ${(job.resume_attempts || 0) + 1})...`,
  });

  try {
    await acquireLLMSlot(jobId); // NEW
    let llmResult;
    try {
      llmResult = await processQueueInBatches(
        processedQueueKey,
        job.client_id,
        job.industry || 'General',
        jobId,
        job.module_id,
        job.submodule_id
      );
    } finally {
      releaseLLMSlot(jobId); // NEW
    }

    if (llmResult.aborted) {
      // Still rate-limited. Re-pause with the next backoff.
      const BACKOFF_MINUTES = [60, 360, 720, 720];
      const attempts = await getJobResumeAttempts(jobId);
      const backoffIdx = Math.min(attempts, BACKOFF_MINUTES.length - 1);
      const backoffMin = BACKOFF_MINUTES[backoffIdx];
      const resumeAt = new Date(Date.now() + backoffMin * 60 * 1000).toISOString();

      await setStatus(jobId, {
        status: 'paused_rate_limited',
        message: `Still rate limited — re-paused. Will resume in ${backoffMin} min (attempt ${attempts + 1}).`,
      });
      await markJobPaused(jobId, {
        reason: llmResult.reason || 'Still rate limited on resume',
        resumeAt,
      });

      // Extend queue TTL again
      const { redis } = require('./queueManager');
      await redis.expire(processedQueueKey, 7 * 24 * 60 * 60);

      console.log(`[Resume] Job ${jobId} still rate limited — re-paused until ${resumeAt}`);
      return;
    }

    // Guard against false completion: if the resumed batch made zero
    // progress (nothing relevant, nothing irrelevant, and either the queue
    // was empty or everything failed), don't pretend this job succeeded.
    // Re-pause it so a future resume (or the next scheduled run) can try
    // again once the rate limit actually clears.
    const madeProgress = llmResult.relevant > 0 || llmResult.irrelevant > 0;

    if (!madeProgress) {
      const BACKOFF_MINUTES = [60, 360, 720, 720];
      const attempts = await getJobResumeAttempts(jobId);
      const backoffIdx = Math.min(attempts, BACKOFF_MINUTES.length - 1);
      const backoffMin = BACKOFF_MINUTES[backoffIdx];
      const resumeAt = new Date(Date.now() + backoffMin * 60 * 1000).toISOString();

      await setStatus(jobId, {
        status: 'paused_rate_limited',
        message: `Resume made no progress (still rate limited) — re-paused. Will retry in ${backoffMin} min (attempt ${attempts + 1}).`,
      });
      await markJobPaused(jobId, {
        reason: 'Resume made no progress — still rate limited',
        resumeAt,
      });

      const { redis } = require('./queueManager');
      await redis.expire(processedQueueKey, 7 * 24 * 60 * 60);

      console.log(`[Resume] Job ${jobId} made no progress — re-paused until ${resumeAt}`);
      return;
    }

    // Success!
    await setStatus(jobId, {
      status: 'completed',
      message: `Resumed and completed. ${llmResult.relevant} relevant, ${llmResult.irrelevant} irrelevant.`,
    });
    await markFullyCompleted(jobId);
    console.log(`[Resume] Job ${jobId} completed after resume. Relevant: ${llmResult.relevant}, Irrelevant: ${llmResult.irrelevant}`);

  } catch (err) {
    console.error(`[Resume] Job ${jobId} threw during resume: ${err.message}`);
    await failJobTracking(jobId, 'resume', err.message);
  }
};

module.exports = { runPipeline, triggerPipelineRun, resumePipelineRun };