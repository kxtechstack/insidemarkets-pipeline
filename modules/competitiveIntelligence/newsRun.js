/**
 * modules/competitiveIntelligence/newsRun.js
 *
 * The DAILY NEWS RUN for Competitive Radar. Puts the 3 steps together:
 *   collector.js  -> find new articles (press, blog list pages, own website, news)
 *   reader.js     -> AI reads each one, code checks the answer
 *   changeStore.js-> save the change (or join it to the same event), copy to the chat database
 *
 * One competitor at a time, one section at a time:
 *   press first, then own website, then news
 *   (the competitor's own words first, so news articles about the same event join them)
 *
 * Everything is written down:
 *   public.competitor_runs          one row per competitor + section (counters for the admin card)
 *   public.competitor_ingestion_log one row per article looked at, with what happened and why
 *
 * dryRun = true: does all the reading, saves NOTHING (for testing - see scripts/ci-news-test.js).
 */

const { createClient } = require('@supabase/supabase-js');
const { CI_MODULE_ID, LIMITS } = require('./constants');
const { clean, hostOf, rootDomain, makeCounter, countryProfileFor } = require('./webTools');
const WIRE_HOSTS = /(^|\.)(businesswire|globenewswire|prnewswire|accesswire|newswire|prweb|mynewsdesk|presseportal)\.[a-z.]+$/i;
const collector = require('./collector');
const reader = require('./reader');
const store = require('./changeStore');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = () => supabase.schema('admin');

const SECTIONS = ['press', 'blog', 'own_site', 'news']; // blog = a list page of posts the admin added (read like press)

// '...?utm_source=x#top' / 'www.' / trailing '/' do not make a different article
function urlKey(u) {
  try {
    const x = new URL(u);
    // keep only parameters that pick the article itself (?id=, ?dockey=, ?p=); drop language, tracking and feed tags (?l=12, ?.tsrc=rss)
    const params = [...x.searchParams.entries()].filter(([k]) => /^(id|p|page_?id|post|aid|nid|sid|pid|cid|article\w*|story\w*|doc\w*|news\w*|item\w*)$/i.test(k));
    const q = params.length ? `?${new URLSearchParams(params).toString()}` : '';
    return `${x.hostname.replace(/^www\./, '').toLowerCase()}${x.pathname.replace(/\/+$/, '')}${q}`;
  } catch (e) {
    return String(u || '').toLowerCase().trim();
  }
}

// ---------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------
async function startRun(clientId, competitorId, section, triggeredBy) {
  const { data, error } = await supabase.from('competitor_runs')
    .insert({ client_id: clientId, competitor_id: competitorId, section, triggered_by: triggeredBy, status: 'running' })
    .select('id').single();
  if (error) throw new Error(`could not start run: ${error.message}`);
  return data.id;
}
async function finishRun(runId, status, counts, errorMessage = null) {
  await supabase.from('competitor_runs')
    .update({ status, counts, error_message: errorMessage, finished_at: new Date().toISOString() }).eq('id', runId);
}

async function logItem(row) {
  const { error } = await supabase.from('competitor_ingestion_log').insert(row);
  if (error) console.log(`[CI news] log write failed: ${error.message}`);
}

/** Links already looked at for this competitor (failed ones are NOT here, so they are tried again) */
async function loadSeen(clientId, competitorId) {
  const since = new Date(Date.now() - 120 * 864e5).toISOString();
  const seen = new Set();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from('competitor_ingestion_log').select('url')
      .eq('client_id', clientId).eq('competitor_id', competitorId).neq('outcome', 'failed')
      .gte('created_at', since).range(from, from + 999);
    if (error) throw new Error(`could not read the log: ${error.message}`);
    (data || []).forEach((r) => r.url && seen.add(urlKey(r.url)));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return seen;
}

/** Articles that failed in the last days (AI down, etc.) and never succeeded later */
async function loadFailedToRetry(clientId, competitorId, seen) {
  const since = new Date(Date.now() - LIMITS.RETRY_FAILED_DAYS * 864e5).toISOString();
  const { data } = await supabase.from('competitor_ingestion_log').select('url, title, source_kind, source_id')
    .eq('client_id', clientId).eq('competitor_id', competitorId).eq('outcome', 'failed')
    .gte('created_at', since).order('created_at', { ascending: false }).limit(30);
  const out = new Map();
  for (const r of data || []) {
    const k = urlKey(r.url);
    if (r.url && !seen.has(k) && !out.has(k)) out.set(k, r);
  }
  return [...out.values()].slice(0, 5);
}

