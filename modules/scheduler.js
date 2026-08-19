const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { triggerPipelineRun } = require('./pipelineRunner');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Returns current time in IST as 'HH:mm', matching the format schedule_time
// is saved in (e.g. '02:00') by the admin console's Schedule (IST) dropdown.
const getCurrentISTTime = () =>
  new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

// Runs every minute. Looks up any active schedule rows whose saved time
// matches right now, and fires the pipeline for each one via the same
// triggerPipelineRun that the manual "Run now" button uses.
const checkAndRunSchedules = async () => {
  const currentTime = getCurrentISTTime();
  console.log(`[Scheduler] Tick — checking for schedule_time = '${currentTime}'`);

  const { data: schedules, error } = await supabase
    .schema('admin')
    .from('prompts')
    .select('*')
    .eq('is_active', true)
    .eq('schedule_time', currentTime);

  if (error) {
    console.error('[Scheduler] Error fetching schedules:', error.message);
    return;
  }

  console.log(`[Scheduler] Found ${schedules ? schedules.length : 0} matching schedule(s)`);

  if (!schedules || schedules.length === 0) return;

  for (const s of schedules) {
    if (s.frequency?.toLowerCase() !== 'daily') continue;
    console.log(`[Scheduler] Triggering — client: ${s.client_id}, submodule: ${s.submodule_id}, time: ${currentTime} IST`);
    triggerPipelineRun(s.client_id, s.prompt_text, s.industry, s.module_id, s.submodule_id, s.source);
  }
};

const startScheduler = () => {
  console.log('[Scheduler] Cron started — checking admin.prompts every minute (Asia/Kolkata)');
  cron.schedule('* * * * *', checkAndRunSchedules, { timezone: 'Asia/Kolkata' });
};

module.exports = { startScheduler };