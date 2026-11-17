/**
 * scripts/testMarketPipeline.js
 *
 * DUMMY-DATA TEST for the Market Dynamics pipeline (16 Nov audit).
 * Same design as scripts/testPolicyPipeline.js: the REAL pipeline code runs with fake news, a fake AI,
 * and an in-memory Supabase / Qdrant / Redis. Nothing real is read or written: no database, no Qdrant,
 * no AI calls, no search credits.
 *
 * Run:   node scripts/testMarketPipeline.js
 *        DR_TEST_REAL_EMBEDDINGS=off node scripts/testMarketPipeline.js   (fake meaning-model, faster)
 *
 * What it proves (one line per problem found in the Market Dynamics audit):
 *   M1  a failed save (signal row or card) leaves nothing half-saved, and the article is tried again
 *   M2  card importance = how close the card is to the client (same rule as Policy), not the article count
 *   M3  the same event from two websites is saved ONCE (card count not inflated)
 *   M4  a new signal joins a card only when it fits: same sub-category, recent card, and the AI says same theme;
 *       the rewrite sees all signals on the card
 *   M5  countries written one way on signals and cards
 */

const path = require('path');
const Module = require('module');
const MODULES = path.join(__dirname, '..', 'modules');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://fake';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'fake';
process.env.LLM_CALL_DELAY_MS = '1';
process.env.INDUSTRY_GATE = 'on';

// ═════════════════════════════════════════════════════════════════════════
// Fake Supabase (in memory)
// ═════════════════════════════════════════════════════════════════════════
const db = {};
const table = (name) => (db[name] = db[name] || []);
let failInsertInto = null;   // set to a table name to make the next insert there fail
let idCounter = 0;

function likeToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
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
    return r.slice(0, 1000);   // like the real Supabase: at most 1,000 rows per request
  };
  const run = () => {
    if (st.op === 'insert') {
      if (failInsertInto === st.name) { failInsertInto = null; return { data: null, error: { message: `fake insert failure in ${st.name}` } }; }
      const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((x) => ({ id: `row${++idCounter}`, created_at: new Date().toISOString(), ...x }));
      table(st.name).push(...list);
      if (st.wantOne) return { data: list[0], error: null };
      return { data: st.selectAfter ? list : null, error: null };
    }
    if (st.op === 'update') {
      const r = rows();
      r.forEach((row) => Object.assign(row, st.payload));
      return { data: r, error: null };
    }
    if (st.op === 'delete') {
      const keep = table(st.name).filter((row) => !st.filters.every((f) => f(row)));
      db[st.name] = keep;
      return { data: null, error: null };
    }
    const r = rows();
    if (st.wantOne) return r.length ? { data: r[0], error: null } : (st.maybe ? { data: null, error: null } : { data: null, error: { message: 'no rows' } });
    return { data: r, error: null, count: r.length };
  };
  const q = {
    select(cols, opts) { if (st.op === 'insert') st.selectAfter = true; return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; },
    update(p) { st.op = 'update'; st.payload = p; return q; },
    delete() { st.op = 'delete'; return q; },
    eq(c, v) { st.filters.push((r) => (c.includes('.') ? c.split('.').reduce((o, k) => (o == null ? o : o[k]), r) : r[c]) === v); return q; },
    not(c, op, v) { st.filters.push((r) => !(op === 'is' && v === null ? r[c] == null : r[c] === v)); return q; },
    or() { return q; },
    neq(c, v) { st.filters.push((r) => r[c] !== v); return q; },
    in(c, v) { st.filters.push((r) => v.includes(r[c])); return q; },
    gte(c, v) { st.filters.push((r) => r[c] != null && String(r[c]) >= String(v)); return q; },
    lt(c, v) { st.filters.push((r) => r[c] != null && String(r[c]) < String(v)); return q; },
    ilike(c, p) { const re = likeToRegex(p); st.filters.push((r) => re.test(String(r[c] || ''))); return q; },
    is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
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
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; };
const fits = (p, filter) => !filter || (filter.must || []).every((c) => {
  if (c.is_empty) return p.payload[c.is_empty.key] == null;
  const v = p.payload[c.key];
  if (c.match) return c.match.any ? c.match.any.includes(v) : v === c.match.value;
  if (c.range) return v != null && (c.range.gte == null || v >= c.range.gte) && (c.range.lte == null || v <= c.range.lte);
  return true;
});
let dropNextSearch = false;   // set true to make the next search fail like a dropped connection
let searchDrops = 0;
class FakeQdrant {
  async getCollections() { return { collections: Object.keys(qd).map((name) => ({ name })) }; }
  async createCollection(n) { coll(n); }
  async createPayloadIndex() { throw new Error('already exists'); }
  async upsert(n, { points }) { for (const p of points) { const c = coll(n); const i = c.findIndex((x) => x.id === p.id); if (i >= 0) c[i] = p; else c.push(p); } }
  async scroll(n, { filter, limit = 10 }) { return { points: coll(n).filter((p) => fits(p, filter)).slice(0, limit), next_page_offset: null }; }
  async search(n, { vector, limit = 5, filter }) {
    if (dropNextSearch) { dropNextSearch = false; searchDrops++; const e = new TypeError('fetch failed'); e.cause = { code: 'UND_ERR_SOCKET', message: 'other side closed' }; throw e; }
    return coll(n).filter((p) => fits(p, filter)).map((p) => ({ ...p, score: cosine(vector, p.vector) }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }
  async delete(n, { filter, points }) { qd[n] = coll(n).filter((p) => (points ? !points.includes(p.id) : !fits(p, filter))); }
  async count(n, { filter } = {}) { return { count: coll(n).filter((p) => fits(p, filter)).length }; }
  async retrieve(n, { ids }) { return coll(n).filter((p) => ids.includes(p.id)); }
}

// ═════════════════════════════════════════════════════════════════════════
// Fake AI: answers by looking at which prompt it got and which test article it is
// ═════════════════════════════════════════════════════════════════════════
const aiScript = new Map();   // marker in the article title -> { gate, answer, synthTitle }
const promptsSeen = [];
const differentEvents = ['Kings County', 'Abu Dhabi'];
const fitRules = [];   // [text in the new signal title, card number the fake AI picks (0 = none)]   // the fake "same event?" AI says DIFFERENT when the prompt has one of these
async function fakeCallLLM(messages) {
  const prompt = messages.map((m) => m.content).join('\n');
  promptsSeen.push(prompt);
  await new Promise((r) => setTimeout(r, 5));
  const item = [...aiScript.entries()].find(([marker]) => prompt.includes(marker));
  const s = item ? item[1] : {};
  if (prompt.includes('You check which industry')) {
    return JSON.stringify({ about_industry: s.gate !== false, main_industry: s.gate === false ? 'Banking' : 'Cosmetics', reason: 'test' });
  }
  if (prompt.includes('Do they report the SAME specific event')) {
    const diff = differentEvents.some((x) => prompt.includes(x));
    return JSON.stringify({ same: !diff, reason: diff ? 'different county' : 'same event' });
  }
  if (prompt.includes('First line must be: Title:')) {
    return `${s.synthFormat || 'Title: '}${s.synthTitle || 'A rewritten title for the test'}${s.synthFormat ? '**' : ''}\n\n${`${s.synthTitle || 'A rewritten body in new words'}. `.repeat(12)} ${item ? item[0] : ''}`;
  }
  if (prompt.includes('Market Dynamics Monitor')) return typeof s.answer === 'string' ? s.answer : JSON.stringify(s.answer || { is_relevant: false, reason: 'not scripted' });
  if (prompt.includes('Does the new signal belong to one of the cards')) {
    const rule = fitRules.find(([text]) => prompt.split('NEW SIGNAL:')[1].split('\n')[0].includes(text));
    return JSON.stringify({ card: rule ? rule[1] : 1, reason: rule && rule[1] === 0 ? 'different theme' : 'same theme' });
  }
  if (prompt.includes('Write the market card')) {
    if (s.writeupFails) throw new Error('fake AI timeout');
    const w = s.writeup || {};
    return JSON.stringify({ title: w.title || 'A market card', summary: w.summary || 'What is happening in the market.', short_summary: 'Short.', business_impact: ['x'], country: w.country || 'Global' });
  }
  if (prompt.includes('Policy and Risk Monitor')) return typeof s.answer === 'string' ? s.answer : JSON.stringify(s.answer || { is_relevant: false, reason: 'not scripted' });
  return '{}';
}

// ═════════════════════════════════════════════════════════════════════════
// Meaning model (real one by default, like the pipeline; fake one for quick runs)
// ═════════════════════════════════════════════════════════════════════════
const REAL_EMBEDDINGS = process.env.DR_TEST_REAL_EMBEDDINGS !== 'off';
const fakeTransformers = {
  pipeline: async () => async (text) => {
    const v = new Float32Array(384);
    for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
      let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % 384] += 1;
    }
    const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return { data: v.map((x) => x / n) };
  },
};

