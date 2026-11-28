/**
 * modules/customSources/route.js
 *
 * In server.js (before app.listen):
 *   const { registerCustomSourcesRoute } = require('./modules/customSources/route');
 *   registerCustomSourcesRoute(app);
 *
 * POST /custom-source/run/:sourceId
 *   The same address the admin console already calls (Run now / Retry).
 *   Answers straight away with { status: 'started' } and reads the source in
 *   the background. The admin console then watches last_run_at on the source
 *   row, which reportRun.js sets when the run ends.
 *
 *   400 = not a valid source id
 *   404 = no such source
 *   409 = this source is already running
 *
 * Not done yet (on the admin console list): a login check on this route.
 */

const { createClient } = require('@supabase/supabase-js');
const { runSource, isRunning } = require('./runSource');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let sharedDb = null;
function defaultDb() {
  if (!sharedDb) sharedDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return sharedDb;
}

function registerCustomSourcesRoute(app) {
  app.post('/custom-source/run/:sourceId', async (req, res) => {
    const { sourceId } = req.params;
    if (!UUID.test(String(sourceId))) return res.status(400).json({ error: 'Not a valid source id' });
    if (isRunning(sourceId)) return res.status(409).json({ error: 'This source is already running' });

    try {
      const { data, error } = await defaultDb().schema('admin').from('custom_data_sources')
        .select('id').eq('id', sourceId).maybeSingle();
      if (error) return res.status(500).json({ error: `Could not read the source: ${error.message}` });
      if (!data) return res.status(404).json({ error: 'Custom data source not found' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    res.json({ status: 'started', sourceId });

    // In the background. runSource always reports, also when it fails.
    runSource(sourceId).catch((e) => console.error(`[CustomSources] Background run of ${sourceId} broke:`, e));
  });
}

module.exports = { registerCustomSourcesRoute };
