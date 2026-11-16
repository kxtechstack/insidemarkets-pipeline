/**
 * scripts/testCompetitivePipeline.js
 *
 * DUMMY-DATA TEST for the Competitive Intelligence fixes (16 Nov audit).
 * Same idea as scripts/testPolicyPipeline.js: the REAL code (modules/competitiveIntelligence/*.js)
 * runs with an in-memory Supabase / Qdrant and a fake AI. Nothing real is read or written:
 * no database, no Qdrant, no AI calls, no search credits.
 *
 * Run:   node scripts/testCompetitivePipeline.js
 *
 * What it proves (one line per gap found in the CI audit):
 *   C1  countries are saved one way, the same as Policy ("UAE" -> "United Arab Emirates")
 *   C2  laptop + server: a competitor that is still on the press / blog / own-site step is not
 *       started a second time (before: only the news step was checked)
 *   C3  a joined card's chat copy is removed by the timer, even when the first delete failed
 *   C4  a verified card whose chat copy is missing gets it back (SolarGrid's 9 cards)
 */

const path = require('path');
const Module = require('module');
const MODULES = path.join(__dirname, '..', 'modules');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'fake';

// ═════════════════════════════════════════════════════════════════════════
// Fake Supabase (in memory)
// ═════════════════════════════════════════════════════════════════════════
const db = {};
const table = (name) => (db[name] = db[name] || []);
let idCounter = 0;

/** "is_duplicate.is.null,is_duplicate.eq.false" -> row test */
function orFilter(expr) {
  const parts = String(expr).split(',').map((p) => p.trim().split('.'));
  return (row) => parts.some(([col, op, ...v]) => {
    const value = v.join('.');
    if (op === 'is') return value === 'null' ? row[col] == null : String(row[col]) === value;
    if (op === 'eq') return String(row[col]) === value;
    if (op === 'neq') return String(row[col]) !== value;
    return false;
  });
}