/** How far back to look: since the last good run of this section (2-7 days), or 30 days the first time */
async function lookbackDays(competitorId, section) {
  const { data } = await supabase.from('competitor_runs').select('started_at')
    .eq('competitor_id', competitorId).eq('section', section).eq('status', 'completed')
    .order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return { days: LIMITS.NEWS_FIRST_RUN_DAYS, first: true };
  const days = Math.ceil((Date.now() - new Date(data.started_at).getTime()) / 864e5) + 1;
  return { days: Math.min(LIMITS.NEWS_MAX_DAYS, Math.max(LIMITS.NEWS_MIN_DAYS, days)), first: false, lastRun: data.started_at };
}

// a problem of the SEARCH SERVICE (no credits, wrong key, too many calls, service down) is not the source's fault:
// it is shown on the source, but never counts towards "broken" (otherwise every source switches off when credits run out)
const SERVICE_PROBLEM = /NO_MORE_CREDITS|credits? limit|exceeded your credits|\b(Exa|Firecrawl|Tavily)\b[^:]*HTTP (401|402|403|429|5\d\d)\b|rate.?limit/i;
const isServiceProblem = (note) => SERVICE_PROBLEM.test(String(note || ''));

async function updateSourceHealth(source, health, note) {
  const failed = health === 'failed';
  const service = failed && isServiceProblem(note);
  const patch = {
    last_checked_at: new Date().toISOString(),
    last_status: health,
    last_error: health === 'ok' ? null : clean(note, 300),
    consecutive_failures: service ? (source.consecutive_failures || 0) : failed ? (source.consecutive_failures || 0) + 1 : 0,
  };
  if (failed && !service && patch.consecutive_failures >= 3 && source.status === 'active') patch.status = 'broken';
  if (service) console.log(`[CI news] SEARCH SERVICE PROBLEM (not the source's fault): ${clean(note, 160)}`);
  await admin().from('competitor_sources').update(patch).eq('id', source.id);
}

async function loadClient(clientId) {
  const { data: client, error } = await admin().from('clients')
    .select('id, company_name, industry, location, status, enabled_modules').eq('id', clientId).maybeSingle();
  if (error || !client) throw new Error(`client ${clientId} not found`);
  let location = client.location;
  if (!location) {
    const { data: icp } = await admin().from('client_icp').select('context_json').eq('client_id', clientId).maybeSingle();
    const j = (icp && icp.context_json) || {};
    location = j.location || j.headquarters || j.hq_location || j.country || null;
  }
  const profile = countryProfileFor(location);
  return { ...client, country: profile.name || location || null };
}

// ---------------------------------------------------------------------
// One competitor
// ---------------------------------------------------------------------
/**
 * @param {string} competitorId
 * @param {object} opts
 *   triggeredBy  'manual' | 'schedule' | 'retry'
 *   sections     subset of ['press', 'own_site', 'news']
 *   days         force the look-back (e.g. 30 for a test)
 *   dryRun       read everything, save nothing
 *   signals      already loaded signals (when called for a whole client)
 */
