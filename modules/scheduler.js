const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { triggerPipelineRun } = require('./pipelineRunner');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Competitive Intelligence (Competitive Radar) has its own daily job (not the article pipeline).
const CI_MODULE_ID = '5e953748-931d-4212-99e9-08c9a050cfef';
const ciRunning = new Set(); // one CI run per client at a time

// Returns current time in IST as 'HH:mm', matching the format schedule_time
// is saved in (e.g. '02:00') by the admin console's Schedule (IST) dropdown.
const getCurrentISTTime = () =>
  new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

const isSubmoduleEnabledForClient = async (clientId, moduleId, submoduleId) => {
  const { data: client, error: clientErr } = await supabase
    .schema('admin')
    .from('clients')
    .select('enabled_modules')
    .eq('id', clientId)
    .single();

  if (clientErr || !client) {
    console.error(`[Scheduler] Error fetching client ${clientId} for module check:`, clientErr?.message);
    return false;
  }

  const enabledModules = client.enabled_modules || [];
  if (!enabledModules.includes(moduleId)) {
    console.log(`[Scheduler] Module ${moduleId} not in enabled_modules for client ${clientId}`);
    return false;
  }

  const { count, error } = await supabase
    .schema('admin')
    .from('client_signals')
    .select('signal_id, signals!inner(submodule_id)', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('is_enabled', true)
    .eq('signals.submodule_id', submoduleId);

  if (error) {
    console.error(`[Scheduler] Error checking scope for client ${clientId}, submodule ${submoduleId}:`, error.message);
    return false;
  }

  return (count || 0) > 0;
};

// Competitive Intelligence for one client: competitor updates first, then the watched pages.
// Runs in the background (takes minutes) so the other schedules of this minute are not held up.
// Safe against double runs: one run per client at a time here, and the CI code itself skips
// a competitor already done in the last 20 hours and a page already checked today.
const runCompetitiveIntelligence = (clientId, currentTime, ciRow = null) => {
  if (ciRunning.has(clientId)) {
    console.log(`[Scheduler] CI already running for client ${clientId} - skipped`);
    return;
  }
  ciRunning.add(clientId);
  console.log(`[Scheduler] Triggering Competitive Intelligence — client: ${clientId}, time: ${currentTime} IST`);
  setImmediate(async () => {
    try {
      // the client has its own CI schedule row -> run it as a tracked job (the admin card shows status + numbers, like the other modules)
      if (ciRow && ciRow.submodule_id) {
        const { runCompetitiveIntelligenceScheduled } = require('./pipelineRunner');
        await runCompetitiveIntelligenceScheduled(clientId, ciRow.prompt_text || 'Competitive Intelligence daily run', ciRow.industry || 'Unknown', ciRow.submodule_id);
        return;
      }
      const { runNewsForClient, summarise } = require('./competitiveIntelligence/newsRun');
      const { runPagesForClient } = require('./competitiveIntelligence/pageWatch');
      const news = await runNewsForClient(clientId, { triggeredBy: 'schedule' });
      console.log(`[Scheduler] CI updates done — client: ${clientId}`, JSON.stringify(summarise(news)));
      const pages = await runPagesForClient(clientId, { triggeredBy: 'schedule' });
      console.log(`[Scheduler] CI page check done — client: ${clientId}`, JSON.stringify((pages.competitors || []).map((c) => ({ competitor: c.competitor, ...(c.counts || {}), skipped: c.skipped, error: c.error }))));
    } catch (e) {
      console.error(`[Scheduler] CI run failed — client: ${clientId}:`, e.message);
    } finally {
      ciRunning.delete(clientId);
    }
  });
};

// Runs every minute. Looks up any active schedule rows whose saved time
// matches right now, and fires the pipeline for each one via the same
// triggerPipelineRun that the manual "Run now" button uses.
const checkAndRunSchedules = async () => {
  const currentTime = getCurrentISTTime();
  console.log(`[Scheduler] Tick — checking for schedule_time = '${currentTime}'`);

  const { data: schedules, error } = await supabase
    .schema('admin')
    .from('prompts')
    .select('*, clients:client_id ( industry, status, enabled_modules )')
    .eq('is_active', true)
    .eq('schedule_time', currentTime)
    .eq('status', 'Running');

  if (error) {
    console.error('[Scheduler] Error fetching schedules:', error.message);
    return;
  }

  console.log(`[Scheduler] Found ${schedules ? schedules.length : 0} matching schedule(s)`);

  if (!schedules || schedules.length === 0) return;

  // Competitive Intelligence time: a client with its OWN CI schedule row (admin console, module = Competitive Intelligence)
  // runs CI only at that time. A client without one runs CI at its other schedule time (as before).
  const { data: ciRows } = await supabase.schema('admin').from('prompts')
    .select('client_id').eq('module_id', CI_MODULE_ID).eq('is_active', true).eq('status', 'Running');
  const hasOwnCiTime = new Set((ciRows || []).map((r) => r.client_id));

  const ciClients = new Map(); // clients whose CI time is now -> run CI once for each

  for (const s of schedules) {
    if (s.frequency?.toLowerCase() !== 'daily') continue;

    if (s.clients?.status && s.clients.status.toLowerCase() !== 'active') {
      console.log(`[Scheduler] Skipping — client: ${s.client_id} is ${s.clients.status}, not active`);
      continue;
    }

    // Competitive Intelligence run (once per client): at its own CI time, or - if it has none - at its other schedule time
    if ((s.clients?.enabled_modules || []).includes(CI_MODULE_ID)
      && (s.module_id === CI_MODULE_ID || !hasOwnCiTime.has(s.client_id))) {
      // keep the first CI row of this minute (its card gets the run's status + numbers)
      if (!ciClients.get(s.client_id)) {
        ciClients.set(s.client_id, s.module_id === CI_MODULE_ID
          ? { submodule_id: s.submodule_id, prompt_text: s.prompt_text, industry: s.clients?.industry || 'Unknown' } : null);
      }
    }

    // CI rows (if any) are never sent to the article pipeline - CI has its own job above
    if (s.module_id === CI_MODULE_ID) continue;

    const isEnabled = await isSubmoduleEnabledForClient(s.client_id, s.module_id, s.submodule_id);
    if (!isEnabled) {
      console.log(`[Scheduler] Skipping — client: ${s.client_id}, submodule: ${s.submodule_id} has no enabled signals (module/submodule disabled)`);
      continue;
    }

    const industry = s.clients?.industry || 'Unknown';
    console.log(`[Scheduler] Triggering — client: ${s.client_id}, submodule: ${s.submodule_id}, time: ${currentTime} IST, industry: ${industry}, lookback: 1 day`);
    triggerPipelineRun(s.client_id, s.prompt_text, industry, s.module_id, s.submodule_id, s.source, 1);
  }

  for (const [clientId, ciRow] of ciClients) runCompetitiveIntelligence(clientId, currentTime, ciRow);
};

const startScheduler = () => {
  console.log('[Scheduler] Cron started — checking admin.prompts every minute (Asia/Kolkata)');
  cron.schedule('* * * * *', checkAndRunSchedules, { timezone: 'Asia/Kolkata' });
};

module.exports = { startScheduler };