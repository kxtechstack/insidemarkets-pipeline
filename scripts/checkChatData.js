/**
 * scripts/checkChatData.js
 *
 * DATA CHECK for the Decision Intelligence chat.
 * The chat can only answer well if the data under it is right. This script
 * checks, for every module, that the data in Supabase (what the dashboard
 * shows) and in Qdrant (what the chat searches) is complete, matches, and
 * is clean. It ONLY READS. It never changes or deletes anything.
 *
 * Run:   node scripts/checkChatData.js          the test client (DR_TEST_CLIENT_ID)
 *        node scripts/checkChatData.js all      every client
 *        node scripts/checkChatData.js <clientId>
 *
 * The report is printed and saved in scripts/logs/checkChatData_<time>.txt
 * Every line is  OK / INFO / WARNING / PROBLEM, with example ids so the
 * cause can be found.
 *
 * How the data is linked (what this script follows):
 *   Policy & Risk     policy_signals          -> policy_articles_full -> Qdrant text pieces  (article_id)
 *   Forward Outlook   trend_signals           -> policy_articles_full -> Qdrant text pieces  (article_id)
 *   Market Dynamics   market_dynamics_signals -> policy_articles_full -> Qdrant text pieces  (article_id)
 *                                             -> market_insights (insight_id)
 *   Competitive Radar competitor_changes (verified) -> one Qdrant point, point id = change id
 *   Today's Highlights daily_highlights (not in Qdrant)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
  timeout: 60000,
});
const COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';
const TIMEZONE = process.env.DR_TIMEZONE || 'Asia/Kolkata';

const MODULES = {
  policy: { id: '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960', name: 'Policy & Risk', table: 'policy_signals', dateCol: 'source_published_date' },
  trend: { id: '2eb989fd-0ea0-4320-b73a-f7eb8b970473', name: 'Forward Outlook', table: 'trend_signals', dateCol: 'source_published_date' },
  market: { id: '55c5ee19-bfca-468b-81b3-b89ca4f303c8', name: 'Market Dynamics', table: 'market_dynamics_signals', dateCol: 'published_date' },
  ci: { id: '5e953748-931d-4212-99e9-08c9a050cfef', name: 'Competitive Radar', table: 'competitor_changes', dateCol: 'event_date' },
};
const KNOWN_MODULE_IDS = new Set([
  ...Object.values(MODULES).map((m) => m.id),
  'f8f9e654-c08e-406c-8dbd-01f161072f75', // Find Opportunities
  'aadd18e1-7401-4e84-ac3c-9e9cfcc538f4', // Voice of Customer
]);

// Places that are the same place written differently.
const SAME_PLACE = [
  ['uae', 'united arab emirates', 'u.a.e', 'u.a.e.', 'emirates'],
  ['saudi arabia', 'ksa', 'kingdom of saudi arabia', 'saudi'],
  ['united states', 'usa', 'us', 'u.s.', 'u.s', 'u.s.a.', 'united states of america', 'america'],
  ['united kingdom', 'uk', 'u.k.', 'great britain', 'britain', 'england'],
  ['south korea', 'korea', 'republic of korea', 'korea, republic of'],
  ['china', "people's republic of china", 'prc', 'mainland china'],
  ['european union', 'eu', 'europe'],
];

// ── Report ───────────────────────────────────────────────────────────────
const lines = [];
const tally = { OK: 0, INFO: 0, WARNING: 0, PROBLEM: 0 };
const out = (text = '') => { console.log(text); lines.push(text); };
const say = (level, text, examples) => {
  tally[level] += 1;
  out(`  ${level.padEnd(8)} ${text}`);
  if (examples && examples.length) out(`           e.g. ${examples.slice(0, 5).join(' | ')}`);
};
const pct = (part, total) => (total ? `${Math.round((part / total) * 1000) / 10}%` : '0%');
const short = (t, n = 70) => { const s = String(t == null ? '' : t); return s.length > n ? `${s.slice(0, n)}…` : s; };
const dayOf = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: TIMEZONE });

// ── Reading helpers ──────────────────────────────────────────────────────
async function readAll(table, filters, schema) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = (schema ? supabase.schema(schema) : supabase).from(table).select('*');
    for (const [col, val] of Object.entries(filters || {})) q = q.eq(col, val);
    let { data, error } = await q.order('id').range(from, from + 999);
    if (error && /id/.test(error.message)) {
      // table without an "id" column: read without a fixed order
      let q2 = (schema ? supabase.schema(schema) : supabase).from(table).select('*');
      for (const [col, val] of Object.entries(filters || {})) q2 = q2.eq(col, val);
      ({ data, error } = await q2.range(from, from + 999));
    }
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

async function readPoints(must) {
  const points = [];
  let offset;
  do {
    const res = await qdrant.scroll(COLLECTION, {
      filter: { must }, limit: 1000, offset, with_payload: true, with_vector: false,
    });
    points.push(...res.points);
    offset = res.next_page_offset;
  } while (offset !== null && offset !== undefined);
  return points;
}
const match = (key, value) => ({ key, match: { value } });
const countPoints = async (filter) => (await qdrant.count(COLLECTION, { filter, exact: true })).count;

let embedder = null;
async function embed(text) {
  if (!embedder) {
    const { pipeline } = require('@xenova/transformers');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ── Checks shared by the article-based modules ───────────────────────────
function checkFields(mod, rows) {
  const live = rows.filter((r) => r.is_duplicate !== true);
  const noTitle = live.filter((r) => !String(r.signal_title || '').trim());
  say(noTitle.length ? 'PROBLEM' : 'OK', `signals with no title: ${noTitle.length}`, noTitle.map((r) => r.id));
  const noSummary = live.filter((r) => String(r.summary || '').trim().length < 20);
  say(noSummary.length ? 'WARNING' : 'OK', `signals with no or very short summary (<20 letters): ${noSummary.length} (${pct(noSummary.length, live.length)})`, noSummary.map((r) => r.id));

  if ('organization' in (live[0] || {})) {
    const unknown = live.filter((r) => !r.organization || /^(unknown|n\/a|none|various|multiple)$/i.test(String(r.organization).trim()));
    say(unknown.length / Math.max(live.length, 1) > 0.3 ? 'WARNING' : 'INFO',
      `company is empty or "Unknown": ${unknown.length} (${pct(unknown.length, live.length)})`);
  }
  if ('country' in (live[0] || {})) {
    const empty = live.filter((r) => !String(r.country || '').trim());
    say(empty.length / Math.max(live.length, 1) > 0.3 ? 'WARNING' : 'INFO', `country empty: ${empty.length} (${pct(empty.length, live.length)})`);
    checkPlaceSpellings(live.map((r) => r.country));
  }
  for (const col of ['category', 'sector']) {
    if (!(col in (live[0] || {}))) continue;
    const count = new Map();
    for (const r of live) count.set(r[col] || '(empty)', (count.get(r[col] || '(empty)') || 0) + 1);
    const topList = [...count.entries()].sort((a, b) => b[1] - a[1]);
    say('INFO', `${col}: ${topList.length} different values · top: ${topList.slice(0, 8).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  }

  // dates
  const dateCol = mod.dateCol;
  const now = Date.now();
  const noDate = live.filter((r) => !r[dateCol]);
  say(noDate.length ? 'PROBLEM' : 'OK', `signals with no date: ${noDate.length}`, noDate.map((r) => r.id));
  const future = live.filter((r) => r[dateCol] && new Date(r[dateCol]).getTime() > now + 2 * 86400000);
  say(future.length ? 'PROBLEM' : 'OK', `signals dated in the future: ${future.length}`, future.map((r) => `${r.id} (${String(r[dateCol]).slice(0, 10)})`));
  const old = live.filter((r) => r[dateCol] && new Date(r[dateCol]).getFullYear() < 2015);
  say(old.length ? 'WARNING' : 'OK', `signals dated before 2015: ${old.length}`, old.map((r) => `${r.id} (${String(r[dateCol]).slice(0, 10)})`));
  if (mod.key !== 'ci') {
    // When an article has no date, the pipeline saves "now" instead, so the
    // date is the save time, not the news time.
    const saveTime = live.filter((r) => r[dateCol] && r.created_at &&
      Math.abs(new Date(r[dateCol]).getTime() - new Date(r.created_at).getTime()) < 5 * 60000);
    say(saveTime.length / Math.max(live.length, 1) > 0.05 ? 'WARNING' : 'INFO',
      `date is probably the SAVE time, not the news date (within 5 min of saving): ${saveTime.length} (${pct(saveTime.length, live.length)})`,
      saveTime.map((r) => r.id));
  }

  // same title many times
  const byTitle = new Map();
  for (const r of live) {
    const k = String(r.signal_title || '').trim().toLowerCase();
    if (k) byTitle.set(k, (byTitle.get(k) || 0) + 1);
  }
  const repeated = [...byTitle.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  say(repeated.length ? 'WARNING' : 'OK', `titles saved 3 or more times (not marked duplicate): ${repeated.length}`,
    repeated.map(([t, n]) => `${n}x "${short(t, 50)}"`));

  // new rows per day, last 30 days
  const perDay = new Map();
  for (const r of rows) if (r.created_at) perDay.set(dayOf(r.created_at), (perDay.get(dayOf(r.created_at)) || 0) + 1);
  const missing = [];
  for (let i = 0; i < 30; i++) {
    const d = dayOf(now - i * 86400000);
    if (!perDay.get(d)) missing.push(d);
  }
  say(missing.length > 7 ? 'WARNING' : 'INFO', `days in the last 30 with NO new signals: ${missing.length}${missing.length ? ` (${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''})` : ''}`);
  const last = rows.map((r) => r.created_at).filter(Boolean).sort().pop();
  say('INFO', `newest signal saved: ${last ? `${dayOf(last)}` : 'never'}`);
}

function checkPlaceSpellings(values) {
  const seen = new Map();
  for (const v of values) {
    for (const part of String(v || '').split(/[,;/]/)) {
      const p = part.trim();
      if (p) seen.set(p, (seen.get(p) || 0) + 1);
    }
  }
  const mixed = [];
  for (const group of SAME_PLACE) {
    const used = [...seen.entries()].filter(([p]) => group.includes(p.toLowerCase()));
    if (used.length > 1) mixed.push(used.map(([p, n]) => `${p} (${n})`).join(' / '));
  }
  say(mixed.length ? 'WARNING' : 'OK', `the same country written in different ways: ${mixed.length}`, mixed);
}

// ── One article-based module (Policy, Forward Outlook, Market Dynamics) ──
async function checkArticleModule(client, mod, fullByArticle) {
  out(`\n  ── ${mod.name} (${mod.table}) ──`);
  const rows = await readAll(mod.table, { client_id: client.id });
  const dupFlag = rows.length && 'is_duplicate' in rows[0];
  const live = rows.filter((r) => r.is_duplicate !== true);
  const dups = rows.filter((r) => r.is_duplicate === true);
  const points = await readPoints([match('client_id', client.id), match('module_id', mod.id)]);
  const pointsByArticle = new Map();
  for (const p of points) {
    const a = p.payload && p.payload.article_id;
    if (!pointsByArticle.has(a)) pointsByArticle.set(a, []);
    pointsByArticle.get(a).push(p);
  }
  say('INFO', `Supabase: ${rows.length} signals (${live.length} live, ${dups.length} marked duplicate${dupFlag ? '' : ' – table has no is_duplicate column'}) · Qdrant: ${points.length} text pieces for ${pointsByArticle.size} articles`);
  if (!rows.length && !points.length) { say('INFO', 'no data for this client in this module'); return { live, points }; }

  // module_id on the rows
  const wrongModule = rows.filter((r) => r.module_id && r.module_id !== mod.id);
  say(wrongModule.length ? 'PROBLEM' : 'OK', `signals with a different module_id: ${wrongModule.length}`, wrongModule.map((r) => `${r.id} (${r.module_id})`));

  // signal -> text in Qdrant
  const noArticle = live.filter((r) => !r.article_id);
  say(noArticle.length ? 'PROBLEM' : 'OK', `live signals with no article_id (cannot be linked to the text): ${noArticle.length}`, noArticle.map((r) => r.id));
  const noText = live.filter((r) => r.article_id && !pointsByArticle.has(r.article_id));
  say(noText.length ? 'PROBLEM' : 'OK', `live signals with NO text in Qdrant (the chat cannot find them): ${noText.length} (${pct(noText.length, live.length)})`,
    noText.map((r) => `${r.id} "${short(r.signal_title, 40)}"`));

  // text in Qdrant -> signal
  const rowArticles = new Set(rows.map((r) => r.article_id).filter(Boolean));
  const orphans = [...pointsByArticle.keys()].filter((a) => !rowArticles.has(a));
  const orphanSaved = orphans.filter((a) => fullByArticle.has(a));
  say(orphans.length ? 'WARNING' : 'OK',
    `articles in Qdrant with NO signal row (chat can find news the dashboard does not show): ${orphans.length} ` +
    `(${orphanSaved.length} have an article row, so the signal save failed or the signal was deleted; ${orphans.length - orphanSaved.length} have no Supabase row at all)`,
    orphans.map((a) => `${a} "${short(pointsByArticle.get(a)[0].payload.title, 40)}"`));

  // duplicates still searchable
  const dupInQdrant = dups.filter((r) => r.article_id && pointsByArticle.has(r.article_id));
  say(dupInQdrant.length ? 'WARNING' : 'OK',
    `signals marked duplicate but their text is STILL in Qdrant (the chat may repeat the same news): ${dupInQdrant.length} of ${dups.length}`,
    dupInQdrant.map((r) => r.id));

  // article row, pieces, titles, dates
  let missingFull = 0; let countDiff = 0; let titleDiff = 0; let qNoDate = 0; let dateDiff = 0; let shortText = 0; let wrongClient = 0;
  const exDiff = [];
  for (const r of live) {
    const pts = pointsByArticle.get(r.article_id);
    if (!pts) continue;
    const full = fullByArticle.get(r.article_id);
    if (!full) missingFull += 1;
    else {
      if (full.chunk_count != null && full.chunk_count !== pts.length) { countDiff += 1; exDiff.push(`${r.article_id}: ${full.chunk_count} saved vs ${pts.length} in Qdrant`); }
      if (full.title && pts[0].payload.title && full.title.trim() !== String(pts[0].payload.title).trim()) titleDiff += 1;
    }
    const qDate = pts[0].payload.published_date;
    if (!qDate) qNoDate += 1;
    else if (r[mod.dateCol] && dayOf(qDate) !== dayOf(r[mod.dateCol])) dateDiff += 1;
    for (const p of pts) {
      if (String(p.payload.chunk_text || '').trim().length < 50) shortText += 1;
      if (p.payload.client_id !== client.id) wrongClient += 1;
    }
  }
  say(missingFull ? 'WARNING' : 'OK', `live signals with text in Qdrant but no policy_articles_full row: ${missingFull}`);
  say(countDiff ? 'WARNING' : 'OK', `articles where the number of text pieces in Qdrant differs from chunk_count: ${countDiff}`, exDiff);
  say(titleDiff ? 'WARNING' : 'OK', `articles whose title in Qdrant differs from the saved article title: ${titleDiff}`);
  say(qNoDate / Math.max(live.length, 1) > 0.05 ? 'WARNING' : (qNoDate ? 'INFO' : 'OK'),
    `articles with NO date in Qdrant (the chat cannot filter them by date): ${qNoDate} (${pct(qNoDate, live.length)})`);
  say(dateDiff ? 'WARNING' : 'OK', `articles whose date in Qdrant is a different day than in Supabase: ${dateDiff}`);
  say(shortText ? 'WARNING' : 'OK', `text pieces in Qdrant that are empty or very short (<50 letters): ${shortText}`);
  say(wrongClient ? 'PROBLEM' : 'OK', `text pieces with the wrong client: ${wrongClient}`);

  if (mod.key === 'market') {
    const noInsight = live.filter((r) => !r.insight_id);
    say(noInsight.length ? 'WARNING' : 'OK', `market signals not linked to a market insight card: ${noInsight.length}`, noInsight.map((r) => r.id));
    try {
      const cards = await readAll('market_insights', { client_id: client.id });
      const cardIds = new Set(cards.map((c) => c.id));
      const broken = live.filter((r) => r.insight_id && !cardIds.has(r.insight_id));
      say(broken.length ? 'PROBLEM' : 'OK', `market signals linked to an insight card that does not exist: ${broken.length}`, broken.map((r) => `${r.id} -> ${r.insight_id}`));
      say('INFO', `market insight cards: ${cards.length}`);
    } catch (e) {
      say('WARNING', `could not read market_insights: ${e.message}`);
    }
  }

  checkFields(mod, rows);
  return { live, points, pointsByArticle };
}

// ── Competitive Radar ────────────────────────────────────────────────────
async function checkCompetitorModule(client, comps) {
  const mod = MODULES.ci;
  out(`\n  ── ${mod.name} (${mod.table}) ──`);
  const rows = await readAll(mod.table, { client_id: client.id });
  const points = await readPoints([match('client_id', client.id), match('module_id', mod.id)]);
  const pointIds = new Map(points.map((p) => [String(p.id), p]));
  const live = rows.filter((r) => r.is_duplicate !== true && r.status === 'verified');
  const dups = rows.filter((r) => r.is_duplicate === true);
  const status = new Map();
  for (const r of rows) status.set(r.status || '(empty)', (status.get(r.status || '(empty)') || 0) + 1);
  say('INFO', `Supabase: ${rows.length} changes · status: ${[...status.entries()].map(([k, v]) => `${k} ${v}`).join(', ')} · marked duplicate ${dups.length} · Qdrant: ${points.length} points`);
  if (!rows.length && !points.length) { say('INFO', 'no data for this client in this module'); return { live, points }; }

  const noPoint = live.filter((r) => !pointIds.has(String(r.id)));
  say(noPoint.length ? 'PROBLEM' : 'OK', `verified changes with NO point in Qdrant (the chat cannot find them): ${noPoint.length}`, noPoint.map((r) => `${r.id} "${short(r.signal_title, 40)}"`));
  const liveIds = new Set(live.map((r) => String(r.id)));
  const orphan = points.filter((p) => !liveIds.has(String(p.id)));
  const orphanWhy = orphan.map((p) => {
    const r = rows.find((x) => String(x.id) === String(p.id));
    return `${p.id} (${r ? `row is ${r.is_duplicate ? 'duplicate' : r.status}` : 'no row'})`;
  });
  say(orphan.length ? 'WARNING' : 'OK', `points in Qdrant that are not a live verified change (duplicate, not verified, or deleted): ${orphan.length}`, orphanWhy);

  const failed = rows.filter((r) => r.status === 'failed');
  say(failed.length ? 'PROBLEM' : 'OK', `changes that FAILED to reach Qdrant: ${failed.length}`, failed.map((r) => r.id));
  const stuck = rows.filter((r) => r.status === 'pending' && r.updated_at && Date.now() - new Date(r.updated_at).getTime() > 86400000);
  say(stuck.length ? 'WARNING' : 'OK', `changes still "pending" after 1 day: ${stuck.length}`, stuck.map((r) => r.id));

  const compIds = new Set((comps || []).map((c) => c.id));
  const badComp = rows.filter((r) => r.is_duplicate !== true && (!r.competitor_id || !compIds.has(r.competitor_id)));
  say(badComp.length ? 'WARNING' : 'OK', `changes whose competitor is missing or not in this client's competitor list (maybe switched off): ${badComp.length}`, badComp.map((r) => `${r.id} (${r.organization})`));
  const noChat = live.filter((r) => String(r.chat_text || '').trim().length < 50);
  say(noChat.length ? 'PROBLEM' : 'OK', `verified changes with no or very short chat text: ${noChat.length}`, noChat.map((r) => r.id));
  let payloadDiff = 0;
  for (const r of live) {
    const p = pointIds.get(String(r.id));
    if (p && (p.payload.competitor_id !== r.competitor_id || p.payload.client_id !== client.id)) payloadDiff += 1;
  }
  say(payloadDiff ? 'PROBLEM' : 'OK', `points whose competitor or client differs from the Supabase row: ${payloadDiff}`);

  const perComp = new Map();
  for (const r of live) perComp.set(r.organization || '(empty)', (perComp.get(r.organization || '(empty)') || 0) + 1);
  say('INFO', `verified changes per competitor: ${[...perComp.entries()].map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  const silent = (comps || []).filter((c) => c.is_active && !perComp.has(c.name));
  say(silent.length ? 'INFO' : 'OK', `active competitors with no verified change yet: ${silent.map((c) => c.name).join(', ') || 'none'}`);

  checkFields({ ...mod, key: 'ci' }, rows.filter((r) => r.status === 'verified' || r.is_duplicate));
  return { live, points };
}

// ── Today's Highlights ───────────────────────────────────────────────────
async function checkHighlights(client) {
  out('\n  ── Today\'s Highlights (daily_highlights) ──');
  let rows;
  try { rows = await readAll('daily_highlights', { client_id: client.id }); } catch (e) { say('WARNING', e.message); return; }
  const kinds = new Map();
  const moduleName = (id) => (Object.values(MODULES).find((m) => m.id === id) || {}).name || id;
  for (const r of rows) {
    const k = `${r.kind || '(no kind)'}${r.module_id ? ` / ${moduleName(r.module_id)}` : ''}`;
    kinds.set(k, (kinds.get(k) || 0) + 1);
  }
  say('INFO', `${rows.length} highlights · ${[...kinds.entries()].map(([k, v]) => `${k}: ${v}`).join(', ') || '-'}`);
  const empty = rows.filter((r) => String(r.highlight_text || '').trim().length < 20);
  say(empty.length ? 'WARNING' : 'OK', `highlights with no or very short text: ${empty.length}`, empty.map((r) => r.id));
  const days = new Set(rows.map((r) => r.created_at && dayOf(r.created_at)));
  const missing = [];
  for (let i = 0; i < 14; i++) { const d = dayOf(Date.now() - i * 86400000); if (!days.has(d)) missing.push(d); }
  say(missing.length > 3 ? 'WARNING' : 'INFO', `days in the last 14 with no highlight: ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`);
}

// ── Can the chat find the data? ──────────────────────────────────────────
async function checkSearch(client, found) {
  out('\n  ── Search test (can the chat find a signal by its own title?) ──');
  const picks = [];
  const take = (list, n, make) => {
    const shuffled = [...list].sort(() => Math.random() - 0.5);
    for (const r of shuffled.slice(0, n)) picks.push(make(r));
  };
  for (const key of ['policy', 'trend', 'market']) {
    const f = found[key];
    if (!f || !f.pointsByArticle) continue;
    take(f.live.filter((r) => f.pointsByArticle.has(r.article_id)), 6, (r) => ({
      module: MODULES[key].name, id: r.id, title: f.pointsByArticle.get(r.article_id)[0].payload.title || r.signal_title,
      hit: (p) => p.payload && p.payload.article_id === r.article_id,
    }));
  }
  if (found.ci) {
    const ids = new Set(found.ci.points.map((p) => String(p.id)));
    take(found.ci.live.filter((r) => ids.has(String(r.id))), 6, (r) => ({
      module: MODULES.ci.name, id: r.id, title: r.signal_title, hit: (p) => String(p.id) === String(r.id),
    }));
  }
  if (!picks.length) { say('INFO', 'nothing to search'); return; }
  let hits = 0;
  const misses = [];
  for (const t of picks) {
    const vector = await embed(t.title);
    const res = await qdrant.search(COLLECTION, { vector, limit: 5, filter: { must: [match('client_id', client.id)] }, with_payload: true });
    if (res.some(t.hit)) hits += 1;
    else misses.push(`${t.module} ${t.id} "${short(t.title, 45)}"`);
    if (res.some((p) => p.payload && p.payload.client_id !== client.id)) say('PROBLEM', 'search returned another client\'s data');
  }
  say(hits / picks.length >= 0.9 ? 'OK' : 'WARNING', `found ${hits} of ${picks.length} signals in the top 5 when searching by their own title`, misses);
}

// ── Whole collection ─────────────────────────────────────────────────────
async function checkCollection(clients) {
  out('\n══ Qdrant collection ══════════════════════════════════════════════════');
  const info = await qdrant.getCollection(COLLECTION);
  const size = info.config && info.config.params && info.config.params.vectors && info.config.params.vectors.size;
  say(size === 384 ? 'OK' : 'PROBLEM', `collection "${COLLECTION}": vector size ${size} (the chat uses 384)`);
  const total = await countPoints();
  const noClient = await countPoints({ must: [{ is_empty: { key: 'client_id' } }] });
  let known = 0;
  for (const c of clients) known += await countPoints({ must: [match('client_id', c.id)] });
  say('INFO', `points in total: ${total} · belong to existing clients: ${known}`);
  say(noClient ? 'PROBLEM' : 'OK', `points with NO client (could be shown to anyone): ${noClient}`);
  const other = total - known - noClient;
  say(other > 0 ? 'WARNING' : 'OK', `points of clients that no longer exist in admin.clients: ${other}`);
  const noModule = await countPoints({ must: [{ is_empty: { key: 'module_id' } }] });
  say(noModule ? 'WARNING' : 'OK', `points with NO module: ${noModule}`);
  let knownModules = 0;
  for (const id of KNOWN_MODULE_IDS) knownModules += await countPoints({ must: [match('module_id', id)] });
  const unknownModules = total - knownModules - noModule;
  say(unknownModules > 0 ? 'WARNING' : 'OK', `points with a module that is not one of ours: ${unknownModules}`);
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2];
  const started = Date.now();
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: TIMEZONE }).replace(' ', '_').replace(/:/g, '-').slice(0, 16);
  out(`CHAT DATA CHECK — ${stamp.replace('_', ' ')} — read only, nothing is changed`);

  const allClients = await readAll('clients', {}, 'admin');
  let clients;
  if (arg === 'all') clients = allClients;
  else {
    const id = arg || process.env.DR_TEST_CLIENT_ID;
    if (!id) { out('Give a client id, or "all", or set DR_TEST_CLIENT_ID in .env'); process.exit(1); }
    clients = allClients.filter((c) => c.id === id);
    if (!clients.length) { out(`Client ${id} not found in admin.clients`); process.exit(1); }
  }

  await checkCollection(allClients);

  for (const client of clients) {
    out(`\n══ Client: ${client.company_name} (${client.id}) — ${client.status || ''} ══`);
    const comps = await readAll('competitors', { client_id: client.id }, 'admin').catch(() => []);
    say('INFO', `competitors in admin: ${comps.length} (${comps.filter((c) => c.is_active).length} active)`);

    // all article rows of this client, once
    const fullRows = await readAll('policy_articles_full', { client_id: client.id }).catch((e) => { say('WARNING', e.message); return []; });
    const fullByArticle = new Map(fullRows.map((r) => [r.article_id, r]));

    const found = {};
    for (const key of ['policy', 'trend', 'market']) {
      try { found[key] = await checkArticleModule(client, { ...MODULES[key], key }, fullByArticle); } catch (e) { say('PROBLEM', `${MODULES[key].name}: check stopped: ${e.message}`); }
    }
    try { found.ci = await checkCompetitorModule(client, comps); } catch (e) { say('PROBLEM', `Competitive Radar: check stopped: ${e.message}`); }
    try { await checkHighlights(client); } catch (e) { say('PROBLEM', `Highlights: check stopped: ${e.message}`); }
    try { await checkSearch(client, found); } catch (e) { say('PROBLEM', `Search test stopped: ${e.message}`); }
  }

  out('\n══ SUMMARY ═══════════════════════════════════════════════════════════');
  out(`  OK ${tally.OK} · INFO ${tally.INFO} · WARNING ${tally.WARNING} · PROBLEM ${tally.PROBLEM} · ${Math.round((Date.now() - started) / 1000)} s`);
  const dir = path.join(__dirname, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `checkChatData_${stamp}.txt`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  console.log(`\nReport saved: ${file}`);
}

main().catch((e) => { console.error('CHECK STOPPED:', e.message); process.exit(1); });
