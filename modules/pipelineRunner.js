/* pipelineRunner.js */
const { fetchArticles } = require('./fetcher');
const { sortByNewest, pushToQueue, readBatch, getQueueLength, setStatus } = require('./queueManager');
const { removeUrlDuplicates } = require('./deduplicator');
const { removeSameTopicArticles } = require('./topicDedup');
const { filterLowQualityArticles } = require('./qualityFilter');
const { pushToProcessedQueue } = require('./processedQueue');
const { startJobTracking, updateJobStage, markFullyCompleted, failJobTracking } = require('./jobStatusTracker');
const { processQueueInBatches, hasRelevancePrompt, FORWARD_OUTLOOK_MODULE_ID, MARKET_DYNAMICS_MODULE_ID } = require('./llmRelevanceProcessor');

// NEW: Competitive Intelligence has its own pipeline (modules/competitiveIntelligence), not this one
const CI_MODULE_ID = '5e953748-931d-4212-99e9-08c9a050cfef';
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
    // NEW: no AI check prompt for this module -> stop BEFORE fetching (no wasted search credits, no endless loop)
    if (!hasRelevancePrompt(moduleId)) {
      throw new Error(`Module ${moduleId} has no AI check prompt (MODULE_RELEVANCE_PROMPTS) - this pipeline cannot run for it.`);
    }
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

    // Daily highlight text for the landing page — runs for ALL 3 modules
    try {
      const { generateHighlight, generateBriefingFrame } = require('./highlightGenerator');
      await generateHighlight(clientId, moduleId, industry);
      await generateBriefingFrame(clientId);
    } catch (hlErr) {
      console.error(`[Pipeline] Daily highlight generation failed (non-fatal): ${hlErr.message}`);
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
  if (moduleId === CI_MODULE_ID) {          // NEW: "Run now" on a Competitive Intelligence prompt
    runCompetitiveIntelligenceJob(jobId, clientId, promptText, industry, moduleId, submoduleId);
    return jobId;
  }
  runPipeline(jobId, clientId, promptText, industry, moduleId, submoduleId, source || 'Exa', lookbackDays);
  return jobId;
};

/**
 * The result of one CI run, in the same shape the other modules use, so the admin card, its Article Log
 * and the Daily Report show it the same way:
 *   counts   -> pipeline_job_status (fetched, after URL check, after same-news check, read by the AI, saved)
 *   logRows  -> article_processing_log: one row per article the AI READ (and per page change it looked at)
 *                 'completed' = saved as a new card or added to a card
 *                 'skipped'   = the AI read it but it was not kept (reason written)
 *               Never 'failed': failed rows are retried by the article pipeline, which does not handle CI.
 *               A CI article that failed is retried by the next CI run itself.
 */
function ciRunReport(news, pages) {
  const t = { fetched: 0, afterUrl: 0, sameNews: 0 };
  const logRows = [];
  const add = (url, title, status, reason) => {
    if (!url || logRows.some((r) => r.url === url)) return;
    logRows.push({ url, title: String(title || '').slice(0, 300) || null, status, reason: reason ? String(reason).slice(0, 500) : null });
  };
  for (const c of (news && news.competitors) || []) {
    for (const sec of Object.values(c.sections || {})) {
      if (!sec || !sec.counts) continue;
      t.fetched += sec.counts.fetched || 0;
      t.afterUrl += sec.counts.after_url_check || 0;
      for (const it of sec.items || []) {
        if (it.step === 'same news check') { t.sameNews++; continue; }
        if (it.step === 'code check') continue;                    // dropped by the code checks, before the AI
        if (it.outcome === 'saved' || it.outcome === 'merged') {
          add(it.url, it.title, 'completed', it.outcome === 'merged' ? `added to an existing card (${c.competitor})` : `new card (${c.competitor})`);
        } else if (it.step === 'AI' || it.step === 'save') {
          add(it.url, it.title, 'skipped', `${c.competitor}: ${it.outcome === 'failed' ? 'not read this time (tried again next run) - ' : ''}${it.reason || 'not kept'}`);
        }
      }
    }
  }
  for (const c of (pages && pages.competitors) || []) {
    const k = c.counts || {};
    t.fetched += k.pages || 0;
    t.afterUrl += Math.max(0, (k.pages || 0) - (k.blocked || 0));
    for (const p of c.pages || []) {
      if (p.outcome === 'saved') add(p.url, p.name, 'completed', `page change saved (${c.competitor})`);
      else if (p.outcome === 'dropped' || p.outcome === 'failed') add(p.url, p.name, 'skipped', `${c.competitor} page: ${p.reason || 'no real change'}`);
      else t.sameNews++;                                            // page the same as last time
    }
  }
  const read = logRows.length;
  const stored = logRows.filter((r) => r.status === 'completed').length;
  const counts = {
    fetched: t.fetched,
    afterUrlCheck: t.afterUrl,
    afterTopicDedup: Math.max(read, t.afterUrl - t.sameNews),
    afterQualityFilter: read,
    pushedToQueue: read,
    afterLlm: stored,
    storedFinal: stored,
  };
  return { counts, logRows };
}
// kept for older callers / tests
const ciRunCounts = (news, pages) => ciRunReport(news, pages).counts;