// ═════════════════════════════════════════════════════════════════════════
// Swap the real services for the fakes, then load the REAL pipeline code
// ═════════════════════════════════════════════════════════════════════════
const realLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeSupabase };
  if (request === '@qdrant/js-client-rest') return { QdrantClient: FakeQdrant };
  if (request === 'dotenv') return { config() {} };
  if (request === 'ioredis') return class { constructor() {} async expire() {} async rpush() {} async lrange() { return []; } async llen() { return 0; } async set() { return 'OK'; } async get() { return null; } async del() {} async lrem() {} async lmove() { return null; } async expire2() {} };
  if (request === '@xenova/transformers' && !REAL_EMBEDDINGS) return fakeTransformers;
  const file = (() => { try { return Module._resolveFilename(request, parent); } catch (e) { return path.join(path.sep, `${request}.js`); } })();
  if (file.endsWith(`${path.sep}llmClient.js`)) return { callLLM: fakeCallLLM };
  if (file.endsWith(`${path.sep}trendClustering.js`)) return { matchSignalToTrend: async () => {} };
  if (file.endsWith(`${path.sep}jobStatusTracker.js`)) return new Proxy({}, { get: () => async () => {} });
  if (file.endsWith(`${path.sep}queueManager.js`)) {
    return { redis: { rpush: async () => {}, expire: async () => {} }, refreshLock: async () => {}, setStatus: async () => {},
      sortByNewest: (a) => a, pushToQueue: async () => 'q', readBatch: async () => [], getQueueLength: async () => 0 };
  }
  return realLoad.call(this, request, parent, ...rest);
};


const proc = require(path.join(MODULES, 'llmRelevanceProcessor.js'));
const md = require(path.join(MODULES, 'marketInsights.js'));

// ═════════════════════════════════════════════════════════════════════════
// Test setup: one fake client (nothing about a real client is fixed in the code)
// ═════════════════════════════════════════════════════════════════════════
const CLIENT = 'client-md-1';
const MD = proc.MARKET_DYNAMICS_MODULE_ID;
const SUB = 'sub-md-a';
const DIM = 'dim-competition';   // the dimension (submodule) the card belongs to

