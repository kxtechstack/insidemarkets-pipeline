/**
 * scripts/ci-stage-view.js - SEE EVERY STAGE of the CI news run for ONE competitor.
 * TEST ONLY: nothing is saved, nothing is logged, nothing goes to the chat.
 *
 *   node scripts/ci-stage-view.js "NextEra Energy" --client 19174b66-5ad9-44fa-8071-b30a90c15ea2
 *   node scripts/ci-stage-view.js "Lancôme"                       (default client: Lumière)
 *
 *   --days 7                 look back 7 days (default 30)
 *   --sections news          only these sections (press, blog, own_site, news)
 *
 * Report: ci-test-output/stage-view.html (open in the browser)
 *
 * The stages (same order as the real daily run in newsRun.js):
 *   1. FETCH          what each source gave us (press page / own website via Exa / news via Exa)
 *   2. URL CHECK      links already read in an earlier run, or twice in this run, are skipped
 *   3. QUALITY CHECK  code rules, no AI (empty page, competitor not named, old page, stock page...)
 *   4. AI READING     every answer the AI gave, what the code checks said, retries
 *   5. TOPIC CHECK    is it the same event as something already saved (or found earlier in this run)?
 *   6. RESULT         would be saved as new / would join an existing row / dropped
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { LIMITS } = require('../modules/competitiveIntelligence/constants');
const { nameKey, makeCounter, countryProfileFor, clean } = require('../modules/competitiveIntelligence/webTools');
const collector = require('../modules/competitiveIntelligence/collector');
const reader = require('../modules/competitiveIntelligence/reader');
const store = require('../modules/competitiveIntelligence/changeStore');
const { urlKey } = require('../modules/competitiveIntelligence/newsRun');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const clientId = flag('--client') || 'b61b4d3b-caeb-457b-9971-636c83688ee4'; // Lumière
const days = Number(flag('--days') || 30);
const SECTIONS = ['press', 'blog', 'own_site', 'news'];
const wanted = flag('--sections') ? flag('--sections').split(',').map((s) => s.trim()).filter((s) => SECTIONS.includes(s)) : SECTIONS;
const valueFlags = new Set(['--client', '--days', '--sections']);
const target = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]))[0];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = () => supabase.schema('admin');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const day = (d, plus) => new Date(new Date(`${d}T12:00:00Z`).getTime() + plus * 864e5).toISOString().slice(0, 10);

async function loadClient(id) {
  const { data: client, error } = await admin().from('clients').select('id, company_name, industry, location').eq('id', id).maybeSingle();
  if (error || !client) throw new Error(`client ${id} not found`);
  let location = client.location;
  if (!location) {
    const { data: icp } = await admin().from('client_icp').select('context_json').eq('client_id', id).maybeSingle();
    const j = (icp && icp.context_json) || {};
    location = j.location || j.headquarters || j.hq_location || j.country || null;
  }
  const profile = countryProfileFor(location);
  return { ...client, country: profile.name || location || null };
}

/** links already looked at in earlier runs (same as newsRun) - with the date and what happened then */
async function loadSeen(compId) {
  const since = new Date(Date.now() - 120 * 864e5).toISOString();
  const seen = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from('competitor_ingestion_log').select('url, outcome, created_at')
      .eq('client_id', clientId).eq('competitor_id', compId).neq('outcome', 'failed')
      .gte('created_at', since).range(from, from + 999);
    if (error) throw new Error(`could not read the log: ${error.message}`);
    (data || []).forEach((r) => r.url && seen.set(urlKey(r.url), `${r.outcome} on ${String(r.created_at).slice(0, 10)}`));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return seen;
}

/** same event already saved in the database? (same link, then the shared topic check from changeStore) */
async function sameEventInDb(comp, c, url) {
  const { data: rows } = await supabase.from('competitor_changes')
    .select('id, submodule_id, signal_title, summary, event_date')
    .eq('client_id', clientId).eq('competitor_id', comp.id).eq('is_duplicate', false)
    .in('status', ['pending', 'verified'])
    .gte('event_date', day(c.event_date, -LIMITS.MERGE_WINDOW_DAYS))
    .lte('event_date', day(c.event_date, LIMITS.MERGE_WINDOW_DAYS));
  if (!rows || !rows.length) return { match: null, closest: [], checked: 0 };
  const { data: ev } = await supabase.from('competitor_change_evidence')
    .select('change_id').eq('client_id', clientId).eq('url', url).in('change_id', rows.map((r) => r.id));
  if (ev && ev.length) {
    const r = rows.find((x) => x.id === ev[0].change_id);
    return { match: r, by: 'same link', score: 1, closest: [{ title: r.signal_title, score: 1, need: 1, ai: null }], checked: rows.length };
  }
  const hit = await store.pickSameEvent(comp, c, rows.map((r) => ({ row: r, title: r.signal_title, summary: r.summary, submodule_id: r.submodule_id })));
  return { ...hit, checked: rows.length };
}

