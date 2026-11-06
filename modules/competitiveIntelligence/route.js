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
 *  POST  /competitive-radar/pages/:clientId                     check watched pages now  body {competitorId?, dryRun?, force?}
 *
 *  Daily news run (news / own website / press -> competitor changes):
 *  POST  /competitive-radar/news/:clientId          "Run now"   body {competitorId?, sections?, days?, dryRun?}
 *  GET   /competitive-radar/activity/:clientId      FRONTEND bottom section: live cards + their signals  ?competitorId=&category=&importance=&days=&limit=
 *  GET   /competitive-radar/changes/:clientId       saved changes (all statuses, newest first)  ?competitorId=&status=&limit=
 *  GET   /competitive-radar/log/:clientId           every article looked at + why    ?competitorId=&runId=&outcome=&limit=
 *  Daily run: at the client's schedule time from the admin console (modules/scheduler.js).
 *  Backup timer: CI_NEWS_TIME (India time, default 06:30), only for CI clients with no schedule time. CI_NEWS_TIME=off turns it off.
 *  Timer: every CI_REPAIR_MINUTES (default 30) re-sends changes that did not reach the chat database.
 *
 * Finding sources takes 1-3 minutes per competitor, so those calls answer 202
 * straight away and the screen re-loads GET .../competitors/:clientId every few seconds.
 */