function query(name) {
  const st = { name, filters: [], order: null, from: 0, to: null, limit: null, op: 'select', payload: null, wantOne: false, maybe: false, selectAfter: false };
  const rows = () => {
    let r = table(st.name).filter((row) => st.filters.every((f) => f(row)));
    if (st.order) {
      const { col, asc } = st.order;
      r = [...r].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    if (st.to !== null) r = r.slice(st.from, st.to + 1);
    if (st.limit !== null) r = r.slice(0, st.limit);
    return r.slice(0, 1000);
  };
  const run = () => {
    if (st.op === 'insert' || st.op === 'upsert') {
      const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((x) => ({ id: `row${++idCounter}`, created_at: new Date().toISOString(), ...x }));
      table(st.name).push(...list);
      if (st.wantOne) return { data: list[0], error: null };
      return { data: st.selectAfter ? list : null, error: null };
    }
    if (st.op === 'update') { const r = rows(); r.forEach((row) => Object.assign(row, st.payload)); return { data: r, error: null }; }
    if (st.op === 'delete') { db[st.name] = table(st.name).filter((row) => !st.filters.every((f) => f(row))); return { data: null, error: null }; }
    const r = rows();
    if (st.wantOne) return r.length ? { data: r[0], error: null } : (st.maybe ? { data: null, error: null } : { data: null, error: { message: 'no rows' } });
    return { data: r, error: null, count: r.length };
  };
  const q = {
    select() { if (st.op !== 'select') st.selectAfter = true; return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; },
    upsert(p) { st.op = 'upsert'; st.payload = p; return q; },
    update(p) { st.op = 'update'; st.payload = p; return q; },
    delete() { st.op = 'delete'; return q; },
    eq(c, v) { st.filters.push((r) => r[c] === v); return q; },
    neq(c, v) { st.filters.push((r) => r[c] !== v); return q; },
    in(c, v) { st.filters.push((r) => v.includes(r[c])); return q; },
    gte(c, v) { st.filters.push((r) => r[c] != null && String(r[c]) >= String(v)); return q; },
    lt(c, v) { st.filters.push((r) => r[c] != null && String(r[c]) < String(v)); return q; },
    is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
    or(expr) { st.filters.push(orFilter(expr)); return q; },
    order(col, o = {}) { st.order = { col, asc: o.ascending !== false }; return q; },
    range(a, b) { st.from = a; st.to = b; return q; },
    limit(n) { st.limit = n; return q; },
    single() { st.wantOne = true; return q; },
    maybeSingle() { st.wantOne = true; st.maybe = true; return q; },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  return q;
}
const fakeSupabase = { from: (n) => query(n), schema: (s) => ({ from: (n) => query(`${s}.${n}`) }) };

// ═════════════════════════════════════════════════════════════════════════
// Fake Qdrant (in memory)
// ═════════════════════════════════════════════════════════════════════════
const qd = {};
const coll = (n) => (qd[n] = qd[n] || []);
let failNextDelete = false;
class FakeQdrant {
  async getCollections() { return { collections: Object.keys(qd).map((name) => ({ name })) }; }
  async createCollection(n) { coll(n); }
  async createPayloadIndex() { throw new Error('already exists'); }
  async upsert(n, { points }) { for (const p of points) { const c = coll(n); const i = c.findIndex((x) => x.id === p.id); if (i >= 0) c[i] = p; else c.push(p); } }
  async retrieve(n, { ids }) { return coll(n).filter((p) => ids.includes(p.id)); }
  async delete(n, { points }) {
    if (failNextDelete) { failNextDelete = false; throw new Error('fetch failed'); }
    qd[n] = coll(n).filter((p) => !points.includes(p.id));
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Swap the real services for the fakes, then load the REAL CI code
// ═════════════════════════════════════════════════════════════════════════
const realLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeSupabase };
  if (request === '@qdrant/js-client-rest') return { QdrantClient: FakeQdrant };
  if (request === 'dotenv') return { config() {} };
  if (request === 'ioredis') return class { on() { return this; } };
  const file = (() => { try { return Module._resolveFilename(request, parent); } catch (e) { return path.join(path.sep, `${request}.js`); } })();
  if (file.endsWith(`${path.sep}llmClient.js`)) return { callLLM: async () => '{}' };
  if (file.endsWith(`${path.sep}llmRelevanceProcessor.js`)) return { embedText: async (t) => Array.from({ length: 8 }, (_, i) => ((String(t).charCodeAt(i) || 1) % 7) + 1) };
  if (file.endsWith(`${path.sep}reader.js`) && file.includes('competitiveIntelligence')) {
    return { loadSignals: async () => ({ enabledCount: 1 }) };
  }
  if (file.endsWith(`${path.sep}activity.js`) && file.includes('competitiveIntelligence')) return { refreshActivitySafe: async () => {} };
  return realLoad.call(this, request, parent, ...rest);
};

const CI = path.join(MODULES, 'competitiveIntelligence');
const { CI_MODULE_ID, QDRANT } = require(path.join(CI, 'constants.js'));
const store = require(path.join(CI, 'changeStore.js'));
const newsRun = require(path.join(CI, 'newsRun.js'));

// ═════════════════════════════════════════════════════════════════════════
// Checks
// ═════════════════════════════════════════════════════════════════════════
let passed = 0; let failed = 0;
const log = (s) => console.log(s);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true) { passed++; log(`  PASS  ${name}`); } else { failed++; log(`  FAIL  ${name}\n        got: ${JSON.stringify(r)}`); }
  } catch (e) { failed++; log(`  FAIL  ${name}\n        error: ${e.message}`); }
}

const CLIENT = 'client-ci-1';
function resetData() {
  for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(qd)) delete qd[k];
  table('admin.clients').push({ id: CLIENT, company_name: 'Northwind Beauty', industry: 'Cosmetics', location: 'Dubai, UAE', status: 'active', enabled_modules: [CI_MODULE_ID] });
  table('admin.competitors').push({ id: 'comp-1', client_id: CLIENT, name: 'Lumina Labs', is_active: true });
}
const card = (over) => ({ id: `chg-${++idCounter}`, client_id: CLIENT, competitor_id: 'comp-1', organization: 'Lumina Labs',
  signal_title: 'Lumina Labs opens a store in Dubai', chat_text: 'Lumina Labs opens a store in Dubai', status: 'verified',
  is_duplicate: false, event_date: '2026-11-10', category: 'Expansion', signal_name: 'New store', ...over });