function resetData() {
  for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(qd)) delete qd[k];
  aiScript.clear();
  promptsSeen.length = 0;
  table('admin.clients').push({ id: CLIENT, company_name: 'Northwind Beauty', industry: 'Cosmetics' });
  table('admin.client_icp').push({ client_id: CLIENT, context_json: {
    competitors: ['Glowly'], core_sectors: ['Prestige Beauty'], focus_products_services: ['Prestige skincare'],
    geographic_focus: ['AE', 'UK'], sectors_to_avoid: [],
  } });
  table('admin.submodules').push({ id: DIM, submodule_name: 'Competitive Landscape' });
  table('admin.client_signals').push({ client_id: CLIENT, is_enabled: true,
    signals: { id: 'sig-1', signal_name: 'Funding rounds announced', signal_definition: 'funding rounds', submodule_id: DIM, module_id: MD, submodules: { id: DIM, submodule_name: 'Funding & Investment' } } });
  table('admin.client_signals').push({ client_id: CLIENT, is_enabled: true,
    signals: { id: 'sig-2', signal_name: 'Venture capital investments', signal_definition: 'VC investments', submodule_id: DIM, module_id: MD, submodules: { id: DIM, submodule_name: 'Funding & Investment' } } });
  fitRules.length = 0;
  // the database prompts the pipeline reads (it has no copies in the code)
  Object.entries(require('./testPromptTexts')).filter(([id]) => id !== 'industry_gate_v1').forEach(([id, t]) => table('prompts').push({ id, is_active: true, prompt_template: t }));
  table('prompts').push(
    { id: 'market_dynamics_relevance_v1', is_active: true, prompt_template: 'Market Dynamics Monitor for {industry}. Title: {title}\nText: {text}\nSCOPE: {monitoring_scope}' },
    { id: 'article_synthesis_v1', is_active: true, prompt_template: 'First line must be: Title: ...\nArticle Title: {title}\n{text}' },
    { id: 'industry_gate_v1', is_active: true, prompt_template: 'You check which industry. INDUSTRY: {industry}\nARTICLE TITLE: {title}\n{text}' },
    { id: 'market_dynamics_writeup_v1', is_active: true, prompt_template: 'Write the market card for {industry}.\n{existing_card}\nNEW: {new_article}' },
  );
}

const longText = (topic) => `${topic}. `.repeat(Math.ceil(320 / (topic.length + 2)));
const art = (marker, title, extra = {}) => ({
  title: `${title} [${marker}]`, url: `https://news.example.com/${marker}`, publishedDate: '2026-11-10T08:00:00Z', text: longText(title), ...extra,
});
const relevant = (over = {}) => ({
  is_relevant: true, reason: 'test', topic_summary: 't', signal_number: 1, category: 'Corporate Activity',
  country: 'Global', organization: 'Unknown', signal_title: 'Test signal', summary: 'A market summary.', ...over,
});
const run = (articles, jobId) => proc.processArticlesForRelevance(articles, CLIENT, 'Cosmetics', jobId || 'job-md', MD, SUB);
const signals = () => table('market_dynamics_signals');
const cards = () => table('market_insights');

let passed = 0;
let failed = 0;
const log = (...a) => console.log(...a);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true) { passed++; log(`  PASS  ${name}`); } else { failed++; log(`  FAIL  ${name}\n        got: ${JSON.stringify(r)}`); }
  } catch (e) { failed++; log(`  FAIL  ${name}\n        crashed: ${e.stack || e.message}`); }
}

