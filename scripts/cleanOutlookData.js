/**
 * scripts/cleanOutlookData.js
 *
 * ONE-TIME QUICK CLEANUP of the old Forward Outlook data. No AI, no regrouping of old trends.
 * Same flags as scripts/cleanPolicyData.js and scripts/cleanMarketData.js.
 *
 *   node scripts/cleanOutlookData.js            DRY RUN: changes nothing, writes a report to scripts/logs/
 *   node scripts/cleanOutlookData.js --apply    does the changes in the report
 *
 * What it does (16 Nov audit):
 *   1. signals of deleted clients                              -> deleted everywhere
 *   2. the same title again for the same client (first kept)   -> deleted everywhere
 *   3. signals that are in no trend (the trend step had failed) -> deleted everywhere
 *      (their links stay remembered, so they are not fetched again)
 *   4. trends of deleted clients, and trends left with no signal -> deleted (with their radar history)
 *   5. active trends with no name -> a proper name (one AI call each; 16 Nov: 1 such trend); a sector that is not one of the 5
 *      -> the sector most of their signals have
 *   "Deleted everywhere" = trend_signals + trend link + article rows + chat text + the trend-matching vector.
 * Old trends are NOT regrouped (the 541-signal trend stays): that would need the AI and a long run.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Module = require('module');

function NoRedis() {
  const self = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : k === 'on' ? () => self : async () => null) });
  return self;
}
if (require.main === module) {
  const realLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'ioredis') return NoRedis;
    return realLoad.call(this, request, ...rest);
  };
}

const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const proc = require('../modules/llmRelevanceProcessor');
const tc = require('../modules/trendClustering');

const APPLY = process.argv.includes('--apply');
const PARALLEL = Number(process.env.CLEAN_FO_PARALLEL) || 6;
const MODULE_ID = proc.FORWARD_OUTLOOK_MODULE_ID;
const TREND_COLLECTION = process.env.TREND_QDRANT_COLLECTION || 'trend_matching';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false });

const reportLines = [];
const out = (l = '') => reportLines.push(l);
const say = (l = '') => { console.log(l); out(l); };
const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dateOf = (s) => String(s.source_published_date || s.created_at || '');

async function readAll(db, tableName, columns, filter, schema) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = (schema ? db.schema(schema) : db).from(tableName).select(columns).order('id', { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${tableName}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

// ── the plan (changes nothing) ─────────────────────────────────────────────
function buildPlan(signals, trends, memberships, clientById) {
  const count = { dead: 0, exact: 0, noTrend: 0, deadTrends: 0, emptyTrends: 0, named: 0, sectorFixed: 0 };
  const remove = [];                                   // { row, why }
  const trendOfSignal = new Map(memberships.map((m) => [m.signal_id, m.trend_id]));
  const keptByTitle = new Map();
  const sorted = [...signals].sort((a, b) => (dateOf(a) < dateOf(b) ? -1 : dateOf(a) > dateOf(b) ? 1 : String(a.id) < String(b.id) ? -1 : 1));
  for (const row of sorted) {                          // oldest first: the first one is kept
    if (!clientById.has(row.client_id)) { remove.push({ row, why: 'client no longer exists' }); count.dead++; continue; }
    const k = `${row.client_id}|${normTitle(row.signal_title)}`;
    if (normTitle(row.signal_title) && keptByTitle.has(k)) { remove.push({ row, why: `same title as ${keptByTitle.get(k).article_id}` }); count.exact++; continue; }
    if (!trendOfSignal.has(row.id)) { remove.push({ row, why: 'in no trend (the trend step had failed)' }); count.noTrend++; continue; }
    keptByTitle.set(k, row);
  }
  const gone = new Set(remove.map((r) => r.row.id));
  const left = new Map();                              // trend -> kept signals
  for (const s of signals) {
    if (gone.has(s.id)) continue;
    const t = trendOfSignal.get(s.id);
    if (!left.has(t)) left.set(t, []);
    left.get(t).push(s);
  }
  const deleteTrends = []; const fixTrends = [];
  for (const t of trends) {
    if (!clientById.has(t.client_id)) { deleteTrends.push({ trend: t, why: 'client no longer exists' }); count.deadTrends++; continue; }
    const mine = left.get(t.id) || [];
    if (!mine.length) { deleteTrends.push({ trend: t, why: 'no signal left' }); count.emptyTrends++; continue; }
    if (t.status !== 'active') continue;
    const patch = {};
    if (!String(t.name || '').trim() || /^unnamed/i.test(t.name)) {
      // stand-in name (the first signal's title); with --apply the AI is asked once for a proper trend name
      patch.name = String(mine[0].signal_title || 'Emerging Trend').slice(0, 60);
      count.named++;
    }
    const sector = tc.validSector(t.sector, mine);
    if (sector !== t.sector) { patch.sector = sector; count.sectorFixed++; }
    if (Object.keys(patch).length) fixTrends.push({ trend: t, patch });
  }
  // active trends that lose signals: their signal count changes (the weekly scoring recomputes the rest)
  const shrunk = trends.filter((t) => clientById.has(t.client_id) && (left.get(t.id) || []).length
    && memberships.filter((m) => m.trend_id === t.id).length !== (left.get(t.id) || []).length).map((t) => t.id);
  return { remove, deleteTrends, fixTrends, shrunk, count };
}

// ── do it ──────────────────────────────────────────────────────────────────
// namer(trend) -> a proper trend name from the AI, or null (then the stand-in name is used)
async function applyPlan(plan, { db = supabase, qd = qdrant, progress = () => {}, namer = null } = {}) {
  const result = { signals: 0, trends: 0, fixed: 0, errors: [] };
  const inParallel = async (items, fn) => { for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(fn)); };

  await inParallel(plan.remove, async ({ row }) => {
    try {
      await db.from('trend_membership').delete().eq('signal_id', row.id);
      try { await qd.delete(TREND_COLLECTION, { wait: true, filter: { must: [{ key: 'article_id', match: { value: row.id } }, { key: 'type', match: { value: 'signal' } }] } }); } catch (e) { /* no vector */ }
      await proc.undoSave(row.article_id, 'trend_signals');
      // a signal row whose article_id is empty is not reached by undoSave
      await db.from('trend_signals').delete().eq('id', row.id);
    } catch (e) { result.errors.push(`signal ${row.id}: ${e.message}`); }
    result.signals++; progress('signals deleted', result.signals, plan.remove.length);
  });

  await inParallel(plan.deleteTrends, async ({ trend }) => {
    try {
      await db.from('trend_membership').delete().eq('trend_id', trend.id);
      await db.from('trend_snapshots').delete().eq('trend_id', trend.id);
      if (trend.centroid_point_id) { try { await qd.delete(TREND_COLLECTION, { wait: true, points: [trend.centroid_point_id] }); } catch (e) { /* no centroid */ } }
      const { error } = await db.from('trend_clusters').delete().eq('id', trend.id);
      if (error) throw new Error(error.message);
    } catch (e) { result.errors.push(`trend ${trend.id}: ${e.message}`); }
    result.trends++; progress('trends deleted', result.trends, plan.deleteTrends.length);
  });

  for (const { trend, patch } of plan.fixTrends) {
    if (patch.name && namer) {
      try { const better = await namer(trend); if (better) patch.name = better; } catch (e) { /* keep the stand-in name */ }
    }
    const { error } = await db.from('trend_clusters').update(patch).eq('id', trend.id);
    if (error) result.errors.push(`trend ${trend.id}: ${error.message}`); else result.fixed++;
  }
  for (const id of plan.shrunk) { try { await tc.updateTrendCentroid(id); } catch (e) { /* rebuilt on the next join */ } }
  return result;
}