const { createClient } = require('@supabase/supabase-js');
const { syncCompetitorsForClient, listCiClients } = require('./competitorSync');
const { discoverCompetitor, discoverClient } = require('./discovery');
const { hostOf, rootDomain, clean } = require('./webTools');
const cron = require('node-cron');
const { runNewsForClient, closeStuckRuns, isRunning: newsIsRunning, summarise } = require('./newsRun');
const { repairPendingChanges } = require('./changeStore');
const { runPagesForClient, detectPageType } = require('./pageWatch');

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
    const b = { ...(req.body || {}) };
    if (!UUID.test(b.competitor_id || '')) return bad(res, 'competitor_id is required');
    // admin only pastes a link: we decide if it is a LIST page (blog / news category -> new posts are read)
    // or a SINGLE page (product / pricing -> its content is compared every day)
    let detected = null;
    if ((!b.source_type || b.source_type === 'auto') && b.url) {
      const u = cleanUrl(b.url);
      if (!u) return bad(res, 'a valid link is required');
      detected = await detectPageType(u);
      b.source_type = detected.type;
    }
    if (!SOURCE_TYPES.includes(b.source_type)) return bad(res, `source_type must be one of ${SOURCE_TYPES.join(', ')} (or 'auto' with a url)`);

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
      check_frequency: FREQUENCIES.includes(b.check_frequency) ? b.check_frequency : 'daily',
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
    return res.status(201).json({ ok: true, source: data, detected: detected ? detected.note : undefined });
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

  // -------------------------------------------------------------------
  // Daily news run: "Run now"
  // dryRun = read everything, save nothing, answer with the full report (takes minutes)
  // -------------------------------------------------------------------
  app.post('/competitive-radar/news/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const b = req.body || {};
    if (b.competitorId && !UUID.test(b.competitorId)) return bad(res, 'bad competitorId');
    const sections = Array.isArray(b.sections) ? b.sections.filter((x) => ['press', 'blog', 'own_site', 'news'].includes(x)) : undefined;
    const days = b.days !== undefined ? Number(b.days) : undefined;
    if (days !== undefined && !(days >= 1 && days <= 60)) return bad(res, 'days must be 1 to 60');
    const opts = { competitorId: b.competitorId, sections, days, dryRun: !!b.dryRun, triggeredBy: 'manual' };

    if (newsIsRunning(clientId)) return res.status(409).json({ ok: false, error: 'News run already going for this client. Please wait.' });
    if (opts.dryRun) {
      try {
        return res.json({ ok: true, dryRun: true, result: await runNewsForClient(clientId, opts) });
      } catch (e) {
        return bad(res, e.message, 500);
      }
    }
    setImmediate(async () => {
      try {
        const r = await runNewsForClient(clientId, opts);
        console.log(`[CI news] manual run done ${clientId}`, JSON.stringify(summarise(r)));
      } catch (e) {
        console.error(`[CI news] manual run failed ${clientId}: ${e.message}`);
      }
    });
    return res.status(202).json({ ok: true, message: 'News run started. Check GET /competitive-radar/competitors/:clientId (last_run per section) or the log.' });
  });

  // -------------------------------------------------------------------
  // Page watch: "Check pages now" (product / pricing pages compared with the last copy)
  // body {competitorId?, dryRun?, force?}  force = check even pages not due today
  // -------------------------------------------------------------------
  app.post('/competitive-radar/pages/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const b = req.body || {};
    if (b.competitorId && !UUID.test(b.competitorId)) return bad(res, 'bad competitorId');
    const opts = { competitorId: b.competitorId, dryRun: !!b.dryRun, force: !!b.force, triggeredBy: 'manual' };
    if (opts.dryRun) {
      try {
        return res.json({ ok: true, dryRun: true, result: await runPagesForClient(clientId, opts) });
      } catch (e) {
        return bad(res, e.message, 500);
      }
    }
    setImmediate(async () => {
      try {
        const r = await runPagesForClient(clientId, opts);
        console.log(`[CI pages] manual run done ${clientId}`, JSON.stringify((r.competitors || []).map((c) => ({ competitor: c.competitor, ...(c.counts || {}), skipped: c.skipped }))));
      } catch (e) {
        console.error(`[CI pages] manual run failed ${clientId}: ${e.message}`);
      }
    });
    return res.status(202).json({ ok: true, message: 'Page check started. See GET /competitive-radar/log/:clientId for each page.' });
  });

  // -------------------------------------------------------------------
  // Saved changes (for checking; the CI tab itself reads competitor_changes_live)
  // -------------------------------------------------------------------
  // -------------------------------------------------------------------
  // FRONTEND: bottom section "Competitor activity"
  // GET /competitive-radar/activity/:clientId   ?competitorId=&category=&importance=High,Critical&days=90&limit=100
  // One CARD per event (title, summary, business impact, category, importance, signal count, updated date)
  // with its SIGNALS (each source: title, summary, main + sub category, date, link, source type).
  // Only live cards: saved, checked and in the chat (competitor_changes_live / competitor_signals_live).
  // -------------------------------------------------------------------
  const SOURCE_LABEL = { news: 'News', press: 'Press release', blog: 'Blog', own_site: 'Company website', product: 'Product page' };
  app.get('/competitive-radar/activity/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    // all cards, any date. Only when ?days=N is given, cards older than N days are left out.
    let q = supabase.from('competitor_changes_live')
      .select('id, competitor_id, organization, category, signal_name, signal_title, summary, business_impact, importance, signal_count, last_signal_at, card_written_at, event_date, country')
      .eq('client_id', clientId)
      .order('last_signal_at', { ascending: false, nullsFirst: false }).order('event_date', { ascending: false }).limit(limit);
    if (Number(req.query.days) > 0) q = q.gte('event_date', new Date(Date.now() - Number(req.query.days) * 864e5).toISOString().slice(0, 10));
    if (req.query.competitorId && UUID.test(req.query.competitorId)) q = q.eq('competitor_id', req.query.competitorId);
    if (req.query.category) q = q.eq('category', String(req.query.category));
    if (req.query.importance) q = q.in('importance', String(req.query.importance).split(',').map((x) => x.trim()));
    const { data: cards, error } = await q;
    if (error) return bad(res, error.message, 500);
    const ids = (cards || []).map((c) => c.id);
    let sigs = [];
    if (ids.length) {
      const { data, error: e2 } = await supabase.from('competitor_signals_live')
        .select('id, change_id, signal_title, summary, category, signal_name, event_date, published_date, url, source_domain, source_kind, key_facts')
        .in('change_id', ids).order('event_date', { ascending: false });
      if (e2) return bad(res, e2.message, 500);
      sigs = data || [];
    }
    const out = (cards || []).map((c) => {
      const signals = sigs.filter((s) => s.change_id === c.id).map((s) => ({
        id: s.id,
        title: s.signal_title,
        summary: s.summary || '',
        category: s.category,              // main category
        sub_category: s.signal_name,       // sub category
        date: s.event_date || s.published_date,
        url: s.url,
        source: s.source_domain,
        source_type: SOURCE_LABEL[s.source_kind] || s.source_kind,
        key_facts: Array.isArray(s.key_facts) ? s.key_facts : [],
      }));
      return {
        id: c.id,
        competitor_id: c.competitor_id,
        competitor: c.organization,
        category: c.category,              // main category (the group on the screen)
        sub_category: c.signal_name,
        title: c.signal_title,
        summary: c.summary,
        business_impact: Array.isArray(c.business_impact) ? c.business_impact : [],
        importance: c.importance,
        signal_count: signals.length || c.signal_count || 1,
        updated: c.card_written_at || c.last_signal_at || c.event_date,   // when the card was made or last rewritten (new signal added)
        latest_news_date: c.last_signal_at || c.event_date,               // date of the newest news inside the card
        country: c.country,
        signals,
      };
    });
    const categories = Object.entries(out.reduce((m, c) => ({ ...m, [c.category]: (m[c.category] || 0) + 1 }), {}))
      .map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    res.json({ client_id: clientId, total: out.length, categories, cards: out });
  });

  // -------------------------------------------------------------------
  // FRONTEND: "Who is where" - per competitor + type: signals in the last 30 days, overall total, arrow vs the day before
  // GET /competitive-radar/who-is-where/:clientId          ?refresh=true  -> count again for today first
  // -------------------------------------------------------------------
  app.get('/competitive-radar/who-is-where/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    if (req.query.refresh === 'true') {
      try { await require('./activity').refreshActivity(clientId); } catch (e) { return bad(res, e.message, 500); }
    }
    const { data, error } = await supabase.from('competitor_activity_live')
      .select('competitor_id, competitor, category, day, window_from, count_30d, prev_from, prev_to, prev_count_30d, change_30d, trend, count_total')
      .eq('client_id', clientId).order('competitor').order('category');
    if (error) return bad(res, error.message, 500);
    const byComp = new Map();
    for (const r of data || []) {
      if (!byComp.has(r.competitor_id)) byComp.set(r.competitor_id, { competitor_id: r.competitor_id, competitor: r.competitor, all: null, categories: [] });
      const cell = { category: r.category, count_30d: r.count_30d, count_total: r.count_total, prev_count_30d: r.prev_count_30d, change_30d: r.change_30d, trend: r.trend };
      if (r.category === 'All') byComp.get(r.competitor_id).all = cell; else byComp.get(r.competitor_id).categories.push(cell);
    }
    const r0 = data && data[0];
    const day = r0 ? r0.day : null;
    return res.json({ client_id: clientId, day,
      window: r0 ? { from: r0.window_from, to: r0.day } : null,                 // this 30 days, e.g. Oct 6 .. Nov 6
      compared_with: r0 ? { from: r0.prev_from, to: r0.prev_to } : null,      // the 30 days before, e.g. Sep 6 .. Oct 5
      competitors: [...byComp.values()] });
  });

  app.get('/competitive-radar/changes/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    let q = supabase.from('competitor_changes')
      .select('id, organization, category, signal_name, signal_title, summary, importance, confidence, event_date, source_kind, status, status_reason, qdrant_synced_at, related_change_ids, found_at, competitor_change_evidence(url, source_kind, published_date)')
      .eq('client_id', clientId).order('event_date', { ascending: false }).limit(limit);
    if (req.query.competitorId && UUID.test(req.query.competitorId)) q = q.eq('competitor_id', req.query.competitorId);
    if (req.query.status) q = q.eq('status', String(req.query.status));
    const { data, error } = await q;
    if (error) return bad(res, error.message, 500);
    const rows = (data || []).map(({ competitor_change_evidence: ev, ...c }) => ({ ...c, sources: ev || [], source_count: (ev || []).length }));
    const byStatus = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
    return res.json({ ok: true, total: rows.length, by_status: byStatus, changes: rows });
  });

  // -------------------------------------------------------------------
  // Every article looked at, and what happened to it ("why is X not shown?")
  // -------------------------------------------------------------------
  app.get('/competitive-radar/log/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    let q = supabase.from('competitor_ingestion_log')
      .select('created_at, competitor_id, source_kind, outcome, reason, title, url, change_id, details, run_id')
      .eq('client_id', clientId).order('created_at', { ascending: false }).limit(limit);
    if (req.query.competitorId && UUID.test(req.query.competitorId)) q = q.eq('competitor_id', req.query.competitorId);
    if (req.query.runId && UUID.test(req.query.runId)) q = q.eq('run_id', req.query.runId);
    if (req.query.outcome) q = q.eq('outcome', String(req.query.outcome));
    const { data, error } = await q;
    if (error) return bad(res, error.message, 500);
    const byOutcome = (data || []).reduce((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] || 0) + 1 }), {});
    return res.json({ ok: true, total: (data || []).length, by_outcome: byOutcome, log: data || [] });
  });

  // -------------------------------------------------------------------
  // Backup timer: daily CI run for CI clients WITHOUT a schedule time in the admin console
  // (clients with a schedule time are run by the admin scheduler, modules/scheduler.js)
  // -------------------------------------------------------------------
  const newsTime = String(process.env.CI_NEWS_TIME || '06:30').trim();
  const m = newsTime.match(/^(\d{1,2}):(\d{2})$/);
  if (newsTime.toLowerCase() !== 'off' && m) {
    cron.schedule(`${Number(m[2])} ${Number(m[1])} * * *`, async () => {
      console.log('[CI news] daily run starting');
      try {
        await closeStuckRuns();
        // clients with a schedule time in the admin console are run by the admin scheduler (modules/scheduler.js);
        // this timer is only the backup for CI clients that have NO schedule time set
        const { data: scheduled } = await admin().from('prompts').select('client_id')
          .eq('is_active', true).eq('status', 'Running').not('schedule_time', 'is', null);
        const hasSchedule = new Set((scheduled || []).map((x) => x.client_id));
        for (const clientId of await listCiClients()) {
          if (hasSchedule.has(clientId)) continue;
          const r = await runNewsForClient(clientId, { triggeredBy: 'schedule' });
          console.log(`[CI news] daily run ${clientId}`, JSON.stringify(summarise(r)));
          // then the watched pages (product / pricing pages): compare with the last copy
          try {
            const p = await runPagesForClient(clientId, { triggeredBy: 'schedule' });
            console.log(`[CI pages] daily run ${clientId}`, JSON.stringify((p.competitors || []).map((c) => ({ competitor: c.competitor, ...(c.counts || {}), skipped: c.skipped, error: c.error }))));
          } catch (e) {
            console.error(`[CI pages] daily run ${clientId} failed: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`[CI news] daily run failed: ${e.message}`);
      }
    }, { timezone: 'Asia/Kolkata' });
    console.log(`[CI] daily news run set for ${newsTime} India time`);
  } else {
    console.log(`[CI] daily news run is OFF (CI_NEWS_TIME=${newsTime})`);
  }

  // Timer: changes that did not reach the chat database yet -> try again; old 'running' runs -> failed
  const repairMin = Number(process.env.CI_REPAIR_MINUTES ?? 30);
  if (repairMin > 0) {
    setInterval(async () => {
      try {
        const r = await repairPendingChanges();
        const stuck = await closeStuckRuns();
        if (r.checked || stuck) console.log(`[CI repair] chat copies fixed ${r.fixed}/${r.checked}, stuck runs closed ${stuck}`);
      } catch (e) {
        console.error(`[CI repair] ${e.message}`);
      }
    }, repairMin * 60 * 1000).unref();
  }

  console.log('[CI] Competitive Radar routes registered');
}

module.exports = { registerCompetitiveRadarRoute };