async function main() {
  log(`Market Dynamics dummy-data test (${REAL_EMBEDDINGS ? 'real meaning model' : 'fake meaning model'})\n`);

  log('── M5 + normal save: one article -> one signal + one card, countries written one way ──');
  resetData();
  aiScript.set('[ok-1]', { answer: relevant({ signal_title: 'Glowly opens flagship store in Dubai', organization: 'Glowly', country: 'UAE' }),
    synthTitle: 'Glowly Opens Flagship Store in Dubai', writeup: { title: 'Glowly expands retail in the Gulf', summary: 'Glowly opened a flagship store in Dubai.', country: 'UAE' } });
  await run([art('ok-1', 'Glowly opens flagship store in Dubai')]);
  await check('one signal saved, linked to one card', async () => (signals().length === 1 && cards().length === 1 && signals()[0].insight_id === cards()[0].id) || [signals(), cards()]);
  await check('signal country "UAE" -> "United Arab Emirates"', async () => signals()[0].country === 'United Arab Emirates' || signals()[0].country);
  await check('card country "UAE" -> "United Arab Emirates"', async () => cards()[0].country === 'United Arab Emirates' || cards()[0].country);

  log('\n── M2: card importance = closeness to the client (not the number of articles) ──');
  await check('competitor (Glowly) + client country (UAE) -> Critical, with a reason', async () =>
    (cards()[0].relevance_level === 'Critical' && /Glowly/.test(cards()[0].impact_reason || '')) || cards()[0]);
  const general = await md.cardImpact(CLIENT, { title: 'Beauty retail footfall rises in Brazil', summary: 'Shoppers returned to malls.', country: 'Brazil' }, ['MallCo']);
  await check('a busy general topic (nothing about the client) -> Low, even with many articles', async () => general.impact_level === 'Low' || general);
  await check('the old count rule is gone: 8 articles alone no longer make a card Critical', async () => md.calculateRelevanceLevel(8) === 'Critical' && general.impact_level !== 'Critical');

  log('\n── M3: the same event from two websites -> ONE signal on the card ──');
  resetData();
  aiScript.set('[ev-a]', { answer: relevant({ signal_title: 'Glowly Opens Flagship Store in Dubai Mall', organization: 'Glowly', country: 'UAE' }), synthTitle: 'Glowly Opens Flagship Store in Dubai Mall' });
  aiScript.set('[ev-b]', { answer: relevant({ signal_title: 'Glowly Flagship Store Opens in Dubai Mall', organization: 'Glowly', country: 'United Arab Emirates' }), synthTitle: 'Glowly Flagship Store Launches at Dubai Mall' });
  await run([art('ev-a', 'Glowly opens its first Gulf flagship at Dubai Mall')]);
  await run([art('ev-b', 'Beauty brand Glowly unveils Dubai Mall flagship store')], 'job-md-2');
  await check('second website copy -> not saved again', async () => signals().length === 1 || signals().map((x) => x.signal_title));
  await check('the card counts the event once (signal_count 1)', async () => (cards().length === 1 && cards()[0].signal_count === 1) || cards());
  await check('the copy is logged as a duplicate (link remembered)', async () => table('article_processing_log').some((r) => r.status === 'skipped' && /Duplicate/i.test(JSON.stringify(r))));

  log('\n── M1: a failed save leaves nothing half-saved ──');
  resetData();
  failInsertInto = 'market_dynamics_signals';
  aiScript.set('[fail-sig]', { answer: relevant({ signal_title: 'Lumina cuts prices in Singapore', organization: 'Lumina', country: 'Singapore' }) });
  await run([art('fail-sig', 'Lumina cuts prices in Singapore')]);
  await check('signal row fails -> no signal, no card, no article rows, no chat text', async () =>
    (signals().length === 0 && cards().length === 0 && table('policy_articles_full').length === 0 && table('policy_articles_metadata').length === 0 && coll('policy_articles').length === 0)
    || { signals: signals().length, cards: cards().length, full: table('policy_articles_full').length, qdrant: coll('policy_articles').length });
  await check('logged as FAILED and the link NOT remembered (tried again next run)', async () =>
    (table('article_processing_log').some((r) => r.status === 'failed') && !table('processed_urls').some((r) => /fail-sig/.test(JSON.stringify(r)))) || table('article_processing_log'));
  resetData();
  aiScript.set('[fail-card]', { answer: relevant({ signal_title: 'Lumina opens a lab in Seoul', organization: 'Lumina', country: 'South Korea' }), writeupFails: true });
  await run([art('fail-card', 'Lumina opens a research lab in Seoul')]);
  await check('the card write-up AI fails -> no signal left without a card (the old "orphans")', async () =>
    (signals().length === 0 && cards().length === 0 && coll('policy_articles').length === 0) || { signals: signals(), cards: cards() });
  await run([art('fail-card', 'Lumina opens a research lab in Seoul')], 'job-md-retry');
  await check('... and the same article is tried again on the next run', async () => promptsSeen.filter((p) => p.includes('Write the market card')).length === 2);

  log('\n── M4: a new signal joins a card only when it fits (same sub-category, same theme) ──');
  resetData();
  const fitAsks = () => promptsSeen.filter((p) => p.includes('Does the new signal belong to one of the cards')).length;
  aiScript.set('[c1]', { answer: relevant({ signal_number: 1, signal_title: 'Lumo raises seed funding for scalp serum', organization: 'Lumo' }), synthTitle: 'Scalp Serum Brand Raises Seed Funding Round', writeup: { title: 'Scalp-care brands raise early funding' } });
  aiScript.set('[c2]', { answer: relevant({ signal_number: 1, signal_title: 'Fizz raises Series A for scalp care', organization: 'Fizz' }), synthTitle: 'Scalp Care Brand Raises Series A Funding Round', writeup: { title: 'Scalp-care brands raise early funding' } });
  aiScript.set('[c3]', { answer: relevant({ signal_number: 2, signal_title: 'Beauty VC fund backs scalp care maker Tress', organization: 'Tress' }), synthTitle: 'Scalp Care Brand Raises Venture Funding Round', writeup: { title: 'VC funds back haircare' } });
  aiScript.set('[c4]', { answer: relevant({ signal_number: 1, signal_title: 'Glowly raises debt for new factory', organization: 'Glowly' }), synthTitle: 'Brand Raises Funding Round For Factory', writeup: { title: 'Glowly factory funding' } });
  fitRules.push(['Glowly', 0]);
  await run([art('c1', 'Lumo seed round scalp serum')], 'job-c1');
  await check('first signal -> new card, no AI fit question (nothing to compare with)', async () => (cards().length === 1 && fitAsks() === 0) || [cards().length, fitAsks()]);
  await run([art('c2', 'Fizz Series A haircare startup', { publishedDate: '2026-11-11T08:00:00Z' })], 'job-c2');
  await check('same sub-category + same theme (AI picks card 1) -> joins that card', async () => (cards().length === 1 && cards()[0].signal_count === 2 && fitAsks() === 1) || [cards().map((c) => [c.title, c.signal_count]), fitAsks()]);
  const lastWriteup = promptsSeen.filter((p) => p.includes('Write the market card')).pop() || '';
  await check('the rewrite sees ALL signals already on the card (not only the newest article)', async () => /SIGNALS ALREADY ON THIS CARD/.test(lastWriteup) && /Scalp Serum Brand Raises Seed Funding Round/.test(lastWriteup));
  await run([art('c3', 'Tress VC backing haircare', { publishedDate: '2026-11-12T08:00:00Z' })], 'job-c3');
  await check('another sub-category (Venture capital) -> its OWN card, never the Funding-rounds card', async () =>
    (cards().length === 2 && cards().find((c) => c.signal_id === 'sig-2') && cards().find((c) => c.signal_id === 'sig-1').signal_count === 2) || cards().map((c) => [c.signal_id, c.signal_count]));
  await check('... and no AI fit question for it (no card in its sub-category yet)', async () => fitAsks() === 1 || fitAsks());
  await check('every signal sits under the sub-category of its card', async () => signals().every((x) => cards().find((c) => c.id === x.insight_id).signal_id === x.signal_id) || signals().map((x) => [x.signal_id, x.insight_id]));
  await run([art('c4', 'Glowly factory debt', { publishedDate: '2026-11-13T08:00:00Z' })], 'job-c4');
  await check('same sub-category but the AI says another theme -> NEW card', async () => (cards().filter((c) => c.signal_id === 'sig-1').length === 2) || cards().map((c) => [c.title, c.signal_count]));
  cards().forEach((c) => { c.last_enriched_at = new Date(Date.now() - 45 * 864e5).toISOString(); });
  aiScript.set('[c5]', { answer: relevant({ signal_number: 1, signal_title: 'Nuvo secures angel money for hair tonic', organization: 'Nuvo' }), synthTitle: 'Scalp Serum Brand Raises Seed Funding Round Again', writeup: { title: 'Nuvo seed' } });
  const before = fitAsks();
  await run([art('c5', 'Nuvo seed scalp tonic', { publishedDate: '2026-11-14T08:00:00Z' })], 'job-c5');
  await check('cards not updated for 45 days are not reused -> new card, no AI question', async () => (cards().length === 4 && fitAsks() === before) || [cards().length, fitAsks() - before]);

  log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
