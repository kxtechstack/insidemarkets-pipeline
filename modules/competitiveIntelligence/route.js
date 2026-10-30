/**
 * modules/competitiveIntelligence/route.js
 *
 * Admin endpoints for Competitive Radar -> Competitor Sources.
 * In server.js (before app.listen):
 *   const { registerCompetitiveRadarRoute } = require('./modules/competitiveIntelligence/route');
 *   registerCompetitiveRadarRoute(app);
 *
 *  POST  /competitive-radar/sync/:clientId                     Basic Info -> competitors, then find sources for NEW ones
 *  POST  /competitive-radar/discover/:clientId                 "Find sources" for all competitors   body {force?}
 *  POST  /competitive-radar/discover/:clientId/:competitorId   "Find sources again" for one          body {force?, resetDomains?}
 *  GET   /competitive-radar/competitors/:clientId              list screen: competitors + sources + last runs
 *  PATCH /competitive-radar/competitors/:competitorId          admin fixes website / parent site / aliases
 *  POST  /competitive-radar/sources                            admin adds a source by hand
 *  PATCH /competitive-radar/sources/:sourceId                  admin approves / rejects / edits a source
 *
 * Finding sources takes 1-3 minutes per competitor, so those calls answer 202
 * straight away and the screen re-loads GET .../competitors/:clientId every few seconds.
 */

const { createClient } = require('@supabase/supabase-js');
const { syncCompetitorsForClient, listCiClients } = require('./competitorSync');
const { discoverCompetitor, discoverClient } = require('./discovery');
const { hostOf, rootDomain, clean } = require('./webTools');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = () => supabase.schema('admin');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_TYPES = ['news', 'own_site', 'press', 'blog', 'product'];
const URL_TYPES = ['press', 'blog', 'product'];
const QUERY_TYPES = ['news', 'own_site'];
const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const SOURCE_STATUSES = ['suggested', 'active', 'rejected'];

// one background job per client at a time (stops double clicks starting two runs)
const runningClients = new Set();

function runInBackground(clientId, label, job) {
  if (runningClients.has(clientId)) return false;
  runningClients.add(clientId);
  setImmediate(async () => {
    try {
      const out = await job();
      console.log(`[CI route] ${label} done`, Array.isArray(out) ? out.map((r) => `${r.competitor}:${r.status || r.skipped}`).join(', ') : '');
    } catch (e) {
      console.error(`[CI route] ${label} failed: ${e.message}`);
    } finally {
      runningClients.delete(clientId);
    }
  });
  return true;
}

const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, error: msg });

// "loreal.com", "https://www.loreal.com/en/" -> "loreal.com"; "" -> null; junk -> undefined
function cleanDomain(v) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  const host = hostOf(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  return host && host.includes('.') ? host : undefined;
}
function cleanUrl(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.includes('.') ? u.toString() : null;
  } catch (e) {
    return null;
  }
}

