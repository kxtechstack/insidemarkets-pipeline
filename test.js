/**
 * runPromotionAndScoringForJob.js
 * ===========================
 * Recovery script — looks up a specific job_id in pipeline_job_status to
 * derive the correct client_id, industry, and module_id (so we don't
 * guess/hardcode them and risk a mismatch), then runs promotion + weekly
 * scoring using those values. No fetch, no LLM classification — picks up
 * after a run that crashed on generateHighlight.
 *
 * NOTE: runPromotionCheck/runWeeklyScoring operate on module_id + client_id
 * + industry, not job_id specifically — so this will check/score ALL
 * candidate/active trends under that same client+module+industry, not
 * only trends touched by this one job. If test data and real data share
 * the same client_id/industry, both get swept in together.
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

// Same lookup pattern server.js uses in /retry-failed — submodules table
// maps submodule_id -> module_id.
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

const run = async () => {
  try {
    console.log(`[Recovery] Looking up job ${jobId}...`);

    const { data: job, error } = await supabase
      .from('pipeline_job_status')
      .select('client_id, industry, submodule_id, status, current_stage')
      .eq('job_id', jobId)
      .single();

    if (error || !job) {
      console.error(`[Recovery] Could not find job ${jobId} in pipeline_job_status:`, error?.message);
      return;
    }

    console.log(`[Recovery] Job found — client_id: ${job.client_id}, industry: "${job.industry}", submodule_id: ${job.submodule_id}, last stage: ${job.current_stage}`);

    const moduleId = await getModuleIdForSubmodule(job.submodule_id);
    console.log(`[Recovery] Resolved module_id: ${moduleId}`);

    console.log('[Recovery] Running promotion check...');
    await runPromotionCheck(moduleId, job.client_id, job.industry);

    console.log('[Recovery] Running weekly scoring...');
    await runWeeklyScoring(moduleId, job.client_id, job.industry);

    console.log('\n[Recovery] Done. Check trend_clusters (status=active for promoted) and trend_snapshots.');
  } catch (err) {
    console.error('[Recovery] Failed:', err.message);
  }
};

run();