/** write the Article Log rows of one CI job (article_processing_log), in small batches */
async function writeCiArticleLog(jobId, clientId, submoduleId, logRows) {
  if (!logRows.length) return;
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const now = new Date().toISOString();
  const rows = logRows.map((r) => ({
    job_id: jobId, client_id: clientId, submodule_id: submoduleId,
    article_url: r.url, article_title: r.title, status: r.status, error_message: r.reason,
    processed_at: now, ...(r.status === 'completed' ? { completed_at: now } : {}),
  }));
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await db.from('article_processing_log').insert(rows.slice(i, i + 100));
    if (error) { console.log(`[CI job] article log write failed (non-fatal): ${error.message}`); return; }
  }
}

// NEW: "Run now" on a Competitive Intelligence prompt (and the daily schedule) runs the FULL CI run for this client
// (news for every competitor with all CI search lines -> watched pages -> who is where -> strategic shifts).
// triggeredBy 'manual' (Run now): every competitor is read. 'schedule': a competitor already done in the last 20 hours is skipped.
// The job status + counts are saved like the other modules, so the admin card shows Running -> Completed / Failed and the numbers.
const runCompetitiveIntelligenceJob = async (jobId, clientId, promptText, industry, moduleId, submoduleId, triggeredBy = 'manual') => {
  // the CI run takes many minutes: tell the job table "still alive" every 4 minutes,
  // otherwise the stale-job watcher (jobRecovery.js) marks it failed while it is still running
  let stage = 'fetching';
  const heartbeat = setInterval(() => { updateJobStage(jobId, stage).catch(() => {}); }, 4 * 60 * 1000);
  const tag = triggeredBy === 'schedule' ? '[CI schedule]' : '[CI Run now]';
  try {
    await startJobTracking(jobId, clientId, promptText, submoduleId);
    const { recordJobContext } = require('./jobStatusTracker');
    await recordJobContext(jobId, industry, moduleId);
    await setStatus(jobId, { status: 'fetching', message: 'Competitive Intelligence: reading news for every competitor...' });

    const { runNewsForClient, summarise } = require('./competitiveIntelligence/newsRun');
    const { runPagesForClient } = require('./competitiveIntelligence/pageWatch');

    const news = await runNewsForClient(clientId, { triggeredBy });
    if (news.skipped) throw new Error(news.skipped);
    console.log(`${tag} news done - client: ${clientId}`, JSON.stringify(summarise(news)));
    await updateJobStage(jobId, 'llm_processing', ciRunReport(news, null).counts);   // numbers so far (shown while the pages are checked)

    stage = 'llm_processing';
    await setStatus(jobId, { status: 'llm_processing', message: 'Competitive Intelligence: checking watched pages...' });
    const pages = await runPagesForClient(clientId, { triggeredBy });
    console.log(`${tag} pages done - client: ${clientId}`, JSON.stringify((pages.competitors || []).map((c) => ({ competitor: c.competitor, ...(c.counts || {}), skipped: c.skipped, error: c.error }))));

    const { counts: n, logRows } = ciRunReport(news, pages);
    await updateJobStage(jobId, 'llm_processing', n);
    await writeCiArticleLog(jobId, clientId, submoduleId, logRows);   // the card's Article Log (Total | Completed | Skipped)
    const errors = (news.competitors || []).filter((c) => c.error).length;
    await setStatus(jobId, {
      status: 'completed',
      total: n.fetched,
      afterUrlCheck: n.afterUrlCheck,
      afterTopicDedup: n.afterTopicDedup,
      afterQualityFilter: n.afterQualityFilter,
      afterLlmRelevant: n.storedFinal,
      afterLlmIrrelevant: Math.max(0, n.afterQualityFilter - n.storedFinal),
      message: `Done! ${n.storedFinal} competitor updates saved (of ${n.fetched} links found).${errors ? ` ${errors} competitor(s) had an error.` : ''}`,
    });
    await markFullyCompleted(jobId);
    console.log(`${tag} counts - client: ${clientId}`, JSON.stringify(n));
  } catch (e) {
    console.error(`${tag} failed - client: ${clientId}: ${e.message}`);
    await setStatus(jobId, { status: 'failed', error: e.message });
    await failJobTracking(jobId, stage, e.message);
  } finally {
    clearInterval(heartbeat);
  }
};

// NEW: the daily schedule uses the same job (so the card shows the numbers of the scheduled run too).
// Returns a promise that ends when the run ends (the scheduler waits for it to free its "running" flag).
const runCompetitiveIntelligenceScheduled = (clientId, promptText, industry, submoduleId) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return runCompetitiveIntelligenceJob(jobId, clientId, promptText, industry, CI_MODULE_ID, submoduleId, 'schedule');
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

module.exports = { runPipeline, triggerPipelineRun, resumePipelineRun, runCompetitiveIntelligenceScheduled, ciRunCounts, ciRunReport };