async function main() {
  say(`Forward Outlook data cleanup - ${APPLY ? 'APPLY (changes will be made)' : 'DRY RUN (nothing is changed)'} - ${new Date().toISOString()}`);
  const clients = await readAll(supabase, 'clients', 'id, company_name, industry', null, 'admin');
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const signals = await readAll(supabase, 'trend_signals', 'id, article_id, client_id, signal_title, organization, sector, source_published_date, created_at');
  const trends = await readAll(supabase, 'trend_clusters', 'id, client_id, status, name, sector, centroid_point_id');
  const memberships = await readAll(supabase, 'trend_membership', 'id, trend_id, signal_id');
  say(`Read: ${signals.length} signals, ${trends.length} trends (${trends.filter((t) => t.status === 'active').length} active), ${clients.length} live clients`);

  const plan = buildPlan(signals, trends, memberships, clientById);
  const c = plan.count;
  say('');
  say('SIGNALS TO DELETE (signal + trend link + article rows + chat text)');
  say(`  deleted clients:        ${c.dead}`);
  say(`  same title again:       ${c.exact}`);
  say(`  in no trend:            ${c.noTrend}`);
  say(`  TOTAL:                  ${plan.remove.length}`);
  say(`SIGNALS KEPT: ${signals.length - plan.remove.length}`);
  say('');
  say('TRENDS');
  say(`  deleted clients:        ${c.deadTrends}`);
  say(`  left with no signal:    ${c.emptyTrends}`);
  say(`  TOTAL TO DELETE:        ${plan.deleteTrends.length}   (of these active: ${plan.deleteTrends.filter((d) => d.trend.status === 'active').length})`);
  say(`  active trends given a name: ${c.named} | sector corrected: ${c.sectorFixed}`);
  say(`TRENDS KEPT: ${trends.length - plan.deleteTrends.length}`);
  out('');
  out('TRENDS TO FIX');
  plan.fixTrends.forEach(({ trend, patch }) => out(`  ${trend.id} | "${trend.name || ''}" / ${trend.sector || ''} -> ${JSON.stringify(patch)}`));
  out('');
  out('ACTIVE TRENDS TO DELETE');
  plan.deleteTrends.filter((d) => d.trend.status === 'active').forEach(({ trend, why }) => out(`  ${trend.id} | "${trend.name || ''}" | ${why}`));
  out('');
  out('ALL SIGNALS TO DELETE');
  plan.remove.forEach(({ row, why }) => out(`  ${row.article_id} | ${clientById.get(row.client_id) ? clientById.get(row.client_id).company_name : row.client_id} | "${row.signal_title}" | ${why}`));

  const dir = path.join(__dirname, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cleanOutlookData-${APPLY ? 'applied' : 'dryrun'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`);
  fs.writeFileSync(file, reportLines.join('\n'));
  console.log(`\nFull report: ${file}`);
  if (!APPLY) { console.log('\nDRY RUN - nothing was changed. Read the report, then run with --apply.'); return; }

  console.log('\nApplying...');
  const realLog = console.log;
  console.log = (...a) => { if (!/^\s*\[(Centroid|Storage|NamingWriteup)\]/.test(String(a[0]))) realLog(...a); };
  let last = 0;
  const namer = async (trend) => {
    const client = clientById.get(trend.client_id);
    const w = await tc.generateTrendNameAndWriteup(trend.id, client.industry, trend.client_id);
    return w && w.name && !/^unnamed/i.test(w.name) ? w.name : null;
  };
  const r = await applyPlan(plan, { namer, progress: (label, n, total) => { if (n === total || Date.now() - last > 2000) { last = Date.now(); process.stdout.write(`\r  ${label}: ${n}/${total}      `); } } });
  console.log = realLog;
  console.log(`\n\nDone. Signals deleted: ${r.signals} | trends deleted: ${r.trends} | trends fixed: ${r.fixed} | errors: ${r.errors.length}`);
  r.errors.slice(0, 20).forEach((e) => console.log(`  ${e}`));
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(`\nCleanup stopped: ${e.message}`); process.exit(1); });
}
module.exports = { buildPlan, applyPlan };   // used by scripts/testOutlookPipeline.js