async function main() {
  log('Competitive Intelligence dummy-data test');

  log('\n── C1: countries saved one way (same as Policy) ──');
  await check('"UAE" -> "United Arab Emirates"', async () => store.standardCountry('UAE') === 'United Arab Emirates' || store.standardCountry('UAE'));
  await check('"UK, KSA" -> "United Kingdom, Saudi Arabia"', async () => store.standardCountry('UK, KSA') === 'United Kingdom, Saudi Arabia' || store.standardCountry('UK, KSA'));
  await check('empty -> nothing (no fake country)', async () => store.standardCountry('') === null && store.standardCountry(null) === null);
  await check('the client country from loadClient ("Dubai, UAE" -> UAE profile) is standardised when saved', async () => {
    resetData();
    const client = await newsRun.loadClient(CLIENT);
    return store.standardCountry(client.country) === 'United Arab Emirates' || [client.country, store.standardCountry(client.country)];
  });

  log('\n── C2: laptop + server at the same time ──');
  resetData();
  table('competitor_runs').push({ id: 'run-1', client_id: CLIENT, competitor_id: 'comp-1', section: 'press', status: 'running', started_at: new Date().toISOString() });
  let res = await newsRun.runNewsForClient(CLIENT, { triggeredBy: 'schedule' });
  await check('competitor still on the PRESS step on the other machine -> skipped here', async () =>
    (res.competitors && res.competitors[0] && /already ran/.test(res.competitors[0].skipped || '')) || res);
  resetData();
  table('competitor_runs').push({ id: 'run-2', client_id: CLIENT, competitor_id: 'comp-1', section: 'product', status: 'running', started_at: new Date().toISOString() });
  res = await newsRun.runNewsForClient(CLIENT, { triggeredBy: 'schedule' });
  await check('a product-page check (not the daily run) does NOT block the daily run', async () =>
    (res.competitors && res.competitors[0] && !res.competitors[0].skipped) || res);
  resetData();
  table('competitor_runs').push({ id: 'run-3', client_id: CLIENT, competitor_id: 'comp-1', section: 'news', status: 'completed', started_at: new Date(Date.now() - 30 * 3600e3).toISOString() });
  res = await newsRun.runNewsForClient(CLIENT, { triggeredBy: 'schedule' });
  await check('a run older than 20 hours does not block today', async () =>
    (res.competitors && res.competitors[0] && !res.competitors[0].skipped) || res);

  log('\n── C3 + C4: chat copies match the cards (timer job) ──');
  resetData();
  const kept = card({ signal_title: 'Lumina Labs opens a store in Dubai' });
  const joined = card({ signal_title: 'Lumina opens Dubai store', is_duplicate: true, status_reason: `joined into ${kept.id}` });
  const lost = card({ signal_title: 'Lumina Labs launches a vitamin C serum', status: 'verified' });
  const oldNull = card({ signal_title: 'Lumina Labs cuts prices online', is_duplicate: null });   // old rows may have no flag
  table('competitor_changes').push(kept, joined, lost, oldNull);
  for (const c of [kept, joined, lost, oldNull]) {
    table('competitor_change_evidence').push({ change_id: c.id, url: `https://news.example.com/${c.id}`, source_kind: 'news', published_date: '2026-11-10' });
  }
  // in the chat: the kept card, the joined card (its delete failed), the old card; the "lost" one is missing
  coll(QDRANT.COLLECTION).push(
    { id: kept.id, vector: [1], payload: { change_id: kept.id } },
    { id: joined.id, vector: [1], payload: { change_id: joined.id } },
    { id: oldNull.id, vector: [1], payload: { change_id: oldNull.id } },
  );
  const r = await store.repairChatCopies();
  const ids = coll(QDRANT.COLLECTION).map((p) => p.id);
  await check('C3: the joined card\'s chat copy is removed', async () => !ids.includes(joined.id) || ids);
  await check('C4: the verified card with NO chat copy gets it back', async () => ids.includes(lost.id) || ids);
  await check('the kept card and the old card (no duplicate flag) stay in the chat', async () => (ids.includes(kept.id) && ids.includes(oldNull.id)) || ids);
  await check('the timer reports what it did (1 removed, 1 restored)', async () => (r.removed === 1 && r.restored === 1) || r);
  const r2 = await store.repairChatCopies();
  await check('running it again changes nothing (nothing left to fix)', async () => (r2.removed === 0 && r2.restored === 0) || r2);

  log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