async function runNewsForCompetitor(competitorId, opts = {}) {
  const triggeredBy = opts.triggeredBy || 'manual';
  const dryRun = !!opts.dryRun;
  const { data: comp, error } = await admin().from('competitors').select('*').eq('id', competitorId).maybeSingle();
  if (error || !comp) throw new Error(`competitor ${competitorId} not found`);
  const result = { competitor: comp.name, competitor_id: comp.id, dryRun, sections: {} };
  if (!comp.is_active) return { ...result, skipped: 'competitor is switched off' };
  if (['pending', 'finding'].includes(comp.discovery_status)) return { ...result, skipped: `sources not ready yet (${comp.discovery_status})` };

  const client = opts.client || await loadClient(comp.client_id);
  const signals = opts.signals || await reader.loadSignals(comp.client_id);
  if (!signals.enabledCount) return { ...result, skipped: 'no Competitive Intelligence signals ticked for this client (Monitoring Scope)' };

  const { data: others } = await admin().from('competitors').select('name')
    .eq('client_id', comp.client_id).eq('is_active', true).neq('id', comp.id);
  const { data: sources } = await admin().from('competitor_sources').select('*')
    .eq('competitor_id', comp.id).eq('status', 'active').in('source_type', SECTIONS);

  const ctx = {
    client,
    comp,
    otherCompetitors: (others || []).map((o) => o.name),
    signals,
    terms: collector.brandTerms(comp),
  };
  const seen = await loadSeen(comp.client_id, comp.id);
  const doneThisRun = new Set(); // same link in two sections -> read once
  const budget = { firecrawl: LIMITS.MAX_FIRECRAWL_PER_NEWS_RUN };
  const wanted = (opts.sections && opts.sections.length ? opts.sections : SECTIONS).filter((s) => SECTIONS.includes(s));

  // articles that failed last time go first, in their own section
  const retry = dryRun ? [] : await loadFailedToRetry(comp.client_id, comp.id, seen);

  for (const section of wanted) {
    const mySources = (sources || []).filter((s) => s.source_type === section);
    const myRetry = retry.filter((r) => r.source_kind === section);
    if (!mySources.length && !myRetry.length) {
      result.sections[section] = { skipped: 'no active source' };
      continue;
    }

    const lb = opts.days ? { days: Number(opts.days), first: false } : await lookbackDays(comp.id, section);
    const since = new Date(Date.now() - lb.days * 864e5).toISOString();
    // how many articles the AI may read in this section: long look-back (first run / --days 60, 90) reads more
    const longLookBack = lb.days > LIMITS.NEWS_FIRST_RUN_DAYS;
    const maxReads = longLookBack ? Math.max(LIMITS.MAX_AI_READS_FIRST_RUN, Number(process.env.CI_BACKFILL_READS) || 60)
      : lb.first || lb.days > LIMITS.NEWS_MAX_DAYS ? LIMITS.MAX_AI_READS_FIRST_RUN
      : Math.max(LIMITS.MAX_AI_READS_PER_SECTION, Number(process.env.CI_DAILY_READS) || 30);
    const counter = makeCounter();
    const counts = { look_back_days: lb.days, fetched: 0, after_url_check: 0, read_by_ai: 0, saved: 0, merged: 0, dropped: 0, failed: 0, left_for_next_run: 0, retried: 0 };
    const report = { since: since.slice(0, 10), counts, notes: [], items: [] };
    result.sections[section] = report;
    const runId = dryRun ? null : await startRun(comp.client_id, comp.id, section, triggeredBy);

    try {
      // ---- 1) collect ----
      let items = [];
      for (const src of mySources) {
        try {
          if (section === 'news') {
            items.push(...await collector.collectNews(src, since, counter));
            // + one search per ticked category of this client, so every category gets news
            const t = await collector.collectTopicNews(src, comp, signals, since, counter);
            items.push(...t.items);
            if (t.topics) report.notes.push(`category searches: ${t.topics} categories, ${t.searches} searches (${t.items.length} links)`);
          }
          else if (section === 'own_site') items.push(...await collector.collectOwnSite(src, comp, since, counter));
          else {
            const r = await collector.collectPress(src, comp, since, maxReads, budget, counter);
            items.push(...r.items.map((x) => ({ ...x, section }))); // press or blog
            report.notes.push(`${src.url}: ${r.note}`);
            if (!dryRun) await updateSourceHealth(src, r.health, r.note);
            continue;
          }
          if (!dryRun) await updateSourceHealth(src, 'ok');
        } catch (e) {
          report.notes.push(`${src.url || src.query_text}: ${clean(e.message, 200)}`);
          if (!dryRun) await updateSourceHealth(src, 'failed', e.message);
        }
      }
      for (const r of myRetry) {
        const a = await collector.readArticle(r.url, budget, counter);
        items.push({ url: r.url, title: a.title || r.title, text: a.text, publishedDate: a.date, section, sourceId: r.source_id, via: `retry+${a.via}`, isRetry: true });
        counts.retried++;
      }
      counts.fetched = items.length;

      // ---- 2) drop links already looked at ----
      const fresh = [];
      for (const it of items) {
        const k = urlKey(it.url);
        if ((seen.has(k) && !it.isRetry) || doneThisRun.has(k)) continue;
        doneThisRun.add(k);
        fresh.push(it);
      }
      counts.after_url_check = fresh.length;
      // the company's own copy first (its own website, or a press wire like Business Wire / PR Newswire), then the newest:
      // the same-news check keeps the FIRST copy it sees, so the own copy is the one that is kept
      const ownRoots = [comp.company_domain, comp.shop_domain].filter(Boolean).map((d) => rootDomain(hostOf(d.includes('://') ? d : `https://${d}`)));
      const isOwn = (u) => { const h = hostOf(u); return WIRE_HOSTS.test(h) || ownRoots.includes(rootDomain(h)); };
      fresh.sort((a, b) => (isOwn(b.url) - isOwn(a.url)) || String(b.publishedDate || '').localeCompare(String(a.publishedDate || '')));

      // ---- 3) code checks, then AI, then save ----
      let aiReads = 0;
      for (const it of fresh) {
        const base = {
          run_id: runId, client_id: comp.client_id, competitor_id: comp.id, source_id: it.sourceId || null,
          source_kind: section, url: it.url, title: clean(it.title, 300) || null,
        };
        const pre = collector.precheck(it, comp, ctx.terms, since, { ownSite: section === 'own_site', ownBlog: section === 'blog', press: section === 'press', ignoreAge: !!it.isRetry });
        if (pre) {
          counts.dropped++;
          report.items.push({ url: it.url, title: it.title, date: it.publishedDate, outcome: 'dropped', reason: pre, step: 'code check' });
          if (!dryRun) await logItem({ ...base, outcome: 'dropped', reason: pre, details: { via: it.via, step: 'code check' } });
          continue;
        }
        // same news already saved / kept (another site) -> no AI call
        if (!ctx.knownNews) ctx.knownNews = await store.loadKnownNews(comp.client_id, comp).catch(() => []);
        const sameNews = await store.findSameNews(it, ctx.knownNews, comp).catch(() => null);
        if (sameNews) {
          const why = `same news as an article we already have (${clean(sameNews.title, 80)} - ${hostOf(sameNews.url)}, ${sameNews.why || sameNews.score.toFixed(2)})`;
          counts.dropped++;
          report.items.push({ url: it.url, title: it.title, date: it.publishedDate, outcome: 'dropped', reason: why, step: 'same news check' });
          if (!dryRun) await logItem({ ...base, outcome: 'dropped', reason: why, details: { via: it.via, step: 'same news check', same_as: sameNews.url } });
          continue;
        }
        if (aiReads >= maxReads) { counts.left_for_next_run++; continue; }
        aiReads++;
        counts.read_by_ai++;

        let read;
        try {
          read = await reader.readArticle(it, ctx);
        } catch (e) {
          read = { outcome: 'failed', reason: clean(e.message, 200) };
        }
        const line = { url: it.url, title: it.title, date: it.publishedDate, mentions: it.mentions, via: it.via, ai: read.ai };

        if (read.outcome !== 'keep') {
          counts[read.outcome === 'failed' ? 'failed' : 'dropped']++;
          report.items.push({ ...line, outcome: read.outcome, reason: read.reason, step: 'AI' });
          if (!dryRun) await logItem({ ...base, outcome: read.outcome === 'failed' ? 'failed' : 'dropped', reason: read.reason, details: { via: it.via, step: 'AI', ai: read.ai || null } });
          continue;
        }

        const c = read.change;
        store.rememberNews(it, ctx.knownNews, comp, c); // later articles of this run are checked against it too
        const shown = {
          signal: c.signal.name, type: c.signal.category, title: c.title, summary: c.summary, importance: c.importance,
          event_date: c.event_date, event_date_from: c.event_date_from, key_facts: c.key_facts, also_involves: c.also_involves,
        };
        if (dryRun) {
          counts.saved++;
          report.items.push({ ...line, outcome: 'would save', change: shown, step: 'AI' });
          continue;
        }
        try {
          const s = await store.saveChange({ clientId: comp.client_id, comp, item: it, change: c, runId, country: client.country });
          counts[s.outcome]++;
          report.items.push({ ...line, outcome: s.outcome, change: shown, change_id: s.changeId, in_chat: s.verified, merged_by: s.mergedBy });
          await logItem({
            ...base, outcome: s.outcome, change_id: s.changeId,
            reason: s.outcome === 'merged' ? `same event as an existing change (${s.mergedBy})` : null,
            details: { via: it.via, signal: c.signal.name, importance: c.importance, event_date: c.event_date, in_chat: s.verified },
          });
        } catch (e) {
          counts.failed++;
          report.items.push({ ...line, outcome: 'failed', reason: clean(e.message, 200), step: 'save' });
          await logItem({ ...base, outcome: 'failed', reason: `save failed: ${clean(e.message, 200)}`, details: { via: it.via, step: 'save' } });
        }
      }

      Object.assign(counts, { exa_calls: counter.exa, firecrawl_calls: counter.firecrawl });
      if (!dryRun) await finishRun(runId, 'completed', counts, report.notes.join(' | ').slice(0, 1000) || null);
    } catch (e) {
      report.error = e.message;
      Object.assign(counts, { exa_calls: counter.exa, firecrawl_calls: counter.firecrawl });
      if (!dryRun) await finishRun(runId, 'failed', counts, clean(e.message, 500));
      console.error(`[CI news] ${comp.name} / ${section} failed: ${e.message}`);
    }
    console.log(`[CI news] ${comp.name} / ${section}: ${JSON.stringify(counts)}`);
  }
  // cards that are new or got a new signal: write title, combined summary and business impact
  if (!dryRun) {
    try {
      result.joined = await store.joinSplitCards(comp.client_id, comp).catch((e) => ({ joined: 0, notes: [`join failed: ${e.message}`] }));
      result.cards = await require('./cardWriter').writeDueCards(comp.client_id, { competitorId: comp.id });
    } catch (e) {
      console.error(`[CI cards] ${comp.name}: ${e.message}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// One client (all its competitors)
// ---------------------------------------------------------------------
const running = new Set();
const isRunning = (clientId) => running.has(clientId);

async function runNewsForClient(clientId, opts = {}) {
  if (running.has(clientId)) return { clientId, skipped: 'already running for this client' };
  running.add(clientId);
  try {
    const client = await loadClient(clientId);
    if (!(client.enabled_modules || []).includes(CI_MODULE_ID)) return { clientId, skipped: 'Competitive Intelligence is off for this client' };
    if (opts.triggeredBy === 'schedule' && client.status && client.status.toLowerCase() !== 'active') {
      return { clientId, skipped: `client is ${client.status}` };
    }
    const signals = await reader.loadSignals(clientId);
    if (!signals.enabledCount) return { clientId, skipped: 'no Competitive Intelligence signals ticked (Monitoring Scope)' };

    let q = admin().from('competitors').select('id, name, last_discovered_at').eq('client_id', clientId).eq('is_active', true).order('name');
    if (opts.competitorId) q = q.eq('id', opts.competitorId);
    const { data: comps } = await q;

    const out = [];
    for (const c of comps || []) {
      // scheduled run: skip a competitor already done in the last 20 hours (e.g. laptop + server both on)
      if (opts.triggeredBy === 'schedule' && !opts.dryRun) {
        const { data: recent } = await supabase.from('competitor_runs').select('id')
          .eq('competitor_id', c.id).eq('section', 'news').in('status', ['completed', 'running'])
          .gte('started_at', new Date(Date.now() - 20 * 3600e3).toISOString()).limit(1);
        if (recent && recent.length) { out.push({ competitor: c.name, skipped: 'already ran in the last 20 hours' }); continue; }
      }
      try {
        out.push(await runNewsForCompetitor(c.id, { ...opts, client, signals }));
      } catch (e) {
        console.error(`[CI news] ${c.name} failed: ${e.message}`);
        out.push({ competitor: c.name, error: e.message });
      }
    }
    // "who is moving where": worked out here at the end of the run and saved (the screen only reads it)
    if (!opts.dryRun) await require('./activity').refreshActivitySafe(clientId);
    return { clientId, client: client.company_name, competitors: out };
  } finally {
    running.delete(clientId);
  }
}

/** Runs left 'running' by a server restart -> failed (so counters and logs are honest) */
async function closeStuckRuns() {
  const cutoff = new Date(Date.now() - LIMITS.RUN_STUCK_HOURS * 3600e3).toISOString();
  const { data } = await supabase.from('competitor_runs')
    .update({ status: 'failed', error_message: 'stopped (server restarted during the run)', finished_at: new Date().toISOString() })
    .eq('status', 'running').in('section', [...SECTIONS, 'product']).lt('started_at', cutoff).select('id');
  return (data || []).length;
}

/** Short summary line per competitor (for logs and the API answer) */
function summarise(res) {
  if (!res || !res.competitors) return res;
  return res.competitors.map((c) => {
    if (c.skipped || c.error) return { competitor: c.competitor, skipped: c.skipped, error: c.error };
    const s = {};
    for (const [k, v] of Object.entries(c.sections || {})) {
      s[k] = v.skipped ? v.skipped : `${v.counts.saved} saved, ${v.counts.merged} joined, ${v.counts.dropped} dropped, ${v.counts.failed} failed (of ${v.counts.fetched} found)`;
    }
    return { competitor: c.competitor, ...s };
  });
}

module.exports = { runNewsForCompetitor, runNewsForClient, closeStuckRuns, isRunning, summarise, urlKey, loadClient };