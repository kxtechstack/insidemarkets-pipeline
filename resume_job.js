require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { processQueueInBatches } = require('./modules/llmRelevanceProcessor');
const { markFullyCompleted } = require('./modules/jobStatusTracker');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CLIENT_ID = '19174b66-5ad9-44fa-8071-b30a90c15ea2';
const INDUSTRY = 'Renewable Energy';

const JOB = {
  jobId: 'job_1790190000225_kbn0y2',
  submoduleId: '89304c37-09d1-4d85-b6a6-78e3d234b94f',
  moduleId: '55c5ee19-bfca-468b-81b3-b89ca4f303c8'
};

const run = async () => {
  const queueKey = `processed:${JOB.jobId}`;
  console.log(`[Resume] === ${JOB.jobId} (submodule ${JOB.submoduleId}, module ${JOB.moduleId}) ===`);

  try {
    const result = await processQueueInBatches(queueKey, CLIENT_ID, INDUSTRY, JOB.jobId, JOB.moduleId, JOB.submoduleId);
    console.log(`[Resume] ${JOB.jobId} done:`, result);

    if (!result.aborted) {
      await markFullyCompleted(JOB.jobId);
      console.log(`[Resume] ${JOB.jobId} marked completed`);
    } else {
      console.log(`[Resume] ${JOB.jobId} aborted (circuit breaker) — remaining articles re-queued for later`);
    }
  } catch (err) {
    console.error(`[Resume] ${JOB.jobId} threw:`, err.message);
  }

  process.exit(0);
};

run();