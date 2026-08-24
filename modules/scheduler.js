const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { triggerPipelineRun } = require('./pipelineRunner');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

// Runs every minute. Looks up any active schedule rows whose saved time
// matches right now, and fires the pipeline for each one via the same
// triggerPipelineRun that the manual "Run now" button uses.
const checkAndRunSchedules = async () => {
  const currentTime = getCurrentISTTime();
  console.log(`[Scheduler] Tick — checking for schedule_time = '${currentTime}'`);

  const { data: schedules, error } = await supabase
    .schema('admin')
    .from('prompts')
    .select('*, clients:client_id ( industry )')
    .eq('is_active', true)
    .eq('schedule_time', currentTime)
    .eq('status', 'Running');

  if (error) {
    console.error('[Scheduler] Error fetching schedules:', error.message);
    return;
  }

  console.log(`[Scheduler] Found ${schedules ? schedules.length : 0} matching schedule(s)`);

  if (!schedules || schedules.length === 0) return;

  for (const s of schedules) {
    if (s.frequency?.toLowerCase() !== 'daily') continue;

    const isEnabled = await isSubmoduleEnabledForClient(s.client_id, s.module_id, s.submodule_id);
    if (!isEnabled) {
      console.log(`[Scheduler] Skipping — client: ${s.client_id}, submodule: ${s.submodule_id} has no enabled signals (module/submodule disabled)`);
      continue;
    }

    const industry = s.clients?.industry || 'Unknown';
    console.log(`[Scheduler] Triggering — client: ${s.client_id}, submodule: ${s.submodule_id}, time: ${currentTime} IST, industry: ${industry}`);
    triggerPipelineRun(s.client_id, s.prompt_text, industry, s.module_id, s.submodule_id, s.source);
  }
};

const startScheduler = () => {
  console.log('[Scheduler] Cron started — checking admin.prompts every minute (Asia/Kolkata)');
  cron.schedule('* * * * *', checkAndRunSchedules, { timezone: 'Asia/Kolkata' });
};

module.exports = { startScheduler };