/** same event found earlier in THIS run (in the real run it would already be saved, so it would join) */
async function sameEventInRun(comp, kept, c) {
  const near = kept.filter((k) => Math.abs(new Date(k.change.event_date) - new Date(c.event_date)) / 864e5 <= LIMITS.MERGE_WINDOW_DAYS)
    .map((k) => ({ title: k.change.title, summary: k.change.summary, submodule_id: k.change.signal.submodule_id, vec: k.vec }));
  return store.pickSameEvent(comp, c, near);
}

const showClosest = (h) => (h.closest && h.closest.length
  ? h.closest.map((x) => `"${esc(x.title)}" - likeness ${x.score.toFixed(2)} (sure from ${x.need})${x.ai ? ` - asked the AI "same event?": <b>${x.ai}</b>` : ''}`).join('<br>')
  : 'nothing to compare');

// ---------------------------------------------------------------------
(async () => {
  if (!target) { console.log('Say which competitor: node scripts/ci-stage-view.js "NextEra Energy" --client <uuid>'); process.exit(1); }
  const { data: list } = await admin().from('competitors').select('*').eq('client_id', clientId).eq('is_active', true);
  const comp = (list || []).find((c) => c.name_key === nameKey(target));
  if (!comp) { console.log(`"${target}" not found. Competitors: ${(list || []).map((c) => c.name).join(', ')}`); process.exit(1); }

  const client = await loadClient(clientId);
  const signals = await reader.loadSignals(clientId);
  const { data: sources } = await admin().from('competitor_sources').select('*')
    .eq('competitor_id', comp.id).eq('status', 'active').in('source_type', SECTIONS);
  const ctx = {
    client, comp, signals,
    otherCompetitors: (list || []).filter((c) => c.id !== comp.id).map((c) => c.name),
    terms: collector.brandTerms(comp),
  };
  const seen = await loadSeen(comp.id);
  const doneThisRun = new Set();
  const budget = { firecrawl: LIMITS.MAX_FIRECRAWL_PER_NEWS_RUN };
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const maxReads = days > LIMITS.NEWS_MAX_DAYS ? LIMITS.MAX_AI_READS_FIRST_RUN : LIMITS.MAX_AI_READS_PER_SECTION;
  const keptInRun = [];

  console.log(`\nSTAGE VIEW - ${comp.name} (${client.company_name}) - last ${days} days - TEST ONLY, nothing saved\n`);
  const H = [];
  H.push(`<h1>${esc(comp.name)} - stage by stage <span class="muted">(${esc(client.company_name)}, last ${days} days, test only - nothing saved)</span></h1>`);
  H.push(`<p class="muted">Client industry: ${esc(client.industry)} | country: ${esc(client.country)} | search words for the competitor: ${esc(ctx.terms.join(', '))} | signals ticked: ${signals.enabledCount} of ${signals.all.length} | links already read in earlier runs: ${seen.size}</p>`);

  for (const section of wanted) {
    const mySources = (sources || []).filter((s) => s.source_type === section);
    H.push(`<h2>Section: ${section}</h2>`);
    console.log(`=== ${section} ===`);
    if (!mySources.length) { H.push('<p class="warn">No active source for this section.</p>'); console.log('  no active source'); continue; }

    // ---------- STAGE 1: FETCH ----------
    const counter = makeCounter();
    let items = [];
    const srcRows = [];
    for (const src of mySources) {
      const where = src.url || src.query_text || src.domain;
      try {
        let got = [];
        let note = '';
        if (section === 'news') { got = await collector.collectNews(src, since, counter); note = `Exa news search for: "${src.query_text}"`; }
        else if (section === 'own_site') { got = await collector.collectOwnSite(src, comp, since, counter); note = `Exa search inside ${src.domain || comp.shop_domain} for: "${src.query_text}"`; }
        else { const r = await collector.collectPress(src, comp, since, maxReads, budget, counter); got = r.items.map((x) => ({ ...x, section })); note = `${section} list page ${src.url}: ${r.note}`; }
        items.push(...got);
        srcRows.push(`<tr><td>${esc(note)}</td><td>${got.length}</td></tr>`);
      } catch (e) {
        srcRows.push(`<tr><td>${esc(where)}</td><td class="warn">failed: ${esc(e.message)}</td></tr>`);
      }
    }
    H.push(`<h3>Stage 1 - FETCH: ${items.length} links found</h3><table><tr><th>Source and what we asked</th><th>Links</th></tr>${srcRows.join('')}</table>`);
    H.push('<table><tr><th>#</th><th>Link</th><th>Date</th><th>How we got the text</th><th>Text length</th><th>Start of the text</th></tr>');
    items.forEach((it, i) => H.push(`<tr><td>${i + 1}</td><td><a href="${esc(it.url)}" target="_blank">${esc(it.title || it.url)}</a><br><span class="muted">${esc(host(it.url))}</span></td><td>${esc((it.publishedDate || '').slice(0, 10))}</td><td>${esc(it.via)}</td><td>${(it.text || '').length}</td><td class="small">${esc((it.text || '').slice(0, 250))}...</td></tr>`));
    H.push('</table>');
    console.log(`  1 FETCH: ${items.length} links (Exa calls ${counter.exa}, Firecrawl ${counter.firecrawl})`);

    // ---------- STAGE 2: URL CHECK ----------
    const fresh = [];
    const urlRows = [];
    for (const it of items) {
      const k = urlKey(it.url);
      let why = 'new - goes on';
      if (seen.has(k)) why = `SKIPPED - already read in an earlier run (${seen.get(k)})`;
      else if (doneThisRun.has(k)) why = 'SKIPPED - same link twice in this run';
      else { doneThisRun.add(k); fresh.push(it); }
      urlRows.push(`<tr class="${why.startsWith('new') ? 'pass' : 'drop'}"><td>${esc(it.title || it.url)}<br><span class="muted">${esc(k)}</span></td><td>${esc(why)}</td></tr>`);
    }
    fresh.sort((a, b) => String(b.publishedDate || '').localeCompare(String(a.publishedDate || '')));
    H.push(`<h3>Stage 2 - URL CHECK: ${fresh.length} of ${items.length} go on</h3><p class="muted">Tracking bits (utm_, ref...), "www." and a trailing "/" are removed before comparing links.</p><table><tr><th>Link (as compared)</th><th>Result</th></tr>${urlRows.join('')}</table>`);
    console.log(`  2 URL CHECK: ${fresh.length} go on, ${items.length - fresh.length} skipped`);

    // ---------- STAGE 3: QUALITY CHECK (code, no AI) ----------
    const passed = [];
    const qRows = [];
    for (const it of fresh) {
      const pre = collector.precheck(it, comp, ctx.terms, since, { ownSite: section === 'own_site', ownBlog: section === 'blog' });
      if (it.mentions == null) it.mentions = collector.brandMentions(`${it.title} ${it.text}`, ctx.terms);
      if (!pre) passed.push(it);
      qRows.push(`<tr class="${pre ? 'drop' : 'pass'}"><td>${esc(it.title || it.url)}<br><span class="muted">${esc(host(it.url))} - ${esc((it.publishedDate || '').slice(0, 10))} - competitor named ${it.mentions != null ? it.mentions : '?'}x</span></td><td>${pre ? `DROPPED - ${esc(pre)}` : 'OK - goes to the AI'}</td></tr>`);
    }
    H.push(`<h3>Stage 3 - QUALITY CHECK (code rules, no AI): ${passed.length} of ${fresh.length} go to the AI</h3><table><tr><th>Article</th><th>Result</th></tr>${qRows.join('')}</table>`);
    console.log(`  3 QUALITY CHECK: ${passed.length} go to the AI, ${fresh.length - passed.length} dropped`);

    // ---------- STAGE 4-6: AI READING, TOPIC CHECK, RESULT ----------
    H.push(`<h3>Stage 4 - AI READING, Stage 5 - TOPIC CHECK, Stage 6 - RESULT (${Math.min(passed.length, maxReads)} articles)</h3>`);
    let aiKept = 0; let aiDropped = 0; let joins = 0;
    for (const [i, it] of passed.entries()) {
      if (i >= maxReads) { H.push(`<p class="muted">${passed.length - maxReads} more left for the next run (limit ${maxReads} AI reads per section).</p>`); break; }
      const trace = [];
      let read;
      try { read = await reader.readArticle(it, { ...ctx, trace }); } catch (e) { read = { outcome: 'failed', reason: e.message }; }

      const tries = trace.map((t) => `<details><summary>Try ${t.attempt}: ${esc(t.code_said)}</summary><pre>${esc(t.raw_answer)}</pre></details>`).join('');
      let result; let topic = '';
      if (read.outcome === 'keep') {
        aiKept++;
        const c = read.change;
        const db = await sameEventInDb(comp, c, it.url);
        const run = await sameEventInRun(comp, keptInRun, c);
        topic = `<b>Topic check</b> (very alike = same event; somewhat alike, from 0.55 = the AI is asked yes/no)<br>`
          + `Saved rows within ${LIMITS.MERGE_WINDOW_DAYS} days: ${db.checked}<br>${showClosest(db)}<br>`
          + `Earlier items in this run:<br>${showClosest(run)}`;
        if (db.match || run.match) { joins++; result = `<b class="join">WOULD JOIN</b> ${db.match ? 'the saved row' : 'the earlier item in this run'} (${esc((db.match ? db : run).by)}) - added as extra proof, no new row`; }
        else result = '<b class="ok">WOULD SAVE AS NEW</b>';
        keptInRun.push({ change: c, vec: run.vec });
        result += `<div class="card"><b>${esc(c.title)}</b><br>${esc(c.summary)}<br><span class="tag">${esc(c.signal.category)} &rarr; ${esc(c.signal.name)}</span> <span class="tag">${esc(c.importance)}</span> <span class="tag">event ${esc(c.event_date)} (date from ${esc(c.event_date_from)})</span><br><span class="muted">proof: ${(c.key_facts || []).map((f) => `"${esc(f)}"`).join(' | ')}</span></div>`;
      } else {
        aiDropped++;
        result = `<b class="drop">${read.outcome === 'failed' ? 'FAILED' : 'DROPPED'}</b> - ${esc(read.reason)}`;
      }
      H.push(`<div class="art"><a href="${esc(it.url)}" target="_blank">${esc(it.title || it.url)}</a> <span class="muted">${esc(host(it.url))} - ${esc((it.publishedDate || '').slice(0, 10))} - ${(it.text || '').length} chars (AI gets the first ${LIMITS.ARTICLE_CHARS_FOR_AI})</span>
<details><summary>Text the AI read</summary><pre>${esc((it.text || '').slice(0, LIMITS.ARTICLE_CHARS_FOR_AI))}</pre></details>
<p><b>AI answers (${trace.length} ${trace.length === 1 ? 'try' : 'tries'})</b> - click to see the full answer</p>${tries}
${topic ? `<p>${topic}</p>` : ''}<p><b>Result:</b> ${result}</p></div>`);
      console.log(`  4 AI: ${read.outcome === 'keep' ? 'KEEP' : read.outcome.toUpperCase()} (${trace.length} tries) - ${clean(it.title, 70)}${read.outcome !== 'keep' ? ` -> ${clean(read.reason, 80)}` : ''}`);
    }
    H.push(`<p class="sum">Section ${section}: found ${items.length} &rarr; new links ${fresh.length} &rarr; passed quality ${passed.length} &rarr; AI kept ${aiKept} (dropped ${aiDropped}) &rarr; ${aiKept - joins} new rows, ${joins} would join an existing event</p>`);
    console.log(`  RESULT: AI kept ${aiKept}, dropped ${aiDropped}; ${aiKept - joins} new, ${joins} would join\n`);
  }

  const out = path.join(process.cwd(), 'ci-test-output');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'stage-view.html'), `<!doctype html><meta charset="utf-8"><title>CI stage view - ${esc(comp.name)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#222;max-width:1300px}table{border-collapse:collapse;width:100%;margin-bottom:14px}td,th{border:1px solid #ddd;padding:5px;vertical-align:top;text-align:left}
th{background:#f3f3f3}.muted{color:#777;font-size:12px}.small{font-size:12px;color:#555}.warn{color:#b00}h2{background:#223;color:#fff;padding:6px 10px}h3{border-bottom:2px solid #ccd;padding-bottom:3px}
tr.pass td:last-child{background:#e6f6e6}tr.drop td:last-child{background:#f4f4f4;color:#666}.art{border:1px solid #ccd;border-radius:6px;padding:10px;margin:10px 0}
pre{white-space:pre-wrap;background:#f7f7f9;padding:8px;font-size:12px;max-height:400px;overflow:auto}.tag{display:inline-block;background:#eef;padding:1px 6px;border-radius:8px;font-size:12px}
.card{background:#f6fff6;border:1px solid #cfe8cf;padding:6px;margin-top:6px}.ok{color:#080}.join{color:#06c}.drop{color:#b00}.sum{background:#ffd;padding:8px;font-weight:600}summary{cursor:pointer}</style>
${H.join('\n')}`);
  console.log('Report: ci-test-output/stage-view.html');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });