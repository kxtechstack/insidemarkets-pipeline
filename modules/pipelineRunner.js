const { fetchArticles } = require('./fetcher');
const { sortByNewest, pushToQueue, readBatch, getQueueLength, setStatus } = require('./queueManager');
const { removeUrlDuplicates } = require('./deduplicator');
const { removeSameTopicArticles } = require('./topicDedup');
const { filterLowQualityArticles } = require('./qualityFilter');
const { pushToProcessedQueue } = require('./processedQueue');
const { startJobTracking, updateJobStage, markFullyCompleted, failJobTracking } = require('./jobStatusTracker');
const { processQueueInBatches, FORWARD_OUTLOOK_MODULE_ID, MARKET_DYNAMICS_MODULE_ID } = require('./llmRelevanceProcessor');
const { generateHighlight } = require('./highlightGenerator');

// CHANGED: runPipeline now takes moduleId, threads it through dedup calls
// and processQueueInBatches. Also tracks currentStage so a crash logs the
// REAL stage it failed at, instead of the hardcoded 'unknown' from before.
const runPipeline = async (jobId, clientId, promptText, industry, moduleId, submoduleId, source) => {

  let currentStage = 'starting'; // CHANGED: new — tracks real stage for failJobTracking

  try {

    await startJobTracking(jobId, clientId, promptText, submoduleId);
    await setStatus(jobId, { status: 'fetching', message: `Calling ${source} API...` });
    currentStage = 'fetching'; // CHANGED

    // Step 1 - Fetch from selected source
    const articles = await fetchArticles(source, promptText);
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
      message: `Running LLM relevance classification on ${qualityCheckedArticles.length} articles for industry: ${industry}...`
    });
    currentStage = 'llm_processing'; // CHANGED

    // Step 6 - LLM relevance classification + signal extraction
    // CHANGED: processQueueInBatches now takes moduleId before submoduleId
    const llmResult = await processQueueInBatches(processedQueueKey, clientId, industry, jobId, moduleId, submoduleId);
    if (moduleId !== FORWARD_OUTLOOK_MODULE_ID && moduleId !== MARKET_DYNAMICS_MODULE_ID) {
      await generateHighlight(clientId, moduleId);
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
const triggerPipelineRun = (clientId, promptText, industry, moduleId, submoduleId, source) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  runPipeline(jobId, clientId, promptText, industry, moduleId, submoduleId, source || 'Exa');
  return jobId;
};

module.exports = { runPipeline, triggerPipelineRun };