function registerCompetitiveRadarRoute(app) {
  // -------------------------------------------------------------------
  // Basic Information saved -> sync competitors, find sources for new ones
  // -------------------------------------------------------------------
  app.post('/competitive-radar/sync/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    try {
      const result = await syncCompetitorsForClient(clientId);
      // only spend Exa / Firecrawl on clients that have Competitive Intelligence switched on.
      // (If it is switched on later, the 15-minute auto-sync finds the sources then.)
      const ciOn = (await listCiClients()).includes(clientId);
      const started = ciOn && runInBackground(clientId, `sync+discover ${clientId}`, () =>
        discoverClient(clientId, { onlyPending: true, triggeredBy: 'onboarding' }));
      return res.status(202).json({
        ok: true,
        added: result.added,
        reactivated: result.reactivated,
        deactivated: result.deactivated,
        website_changed: result.changed,
        active: result.active.length,
        finding_sources: !ciOn ? 'not started - Competitive Intelligence module is off for this client' : (started ? 'started' : 'already running'),
      });
    } catch (e) {
      console.error(`[CI route] sync failed: ${e.message}`);
      return bad(res, e.message, 500);
    }
  });

  // -------------------------------------------------------------------
  // "Find sources" for all competitors of a client
  // -------------------------------------------------------------------
  app.post('/competitive-radar/discover/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const force = !!(req.body && req.body.force);
    const started = runInBackground(clientId, `discover all ${clientId}`, () =>
      discoverClient(clientId, { force, triggeredBy: 'manual' }));
    if (!started) return res.status(409).json({ ok: false, error: 'Already finding sources for this client. Please wait.' });
    return res.status(202).json({ ok: true, message: 'Finding sources started' });
  });

  // -------------------------------------------------------------------
  // "Find sources again" for one competitor
  // -------------------------------------------------------------------
  app.post('/competitive-radar/discover/:clientId/:competitorId', async (req, res) => {
    const { clientId, competitorId } = req.params;
    if (!UUID.test(clientId) || !UUID.test(competitorId)) return bad(res, 'bad id');
    const { data: comp, error } = await admin().from('competitors')
      .select('id, client_id, name, is_active').eq('id', competitorId).maybeSingle();
    if (error) return bad(res, error.message, 500);
    if (!comp || comp.client_id !== clientId) return bad(res, 'competitor not found for this client', 404);
    if (!comp.is_active) return bad(res, 'this competitor is switched off');

    const force = req.body && req.body.force !== undefined ? !!req.body.force : true; // button press = fresh search
    const resetDomains = !!(req.body && req.body.resetDomains);
    const started = runInBackground(clientId, `discover ${comp.name}`, async () =>
      [await discoverCompetitor(competitorId, { force, resetDomains, triggeredBy: 'manual' })]);
    if (!started) return res.status(409).json({ ok: false, error: 'Already finding sources for this client. Please wait.' });
    return res.status(202).json({ ok: true, message: `Finding sources for ${comp.name} started` });
  });

  // -------------------------------------------------------------------
  // List screen data
  // -------------------------------------------------------------------
  app.get('/competitive-radar/competitors/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const includeInactive = req.query.includeInactive === 'true';
    try {
      let q = admin().from('competitors').select('*').eq('client_id', clientId).order('name');
      if (!includeInactive) q = q.eq('is_active', true);
      const { data: comps, error: cErr } = await q;
      if (cErr) throw new Error(cErr.message);

      const ids = (comps || []).map((c) => c.id);
      let sources = [];
      let runs = [];
      if (ids.length) {
        const { data: s, error: sErr } = await admin().from('competitor_sources')
          .select('*').in('competitor_id', ids).order('source_type').order('created_at');
        if (sErr) throw new Error(sErr.message);
        sources = s || [];
        const { data: r, error: rErr } = await supabase.from('competitor_runs')
          .select('id, competitor_id, section, triggered_by, status, counts, error_message, started_at, finished_at')
          .eq('client_id', clientId).in('competitor_id', ids)
          .order('started_at', { ascending: false }).limit(ids.length * 20);
        if (rErr) throw new Error(rErr.message);
        runs = r || [];
      }

      const out = (comps || []).map((c) => {
        const mine = sources.filter((s) => s.competitor_id === c.id);
        const lastRun = {};
        for (const r of runs) if (r.competitor_id === c.id && !lastRun[r.section]) lastRun[r.section] = r;
        const group = (t) => mine.filter((s) => s.source_type === t);
        return {
          ...c,
          sections: {
            news: { sources: group('news'), last_run: lastRun.news || null },
            own_site: { sources: group('own_site'), last_run: lastRun.own_site || null },
            press: { sources: [...group('press'), ...group('blog')], last_run: lastRun.press || null },
            prices: { sources: group('product'), last_run: lastRun.product || null },
          },
          counts: {
            active_sources: mine.filter((s) => s.status === 'active').length,
            to_check: mine.filter((s) => s.status === 'suggested' || s.status === 'broken').length,
          },
          last_discovery: lastRun.discovery || null,
        };
      });
      return res.json({ ok: true, finding_now: runningClients.has(clientId), competitors: out });
    } catch (e) {
      console.error(`[CI route] list failed: ${e.message}`);
      return bad(res, e.message, 500);
    }
  });

  // -------------------------------------------------------------------
  // Admin fixes a competitor (shop website / company site / parent / aliases)
  // -------------------------------------------------------------------
  app.patch('/competitive-radar/competitors/:competitorId', async (req, res) => {
    const { competitorId } = req.params;
    if (!UUID.test(competitorId)) return bad(res, 'bad competitorId');
    const b = req.body || {};
    const patch = {};

    for (const f of ['shop_domain', 'company_domain']) {
      if (b[f] === undefined) continue;
      const d = cleanDomain(b[f]);
      if (d === undefined) return bad(res, `${f} is not a valid website`);
      patch[f] = d;
    }
    if (b.parent_group !== undefined) patch.parent_group = clean(b.parent_group, 120) || null;
    if (b.search_name !== undefined) patch.search_name = clean(b.search_name, 120) || null;
    if (b.aliases !== undefined) {
      if (!Array.isArray(b.aliases)) return bad(res, 'aliases must be a list');
      patch.aliases = [...new Set(b.aliases.map((a) => clean(a, 80)).filter(Boolean))].slice(0, 10);
    }
    if (!Object.keys(patch).length) return bad(res, 'nothing to change');

    const { data, error } = await admin().from('competitors').update(patch).eq('id', competitorId).select('*').maybeSingle();
    if (error) return bad(res, error.message, 500);
    if (!data) return bad(res, 'competitor not found', 404);

    // a new website means the sources must be found again (admin values are kept)
    let rediscover = 'not needed';
    if (b.rediscover !== false && (patch.shop_domain !== undefined || patch.company_domain !== undefined)) {
      rediscover = runInBackground(data.client_id, `rediscover ${data.name}`, async () =>
        [await discoverCompetitor(competitorId, { force: true, triggeredBy: 'manual' })]) ? 'started' : 'busy - press Find sources again later';
    }
    return res.json({ ok: true, competitor: data, finding_sources: rediscover });
  });

  // -------------------------------------------------------------------
  // Admin adds a source by hand
  // -------------------------------------------------------------------
  app.post('/competitive-radar/sources', async (req, res) => {
    const b = req.body || {};
    if (!UUID.test(b.competitor_id || '')) return bad(res, 'competitor_id is required');
    if (!SOURCE_TYPES.includes(b.source_type)) return bad(res, `source_type must be one of ${SOURCE_TYPES.join(', ')}`);

    const { data: comp, error: cErr } = await admin().from('competitors')
      .select('id, client_id').eq('id', b.competitor_id).maybeSingle();
    if (cErr) return bad(res, cErr.message, 500);
    if (!comp) return bad(res, 'competitor not found', 404);

    const row = {
      competitor_id: comp.id,
      client_id: comp.client_id,
      source_type: b.source_type,
      origin: 'admin',
      status: 'active',
      found_via: 'admin',
      check_frequency: FREQUENCIES.includes(b.check_frequency) ? b.check_frequency : (b.source_type === 'product' ? 'weekly' : 'daily'),
    };
    if (URL_TYPES.includes(b.source_type)) {
      row.url = cleanUrl(b.url);
      if (!row.url) return bad(res, 'a valid link is required');
      row.domain = rootDomain(hostOf(row.url));
      if (b.product_name) row.product_name = clean(b.product_name, 200);
    } else {
      row.query_text = clean(b.query_text, 300);
      if (!row.query_text) return bad(res, 'search sentence is required');
      if (b.source_type === 'own_site') {
        const d = cleanDomain(b.domain);
        if (d) row.domain = rootDomain(d);
      }
    }

    const { data, error } = await admin().from('competitor_sources').insert(row).select('*').single();
    if (error) {
      if (/duplicate key/i.test(error.message)) return bad(res, 'this source is already added', 409);
      return bad(res, error.message, 500);
    }
    return res.status(201).json({ ok: true, source: data });
  });

  // -------------------------------------------------------------------
  // Admin approves / rejects / edits a source
  // -------------------------------------------------------------------
  app.patch('/competitive-radar/sources/:sourceId', async (req, res) => {
    const { sourceId } = req.params;
    if (!UUID.test(sourceId)) return bad(res, 'bad sourceId');
    const b = req.body || {};

    const { data: src, error: sErr } = await admin().from('competitor_sources').select('*').eq('id', sourceId).maybeSingle();
    if (sErr) return bad(res, sErr.message, 500);
    if (!src) return bad(res, 'source not found', 404);

    const patch = {};
    if (b.status !== undefined) {
      if (!SOURCE_STATUSES.includes(b.status)) return bad(res, `status must be one of ${SOURCE_STATUSES.join(', ')}`);
      patch.status = b.status;
      if (b.status === 'active') patch.consecutive_failures = 0;
    }
    if (b.check_frequency !== undefined) {
      if (!FREQUENCIES.includes(b.check_frequency)) return bad(res, `check_frequency must be one of ${FREQUENCIES.join(', ')}`);
      patch.check_frequency = b.check_frequency;
    }
    if (b.url !== undefined) {
      if (!URL_TYPES.includes(src.source_type)) return bad(res, 'this source has no link (it uses a search sentence)');
      const u = cleanUrl(b.url);
      if (!u) return bad(res, 'a valid link is required');
      Object.assign(patch, { url: u, domain: rootDomain(hostOf(u)), last_status: null, last_error: null, consecutive_failures: 0 });
    }
    if (b.query_text !== undefined) {
      if (!QUERY_TYPES.includes(src.source_type)) return bad(res, 'this source uses a link, not a search sentence');
      const q = clean(b.query_text, 300);
      if (!q) return bad(res, 'search sentence cannot be empty');
      patch.query_text = q;
    }
    if (b.product_name !== undefined) patch.product_name = clean(b.product_name, 200) || null;
    if (!Object.keys(patch).length) return bad(res, 'nothing to change');

    // once the admin touches it, discovery never overrides it again
    patch.origin = 'admin';

    const { data, error } = await admin().from('competitor_sources').update(patch).eq('id', sourceId).select('*').single();
    if (error) {
      if (/duplicate key/i.test(error.message)) return bad(res, 'another source already has this link', 409);
      return bad(res, error.message, 500);
    }
    return res.json({ ok: true, source: data });
  });

  // -------------------------------------------------------------------
  // Safety net: the admin console saves Basic Information straight to Supabase.
  // Even if its call to /sync is missed, every N minutes we sync all CI clients
  // and find sources for NEW / CHANGED competitors. (CI_AUTO_SYNC_MINUTES=0 turns it off)
  // -------------------------------------------------------------------
  const everyMin = Number(process.env.CI_AUTO_SYNC_MINUTES ?? 15);
  if (everyMin > 0) {
    const tick = async () => {
      try {
        for (const clientId of await listCiClients()) {
          if (runningClients.has(clientId)) continue;
          const r = await syncCompetitorsForClient(clientId);
          const needs = r.active.some((c) => c.discovery_status === 'pending');
          if (needs) {
            runInBackground(clientId, `auto sync+discover ${clientId}`, () =>
              discoverClient(clientId, { onlyPending: true, includeFailed: false, triggeredBy: 'onboarding' }));
          }
        }
      } catch (e) {
        console.error(`[CI auto-sync] ${e.message}`);
      }
    };
    setTimeout(tick, 60 * 1000);                       // first run 1 minute after start
    setInterval(tick, everyMin * 60 * 1000).unref();
  }

  console.log('[CI] Competitive Radar routes registered');
}

module.exports = { registerCompetitiveRadarRoute };