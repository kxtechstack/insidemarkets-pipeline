/**
 * runPromotionAndScoringForJob.js
 * ===========================
 * Recovery script — looks up a job_id in pipeline_job_status to get
 * client_id + submodule_id, resolves module_id from the submodule, and
 * gets industry from admin.clients (industry isn't stored on the job
 * row itself). Then runs promotion + weekly scoring using those values.
 *
 * Run from the repo root:
 *   node runPromotionAndScoringForJob.js job_1784822571309_jzcueh
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runPromotionCheck, runWeeklyScoring } = require('./modules/trendClustering');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const jobId = process.argv[2];

if (!jobId) {
  console.error('Usage: node runPromotionAndScoringForJob.js <jobId>');
  process.exit(1);
}

const getModuleIdForSubmodule = async (submoduleId) => {
  const { data, error } = await supabase
    .schema('admin')
    .from('submodules')
    .select('module_id')
    .eq('id', submoduleId)
    .single();

  if (error || !data) {
    throw new Error(`Could not find module_id for submodule_id: ${submoduleId}`);
  }
  return data.module_id;
};

const getIndustryForClient = async (clientId) => {
  const { data, error } = await supabase
    .schema('admin')
    .from('clients')
    .select('industry')
    .eq('id', clientId)
    .single();

  if (error || !data) {
    throw new Error(`Could not find industry for client_id: ${clientId} — ${error?.message}`);
  }
  return data.industry;
};

const run = async () => {
  try {
    console.log(`[Recovery] Looking up job ${jobId}...`);

    // Select * first so we can see the actual columns if this fails again
    const { data: job, error } = await supabase
      .from('pipeline_job_status')
      .select('*')
      .eq('job_id', jobId)
      .single();

    if (error || !job) {
      console.error(`[Recovery] Could not find job ${jobId} in pipeline_job_status:`, error?.message);
      return;
    }

    console.log('[Recovery] Job row:', job);

    const moduleId = await getModuleIdForSubmodule(job.submodule_id);
    const industry = await getIndustryForClient(job.client_id);

    console.log(`[Recovery] client_id: ${job.client_id}, industry: "${industry}", module_id: ${moduleId}`);

    console.log('[Recovery] Running promotion check...');
    await runPromotionCheck(moduleId, job.client_id, industry);

    console.log('[Recovery] Running weekly scoring...');
    await runWeeklyScoring(moduleId, job.client_id, industry);

    console.log('\n[Recovery] Done. Check trend_clusters (status=active for promoted) and trend_snapshots.');
  } catch (err) {
    console.error('[Recovery] Failed:', err.message);
  }
};

run();