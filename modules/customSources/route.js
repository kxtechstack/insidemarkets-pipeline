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
 *   Needs an admin login only when .env CS_REQUIRE_ADMIN_LOGIN=on.
 *   400 = not a valid source id, 404 = no such source,
 *   409 = this source is already running or being deleted
 *
 * DELETE /custom-source/:sourceId
 *   Removes one source everywhere (search data, saved text, file, row).
 *   Always needs an admin login (Authorization: Bearer <token>).
 *   200 { deleted: true, rowFound, notes }, 400, 401, 403, 409, 500
 *
 * DELETE /custom-source/client/:clientId
 *   Removes every source of one client (call it BEFORE deleting the client).
 *   Always needs an admin login.
 *   200 { deleted: true, sources, files, notes }, 400, 401, 403, 409, 500
 */

const { createClient } = require('@supabase/supabase-js');
const { runSource, isRunning } = require('./runSource');
const { deleteSource, deleteClientSources, isDeleting } = require('./deleteSource');
const { adminOrStop } = require('./adminAccess');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let sharedDb = null;
function defaultDb() {
  if (!sharedDb) sharedDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return sharedDb;
}

// Tests: fake steps ({ db, runSource, deleteSource, deleteClientSources }); null = the real ones
let fakes = null;
function useRouteFakes(f) { fakes = f; }
const pick = (name, real) => (fakes && fakes[name]) || real;

const sendError = (res, e) => res.status(e.status || 500).json({ error: e.message });

function registerCustomSourcesRoute(app) {
  app.post('/custom-source/run/:sourceId', async (req, res) => {
    const { sourceId } = req.params;
    if (!UUID.test(String(sourceId))) return res.status(400).json({ error: 'Not a valid source id' });
    const who = await adminOrStop(req, res, { always: false });
    if (!who.ok) return undefined;
    if (isRunning(sourceId)) return res.status(409).json({ error: 'This source is already running' });
    if (isDeleting(sourceId)) return res.status(409).json({ error: 'This source is being deleted' });

    try {
      const { data, error } = await ((fakes && fakes.db) || defaultDb()).schema('admin').from('custom_data_sources')
        .select('id').eq('id', sourceId).maybeSingle();
      if (error) return res.status(500).json({ error: `Could not read the source: ${error.message}` });
      if (!data) return res.status(404).json({ error: 'Custom data source not found' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    res.json({ status: 'started', sourceId });

    // In the background. runSource always reports, also when it fails.
    pick('runSource', runSource)(sourceId).catch((e) => console.error(`[CustomSources] Background run of ${sourceId} broke:`, e));
    return undefined;
  });

  // (before "/:sourceId", so "client" is never read as a source id)
  app.delete('/custom-source/client/:clientId', async (req, res) => {
    const who = await adminOrStop(req, res);
    if (!who.ok) return undefined;
    try {
      const out = await pick('deleteClientSources', deleteClientSources)(req.params.clientId);
      console.log(`[CustomSources] Client sources deleted by ${who.email}`);
      return res.json(out);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.delete('/custom-source/:sourceId', async (req, res) => {
    const who = await adminOrStop(req, res);
    if (!who.ok) return undefined;
    try {
      const out = await pick('deleteSource', deleteSource)(req.params.sourceId);
      console.log(`[CustomSources] Source ${req.params.sourceId} deleted by ${who.email}`);
      return res.json(out);
    } catch (e) {
      return sendError(res, e);
    }
  });
}

module.exports = { registerCustomSourcesRoute, useRouteFakes };
