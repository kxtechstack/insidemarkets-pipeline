/* server.js */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { triggerPipelineRun } = require('./modules/pipelineRunner');
const { startScheduler } = require('./modules/scheduler');
const { fetchArticles } = require('./modules/fetcher');
const { sortByNewest, pushToQueue, readBatch, getQueueLength, setStatus, getStatus, acquireLock, refreshLock, releaseLock } = require('./modules/queueManager');
const { removeUrlDuplicates } = require('./modules/deduplicator');
const { removeSameTopicArticles } = require('./modules/topicDedup');
const { filterLowQualityArticles } = require('./modules/qualityFilter');
const { pushToProcessedQueue } = require('./modules/processedQueue');
const { startJobTracking, updateJobStage, completeJobTracking, markFullyCompleted, failJobTracking } = require('./modules/jobStatusTracker');
const { processQueueInBatches, retryFailedArticles, FORWARD_OUTLOOK_MODULE_ID, MARKET_DYNAMICS_MODULE_ID } = require('./modules/llmRelevanceProcessor');
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { askQuestion } = require('./modules/ragChat');
const { extractContent } = require('./modules/customSourceExtractor');
const { processCustomSource } = require('./modules/customSourceProcessor');
const { startStaleJobWatcher, startRateLimitResumeWatcher } = require('./modules/jobRecovery');
const { registerDecisionIntelligenceRoute } = require('./modules/decisionIntelligence/route');
const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrantClient = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});
const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/admin/invite-user', async (req, res) => {
  const { email, clientId, firstName, lastName, designation } = req.body;

  if (!email || !clientId) {
    return res.status(400).json({ error: 'email and clientId are required' });
  }

  try {
    const { data, error } = await supabaseClient.auth.admin.inviteUserByEmail(email, {
      redirectTo: 'https://market-intelligence-dashboard.techstack-d48.workers.dev/',
      data: { client_id: clientId }
    });

    if (error) {
      console.error('[InviteUser] Supabase error:', error.message);
      return res.status(400).json({ error: error.message });
    }

    const { error: insertError } = await supabaseClient
      .schema('admin')
      .from('client_users')
      .insert({
        email: email.toLowerCase(),
        client_id: clientId,
        first_name: firstName || null,
        last_name: lastName || null,
        designation: designation || null,
        is_active: true
      });

    if (insertError) {
      console.error('[InviteUser] client_users insert error:', insertError.message);
    }

    return res.json({ message: 'Invite sent', user: data.user });
  } catch (err) {
    console.error('[InviteUser] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/admin/delete-user', async (req, res) => {
  const { userId, id, email } = req.body;
  const providedId = userId || id;
  if (!providedId && !email) {
    return res.status(400).json({ error: 'userId or email is required' });
  }
  try {
    let authId = null;
    // Always resolve the CURRENT auth ID by email first — cached IDs can go stale
    if (email) {
      const { data: listData, error: listErr } = await supabaseClient.auth.admin.listUsers();
      if (listErr) throw listErr;
      const match = listData.users.find(u => u.email?.toLowerCase() === String(email).toLowerCase());
      if (match) authId = match.id;
    }
    if (!authId && providedId) {
      authId = providedId;
    }
    if (authId) {
      const { error: delErr } = await supabaseClient.auth.admin.deleteUser(authId);
      if (delErr) {
        console.error('[DeleteUser] Supabase auth delete error:', delErr.message);
        return res.status(400).json({ error: delErr.message });
      }
    }
    const { error: cuErr } = await supabaseClient
      .schema('admin')
      .from('client_users')
      .delete()
      .or(`id.eq.${authId || providedId || ''},email.eq.${(email || '').toLowerCase()}`);
    if (cuErr) {
      console.error('[DeleteUser] client_users delete error:', cuErr.message);
    }
    return res.json({ success: true, message: 'User deleted', userId: authId });
  } catch (err) {
    console.error('[DeleteUser] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/ask', async (req, res) => {
  try {
    const { question, clientId, industry, moduleId } = req.body; // CHANGED: added moduleId
    if (!question || !clientId || !industry || !moduleId) {
      return res.status(400).json({ error: 'question, clientId, industry, and moduleId are required' });
    }
    const result = await askQuestion(question, clientId, industry, moduleId); // CHANGED: passes moduleId
    return res.json(result);
  } catch (err) {
    console.error('[Ask] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/run', async (req, res) => {
  const { clientId, promptText, industry, moduleId, submoduleId, source } = req.body;

  if (!clientId || !promptText || !industry || !moduleId || !submoduleId) {
    return res.status(400).json({ error: 'clientId, promptText, industry, moduleId, and submoduleId are all required' });
  }

  const jobId = triggerPipelineRun(clientId, promptText, industry, moduleId, submoduleId, source);
  res.json({ jobId, status: 'started' });
});

app.post('/schedules', async (req, res) => {
  const { clientId, submoduleId, source, frequency, scheduleTime, isActive } = req.body;

  if (!clientId || !submoduleId) {
    return res.status(400).json({ error: 'clientId and submoduleId are required' });
  }

  const updatePayload = {
    source: source || 'Exa',
    frequency: frequency || 'daily',
    is_active: isActive !== false,
  };
  if (scheduleTime) {
    updatePayload.schedule_time = scheduleTime;
  }
  if (isActive !== undefined) {
    updatePayload.status = isActive ? 'Running' : 'Paused';
  }

  const { data, error } = await supabaseClient
    .schema('admin')
    .from('prompts')
    .update(updatePayload)
    .eq('client_id', clientId)
    .eq('submodule_id', submoduleId)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ schedule: data[0] || null });
});

app.get('/schedules/:clientId/:submoduleId', async (req, res) => {
  const { data, error } = await supabaseClient
    .schema('admin')
    .from('prompts')
    .select('source, frequency, schedule_time, is_active')
    .eq('client_id', req.params.clientId)
    .eq('submodule_id', req.params.submoduleId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ schedule: data || null });
});

// Status check route
app.get('/status/:jobId', async (req, res) => {
  const status = await getStatus(req.params.jobId);
  if (!status) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(status);
});

// Similar articles route -- uses Qdrant recommend API via point ID
// (recommend works without needing to manually extract the vector,
// which the JS client doesn't expose cleanly from scroll results)
app.get('/similar/:signalId', async (req, res) => {
  try {
    const { signalId } = req.params;
    const { moduleId } = req.query;
    const TOP_SIMILAR = 3;

    // Step 1 — get signal from Supabase
    const { data: signal, error } = await supabaseClient
      .from('policy_signals')
      .select('article_id, client_id, industry, signal_title, source_article_url')
      .eq('id', signalId)
      .single();

    if (error || !signal) {
      return res.status(404).json({ error: 'Signal not found' });
    }

    if (!signal.article_id) {
      return res.status(200).json({ similar: [], reason: 'No article_id on this signal' });
    }

    // Step 2 — find this article's first chunk point ID in Qdrant
    const chunksResult = await qdrantClient.scroll(POLICY_COLLECTION, {
      filter: {
        must: [{ key: 'article_id', match: { value: signal.article_id } }],
      },
      limit: 1,
      with_vectors: false,
      with_payload: false,
    });

    if (!chunksResult.points || chunksResult.points.length === 0) {
      return res.status(200).json({ similar: [], reason: 'No chunks found in Qdrant for this article' });
    }

    const pointId = chunksResult.points[0].id;

    // Step 3 — recommend API finds similar points from other articles
    const filterConditions = [
      { key: 'client_id', match: { value: signal.client_id } },
      { key: 'industry', match: { value: signal.industry } },
    ];
    if (moduleId) {
      filterConditions.push({ key: 'module_id', match: { value: moduleId } });
    }

    const recommended = await qdrantClient.recommend(POLICY_COLLECTION, {
      positive: [pointId],
      limit: 20,
      with_payload: true,
      filter: {
        must: filterConditions,
      },
    });

    // Step 4 — deduplicate by article_id, exclude same article, return top 3
    const seen = new Set();
    const similar = [];

    for (const point of recommended) {
      const articleId = point.payload.article_id;
      const title = point.payload.title;
      if (articleId === signal.article_id) continue;
      if (seen.has(articleId || title)) continue;
      seen.add(articleId || title);
      similar.push({
          article_id: articleId,
          title,
          url: point.payload.url,
          score: point.score,
        });
      if (similar.length >= TOP_SIMILAR) break;
    }

   // Fetch signal_title and signal id from policy_signals for each result
    const articleIds = similar.map(s => s.article_id);
    const { data: signals } = await supabaseClient
      .from('policy_signals')
      .select('id, signal_title, article_id')
      .in('article_id', articleIds)
      .eq('client_id', signal.client_id);

    const signalMap = {};
    if (signals) {
      signals.forEach(s => { signalMap[s.article_id] = s; });
    }

    const enriched = similar.map(s => ({
      signal_id: signalMap[s.article_id]?.id || null,
      title: signalMap[s.article_id]?.signal_title || s.title,
      url: s.url,
      score: s.score,
    }));

    return res.json({ similar: enriched });

  } catch (err) {
    console.error('[Similar] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Similar market insight cards route -- module-specific equivalent of
// /similar/:signalId, but for Market Dynamics cards (which are bundles
// of multiple articles, not single articles) using centroid similarity.
app.get('/similar-insight/:insightId', async (req, res) => {
  try {
    const { insightId } = req.params;
    const { findSimilarInsights } = require('./modules/marketInsights');
    const similar = await findSimilarInsights(insightId);
    return res.json({ similar });
  } catch (err) {
    console.error('[SimilarInsight] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/market-dynamics/scorecard/:clientId', async (req, res) => {
  try {
    const { data, error } = await supabaseClient
      .from('market_dimension_scorecard')
      .select('*')
      .eq('client_id', req.params.clientId)
      .eq('module_id', MARKET_DYNAMICS_MODULE_ID);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ scorecard: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// ============================================
// MAIN PIPELINE FUNCTION
// ============================================

// Latest pipeline status for a client + submodule
app.get('/client-status/:clientId', async (req, res) => {
  try {
    const { submoduleId } = req.query;
    if (!submoduleId) {
      return res.status(400).json({ error: 'submoduleId query param is required' });
    }

    const { data, error } = await supabaseClient
      .from('pipeline_job_status')
      .select('*')
      .eq('client_id', req.params.clientId)
      .eq('submodule_id', submoduleId)
      .order('started_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return res.json({ hasRun: false });

    const lastRun = data.completed_at || data.updated_at;
    const minutesAgo = lastRun ? Math.floor((Date.now() - new Date(lastRun)) / 60000) : null;

    return res.json({
      hasRun: true,
      jobId: data.job_id,
      status: data.status,
      currentStage: data.current_stage,
      lastRunAt: lastRun,
      minutesAgo,
      errorMessage: data.error_message || null,
      counts: {
        fetched: data.count_fetched || 0,
        afterUrlCheck: data.count_after_url_check || 0,
        afterTopicDedup: data.count_after_topic_dedup || 0,
        afterQualityFilter: data.count_after_quality_filter || 0,
        storedFinal: data.count_stored_final || 0,
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Run a single custom data source (website / pdf / file / text)
app.post('/custom-source/run/:sourceId', async (req, res) => {
  const { sourceId } = req.params;

  try {
    // Look up the source row
    const { data: source, error } = await supabaseClient
      .schema('admin')
      .from('custom_data_sources')
      .select('*')
      .eq('id', sourceId)
      .single();

    if (error || !source) {
      return res.status(404).json({ error: 'Custom data source not found' });
    }

    // Respond immediately, process in background (same pattern as /run)
    res.json({ status: 'started', sourceId });

    try {
      const extracted = await extractContent(source);
      const result = await processCustomSource(source, extracted);
      console.log(`[CustomSource] Run complete for "${source.source_name}":`, result);
    } catch (err) {
      console.error(`[CustomSource] Run failed for "${source.source_name}":`, err.message);

      await supabaseClient
        .schema('admin')
        .from('custom_data_sources')
        .update({ last_run_status: 'failed', last_run_at: new Date().toISOString() })
        .eq('id', sourceId);

      // Log this failed attempt to the run history table too (this catch
      // block covers extraction failures -- e.g. bad URL, unreachable file --
      // which happen BEFORE processCustomSource's own try/catch would log it)
      await supabaseClient.from('custom_source_run_log').insert({
        source_id: sourceId,
        client_id: source.client_id,
        source_name: source.source_name,
        status: 'failed',
        error_message: err.message,
      });
    }

  } catch (err) {
    console.error('[CustomSource] Route error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Retry failed articles (manual trigger).
// CHANGED: now accepts optional submoduleId in the request body -- when the
// frontend's per-submodule "Retry Failed" button sends it, only that
// submodule's failed articles are retried instead of the whole client's.
app.post('/retry-failed/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { submoduleId } = req.body || {};
    res.json({ message: 'Retry started', clientId, submoduleId: submoduleId || 'all' });

    const result = await retryFailedArticles(clientId, submoduleId || null);
    console.log(`[Retry] Manual retry for client ${clientId}${submoduleId ? `, submodule ${submoduleId}` : ''}: attempted ${result.attempted}, succeeded ${result.succeeded}`);

  } catch (err) {
    console.error(`[Retry] Error for client ${clientId}:`, err.message);
  }
});

// NEW: "Retry now" -- this is the endpoint the frontend's Retry button hits.
// Two-stage behavior:
//   1. If there are paused_rate_limited jobs for this client (and submodule,
//      if provided), resume them IMMEDIATELY -- bypassing resume_at -- using
//      the same resumePipelineRun the rate-limit watcher uses. This lets
//      users say "I fixed the key, try again right now" instead of waiting
//      for the next scheduled backoff window (1h / 6h / 12h / 12h).
//   2. If no paused jobs exist, fall back to the log-based retryFailedArticles
//      so orphaned `failed` rows also get retried.
app.post('/retry-now/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { submoduleId } = req.body || {};

  // Respond immediately -- the actual work runs in the background, exactly
  // like /run and /retry-failed do.
  res.json({ message: 'Retry-now started', clientId, submoduleId: submoduleId || 'all' });

  try {
    // Stage 1: find paused jobs and resume them immediately.
    let pausedQuery = supabaseClient
      .from('pipeline_job_status')
      .select('job_id, status, resume_attempts')
      .eq('client_id', clientId)
      .eq('status', 'paused_rate_limited');

    if (submoduleId) {
      pausedQuery = pausedQuery.eq('submodule_id', submoduleId);
    }

    const { data: pausedJobs, error: pausedErr } = await pausedQuery;

    if (pausedErr) {
      console.error(`[RetryNow] Error querying paused jobs for ${clientId}:`, pausedErr.message);
    }

    if (pausedJobs && pausedJobs.length > 0) {
      const { resumePipelineRun } = require('./modules/pipelineRunner');

      console.log(`[RetryNow] Found ${pausedJobs.length} paused job(s) for client ${clientId}${submoduleId ? `, submodule ${submoduleId}` : ''} — resuming immediately`);

      for (const job of pausedJobs) {
        // Cap safeguard: don't resume jobs that have already blown past the
        // normal 5-attempt backoff cap. Users clicking the button repeatedly
        // shouldn't be able to bypass the safety limit.
        if ((job.resume_attempts || 0) >= 5) {
          console.log(`[RetryNow] Skipping ${job.job_id} — resume_attempts (${job.resume_attempts}) exceeded cap (5). Marking permanently_failed.`);
          await supabaseClient
            .from('pipeline_job_status')
            .update({
              status: 'permanently_failed',
              error_message: 'Retry cap exceeded via manual Retry button',
              updated_at: new Date().toISOString(),
            })
            .eq('job_id', job.job_id);
          continue;
        }

        // Force resume_at to now so resumePipelineRun doesn't skip on the
        // "is it time yet" check inside.
        await supabaseClient
          .from('pipeline_job_status')
          .update({
            resume_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('job_id', job.job_id);

        // Fire and forget -- resumePipelineRun can take minutes. Catch any
        // error so one failure doesn't kill the whole loop.
        resumePipelineRun(job.job_id).catch((err) => {
          console.error(`[RetryNow] resumePipelineRun error for ${job.job_id}:`, err.message);
        });
      }
      return;
    }

    // Stage 2: no paused jobs -- fall back to log-based retry for orphaned
    // failures (articles that failed mid-run but never tripped the breaker).
    console.log(`[RetryNow] No paused jobs for client ${clientId}${submoduleId ? `, submodule ${submoduleId}` : ''} — falling back to log-based retry`);
    const result = await retryFailedArticles(clientId, submoduleId || null);
    console.log(`[RetryNow] Log-based retry: attempted ${result.attempted}, succeeded ${result.succeeded}`);

  } catch (err) {
    console.error(`[RetryNow] Error for client ${clientId}:`, err.message);
  }
});

app.post('/admin/users-last-signin', async (req, res) => {
  const { emails } = req.body;

  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'emails array is required' });
  }

  try {
    const { data, error } = await supabaseClient.auth.admin.listUsers({
      page: 1,
      perPage: 1000
    });

    if (error) {
      console.error('[UsersLastSignin] Error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    const emailSet = new Set(emails.map(e => e.toLowerCase()));
    const result = {};

    data.users.forEach(user => {
      if (emailSet.has(user.email.toLowerCase())) {
        result[user.email.toLowerCase()] = user.last_sign_in_at || null;
      }
    });

    return res.json({ lastSignins: result });
  } catch (err) {
    console.error('[UsersLastSignin] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// NEW: Returns the count of retryable failed articles for a client, optionally
// scoped to one submodule. Used by the frontend to decide whether to show
// the "Retry Failed" button at all -- no point showing it if count is 0.
app.get('/failed-count/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { submoduleId } = req.query;

    let query = supabaseClient
      .from('article_processing_log')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('status', 'failed')
      .lt('retry_count', 3);

    if (submoduleId) {
      query = query.eq('submodule_id', submoduleId);
    }

    const { count, error } = await query;

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ count: count || 0 });

  } catch (err) {
    console.error('[FailedCount] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/schedules/client/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { scheduleTime, source, frequency } = req.body;

  if (!scheduleTime) {
    return res.status(400).json({ error: 'scheduleTime is required' });
  }

  const updatePayload = { schedule_time: scheduleTime };
  if (source) updatePayload.source = source;
  if (frequency) updatePayload.frequency = frequency;

  const { data, error } = await supabaseClient
    .schema('admin')
    .from('prompts')
    .update(updatePayload)
    .eq('client_id', clientId)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ updatedCount: data.length, schedule: data });
});

app.get('/schedules/client/:clientId', async (req, res) => {
  const { data, error } = await supabaseClient
    .schema('admin')
    .from('prompts')
    .select('schedule_time, source, frequency, is_active')
    .eq('client_id', req.params.clientId)
    .not('schedule_time', 'is', null)
    .limit(1)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ schedule: data || null });
});

// ── Daily module snapshots (unified card for MD / Policy / FO) ──
app.get('/daily-snapshot/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { moduleId, date } = req.query;

    // Default to today's IST date
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    const istToday = new Date(Date.UTC(
      istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()
    )).toISOString().slice(0, 10);

    const targetDate = date || istToday;

    let query = supabaseClient
      .from('daily_module_snapshots')
      .select('*')
      .eq('client_id', clientId)
      .eq('snapshot_date', targetDate);

    if (moduleId) query = query.eq('module_id', moduleId);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ snapshots: data || [], date: targetDate });
  } catch (err) {
    console.error('[DailySnapshot] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Fallback: latest available snapshot (for when today's run hasn't fired yet)
app.get('/daily-snapshot-latest/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { moduleId } = req.query;

    let query = supabaseClient
      .from('daily_module_snapshots')
      .select('*')
      .eq('client_id', clientId)
      .order('snapshot_date', { ascending: false })
      .limit(3);

    if (moduleId) query = query.eq('module_id', moduleId);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ snapshots: data || [] });
  } catch (err) {
    console.error('[DailySnapshotLatest] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
registerDecisionIntelligenceRoute(app);

app.listen(PORT, () => {
  console.log(`KX Pipeline server running on port ${PORT}`);
  startStaleJobWatcher(5);
  startRateLimitResumeWatcher(5); // every 5min, checks for paused jobs ready to resume
  startScheduler();
});
