/**
 * scripts/testOutlookPipeline.js
 *
 * DUMMY-DATA TEST for the Forward Outlook pipeline (16 Nov audit).
 * Same design as scripts/testPolicyPipeline.js and scripts/testMarketPipeline.js: the REAL pipeline code
 * runs with fake news, a fake AI, and an in-memory Supabase / Qdrant / Redis. Nothing real is read or
 * written: no database, no Qdrant, no AI calls, no search credits.
 *
 * Run:   node scripts/testOutlookPipeline.js
 *
 * What it proves (one line per problem found in the Forward Outlook audit):
 *   F1  the same event from two websites is saved ONCE (Forward Outlook now has the same-event check)
 *   F2  a failed trend step leaves nothing half-saved (no signal without a trend), and it is tried again
 *   F3  a signal joins a trend only when it fits: very close -> joins; in between -> the AI decides;
 *       far -> its own hidden trend
 *   F4  a lonely signal finds another lonely signal even when many signals of active trends are closer
 *   F5  a trend goes on the radar WITH its name (never "Unnamed Trend"), sector never "Unknown",
 *       and a second trend with the same name is merged into the first
 *   F6  the old-data quick cleanup (scripts/cleanOutlookData.js): copies, dead clients and signals with no trend out
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
const nameRules = [];   // [text in the naming prompt, name, sector]
let namingFails = false;
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
  if (prompt.includes('Forward Outlook Monitor')) return typeof s.answer === 'string' ? s.answer : JSON.stringify(s.answer || { is_relevant: false, reason: 'not scripted' });
  if (prompt.includes('Does the new signal belong to one of the trends')) {
    const rule = fitRules.find(([text]) => prompt.split('NEW SIGNAL:')[1].split('\n')[0].includes(text));
    return JSON.stringify({ trend: rule ? rule[1] : 1, reason: rule && rule[1] === 0 ? 'another shift' : 'same shift' });
  }
  if (prompt.includes('Name this trend')) {
    if (namingFails) throw new Error('fake AI timeout');
    const n = nameRules.find(([text]) => prompt.includes(text));
    return JSON.stringify({ name: n ? n[1] : 'A named trend', summary: 'What this trend is.', business_impact: ['x'], impact: 'Medium', sector: n && n[2] ? n[2] : 'Not A Sector' });
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
const REAL_EMBEDDINGS = false;   // this test always uses the word-count model, so the scores (0.65 / 0.80 lines) are exact
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
  if (file.endsWith(`${path.sep}jobStatusTracker.js`)) return new Proxy({}, { get: () => async () => {} });
  if (file.endsWith(`${path.sep}queueManager.js`)) {
    return { redis: { rpush: async () => {}, expire: async () => {} }, refreshLock: async () => {}, setStatus: async () => {},
      sortByNewest: (a) => a, pushToQueue: async () => 'q', readBatch: async () => [], getQueueLength: async () => 0 };
  }
  return realLoad.call(this, request, parent, ...rest);
};



const proc = require(path.join(MODULES, 'llmRelevanceProcessor.js'));
const tc = require(path.join(MODULES, 'trendClustering.js'));

const CLIENT = 'client-fo-1';
const FO = proc.FORWARD_OUTLOOK_MODULE_ID;
const SUB = 'sub-fo-a';

function resetData() {
  for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(qd)) delete qd[k];
  aiScript.clear();
  promptsSeen.length = 0;
  fitRules.length = 0; nameRules.length = 0; namingFails = false;
  table('admin.clients').push({ id: CLIENT, company_name: 'Northwind Beauty', industry: 'Cosmetics' });
  table('admin.client_icp').push({ client_id: CLIENT, context_json: { competitors: ['Glowly'], core_sectors: ['Prestige Beauty'], focus_products_services: ['Prestige skincare'], geographic_focus: ['UK'], sectors_to_avoid: [] } });
  // the database prompts the pipeline reads (it has no copies in the code)
  Object.entries(require('./testPromptTexts')).filter(([id]) => id !== 'industry_gate_v1').forEach(([id, t]) => table('prompts').push({ id, is_active: true, prompt_template: t }));
  table('prompts').push(
    { id: 'forward_outlook_relevance_v1', is_active: true, prompt_template: 'Forward Outlook Monitor for {industry}. Title: {title}\nText: {text}\n{client_context}' },
    { id: 'article_synthesis_v1', is_active: true, prompt_template: 'First line must be: Title: ...\nArticle Title: {title}\n{text}' },
    { id: 'industry_gate_v1', is_active: true, prompt_template: 'You check which industry. INDUSTRY: {industry}\nARTICLE TITLE: {title}\n{text}' },
    { id: 'trend_naming_writeup_v1', is_active: true, prompt_template: 'Name this trend for {industry}.\n{client_context}\n{signals_text}' },
  );
}

const longText = (topic) => `${topic}. `.repeat(Math.ceil(320 / (topic.length + 2)));
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const art = (marker, title, extra = {}) => ({ title: `${title} [${marker}]`, url: `https://news.example.com/${marker}`, publishedDate: daysAgo(10), text: longText(title), ...extra });
const relevant = (over = {}) => ({ is_relevant: true, reason: 'test', signal_title: 'Test signal', signal_type: 'Innovation', organization: 'Unknown', sector: 'Product', horizon_estimate: 'mid_term', summary: 'A forward summary.', ...over });
const run = (articles, jobId) => proc.processArticlesForRelevance(articles, CLIENT, 'Cosmetics', jobId || 'job-fo', FO, SUB);
const signals = () => table('trend_signals');
const trends = () => table('trend_clusters');
const members = () => table('trend_membership');
const trendOf = (marker) => { const s = signals().find((x) => x.source_article_url.endsWith(marker)); const m = s && members().find((x) => x.signal_id === s.id); return m && m.trend_id; };
const fitAsks = () => promptsSeen.filter((p) => p.includes('Does the new signal belong to one of the trends')).length;
// one scripted article: the AI's short title (for the same-event check) and the rewritten title (its meaning)
const script = (marker, signalTitle, synthTitle, over = {}) => aiScript.set(`[${marker}]`, { answer: relevant({ signal_title: signalTitle, ...over }), synthTitle });

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
  log('Forward Outlook dummy-data test\n');

  log('── Normal save: one article -> one signal in one hidden (candidate) trend ──');
  resetData();
  script('ok-1', 'Lumo patents refillable serum pod', 'Refillable Serum Pod Patent Filed By Lumo Labs Today');
  await run([art('ok-1', 'Lumo files patent for a refillable pod')]);
  await check('one signal saved, in one candidate trend, no AI trend question', async () =>
    (signals().length === 1 && trends().length === 1 && trends()[0].status === 'candidate' && members().length === 1 && fitAsks() === 0) || [signals().length, trends(), members().length, fitAsks()]);
  await check('the signal has its sector and horizon', async () => (signals()[0].sector === 'Product' && signals()[0].horizon_estimate === 'mid_term') || signals()[0]);

  log('\n── F1: the same event from two websites -> ONE signal ──');
  resetData();
  script('ev-a', 'Glowly Opens Refill Station Network in London', 'Glowly Opens Refill Station Network Across London Stores');
  script('ev-b', 'Glowly Refill Station Network Opens in London', 'London Gets Glowly Refill Stations In Many Stores');
  await run([art('ev-a', 'Refill stations arrive at Glowly shops')]);
  await run([art('ev-b', 'A beauty chain rolls out refilling points')], 'job-fo-2');
  await check('second website copy -> not saved again', async () => signals().length === 1 || signals().map((x) => x.signal_title));
  await check('the copy did not start a second trend', async () => (trends().length === 1 && members().length === 1) || [trends().length, members().length]);
  await check('the copy is logged as a duplicate', async () => table('article_processing_log').some((r) => r.status === 'skipped' && /Duplicate/i.test(JSON.stringify(r))));

  log('\n── F2: a failed trend step leaves nothing half-saved ──');
  resetData();
  script('fail-t', 'Tress tests waterless shampoo bar', 'Waterless Shampoo Bar Trial Started By Tress Labs');
  failInsertInto = 'trend_membership';
  await run([art('fail-t', 'Tress waterless shampoo trial')]);
  await check('trend step fails -> no signal, no trend, no article rows, no chat text', async () =>
    (signals().length === 0 && trends().length === 0 && members().length === 0 && table('policy_articles_full').length === 0 && coll('policy_articles').length === 0 && coll('trend_matching').length === 0)
    || { signals: signals().length, trends: trends().length, members: members().length, full: table('policy_articles_full').length, chat: coll('policy_articles').length, vec: coll('trend_matching').length });
  await check('logged as FAILED and the link NOT remembered (tried again next run)', async () =>
    (table('article_processing_log').some((r) => r.status === 'failed') && !table('processed_urls').some((r) => /fail-t/.test(JSON.stringify(r)))) || table('article_processing_log'));
  await run([art('fail-t', 'Tress waterless shampoo trial')], 'job-fo-retry');
  await check('the next run saves it normally (signal + trend)', async () => (signals().length === 1 && members().length === 1 && trends().length === 1) || [signals().length, members().length]);

  log('\n── F3: a signal joins a trend only when it fits ──');
  resetData();
  // rewritten titles share words on purpose: 6 of 7 words = very close, 5 of 7 = in between, 2 of 7 = far
  script('t1', 'Lumo launches refill pouch', 'refillable packaging prestige beauty brand launch alpha');
  script('t2', 'Fizz adds refill jars', 'refillable packaging prestige beauty brand launch beta');
  script('t3', 'Glowly builds a peptide plant', 'refillable packaging prestige beauty brand peptide gamma');
  script('t4', 'Nuvo switches to refill cartons', 'packaging prestige beauty brand launch carton delta');
  script('t5', 'Pura funds microbiome research', 'microbiome research funding round closes for skin lab');
  fitRules.push(['Glowly', 0]);
  await run([art('t1', 'First refill story')], 'j1');
  await run([art('t2', 'Second story about jars')], 'j2');
  await check('very close (score 0.80 or more) -> joins the same trend, the AI is NOT asked', async () => (trendOf('t2') === trendOf('t1') && fitAsks() === 0) || [trendOf('t1'), trendOf('t2'), fitAsks()]);
  await run([art('t3', 'Third item on a plant')], 'j3');
  await check('in between + the AI says another shift -> its OWN trend', async () => (trendOf('t3') && trendOf('t3') !== trendOf('t1') && fitAsks() === 1) || [trendOf('t3'), trendOf('t1'), fitAsks()]);
  await run([art('t4', 'Fourth piece on cartons')], 'j4');
  await check('in between + the AI says same shift -> joins', async () => (trendOf('t4') === trendOf('t1') && fitAsks() === 2) || [trendOf('t4'), trendOf('t1'), fitAsks()]);
  await run([art('t5', 'Fifth note on a lab')], 'j5');
  await check('far (below 0.65) -> its own trend, the AI is NOT asked', async () => (trendOf('t5') && ![trendOf('t1'), trendOf('t3')].includes(trendOf('t5')) && fitAsks() === 2) || [trendOf('t5'), fitAsks()]);
  await check('every signal is in exactly one trend', async () => signals().every((x) => members().filter((m) => m.signal_id === x.id).length === 1) || members());

  log('\n── F5: promotion - on the radar WITH a name, sector never "Unknown" ──');
  nameRules.push(['refill', 'Refillable Prestige Packaging']);   // the fake AI answers sector "Not A Sector"
  await tc.runPromotionCheck(FO, CLIENT, 'Cosmetics');
  const big = () => trends().find((t) => t.id === trendOf('t1'));
  await check('3 signals + 7 days old -> active, named in the same step', async () => (big().status === 'active' && big().name === 'Refillable Prestige Packaging') || big());
  await check('AI gave a sector that is not one of the 5 -> the sector most of its signals have (Product)', async () => big().sector === 'Product' || big().sector);
  await check('one-signal trends stay hidden (candidate)', async () => trends().filter((t) => t.id !== big().id).every((t) => t.status === 'candidate') || trends().map((t) => t.status));
  // naming fails for another trend that is ready
  script('n1', 'Astra prints bio pigment', 'bio pigment printing method reaches pilot scale one');
  script('n2', 'Belle grows bio pigment', 'bio pigment printing method reaches pilot scale two');
  script('n3', 'Cove tests bio pigment', 'bio pigment printing method reaches pilot scale three');
  await run([art('n1', 'Pigment item one', { publishedDate: daysAgo(12) })], 'k1');
  await run([art('n2', 'Pigment item two')], 'k2');
  await run([art('n3', 'Pigment item three')], 'k3');
  namingFails = true;
  await tc.runPromotionCheck(FO, CLIENT, 'Cosmetics');
  namingFails = false;
  const pig = () => trends().find((t) => t.id === trendOf('n1'));
  await check('the naming AI fails twice -> still gets a real name and a real sector (never "Unnamed" / "Unknown")', async () =>
    (pig().status === 'active' && pig().name && !/unnamed|unknown/i.test(pig().name) && pig().sector === 'Product') || pig());
  await check('no active trend without a name', async () => trends().filter((t) => t.status === 'active').every((t) => t.name) || trends());
  await tc.runWeeklyScoring(FO, CLIENT, 'Cosmetics');
  await check('the weekly radar snapshot never says "Unnamed Trend" or sector "Unknown"', async () =>
    (table('trend_snapshots').length > 0 && table('trend_snapshots').every((x) => x.name && !/unnamed/i.test(x.name) && x.sector !== 'Unknown')) || table('trend_snapshots').map((x) => [x.name, x.sector]));
  const rawAiName = await (async () => { nameRules.unshift(['bio pigment', 'Unnamed Trend']); const r = await tc.generateTrendNameAndWriteup(trendOf('n1'), 'Cosmetics', CLIENT); nameRules.shift(); return r; })();
  await check('the AI itself answers "Unnamed Trend" -> a real name is used instead', async () => (rawAiName && !/unnamed/i.test(rawAiName.name)) || rawAiName);
  // a second group that the AI names the same as the first trend
  script('d1', 'Orla opens a top-up counter', 'pouch top up scheme opens at orla counters one');
  script('d2', 'Mira trials sachet desk', 'pouch top up scheme opens at mira counters two');
  script('d3', 'Vela pilots bottle return point', 'pouch top up scheme opens at vela counters three');
  await run([art('d1', 'Top up item one', { publishedDate: daysAgo(12) })], 'm1');
  await run([art('d2', 'Top up item two')], 'm2');
  await run([art('d3', 'Top up item three')], 'm3');
  nameRules.push(['Orla', 'Refillable-Prestige packaging']);
  const before = trends().filter((t) => t.status === 'active').length;
  await tc.runPromotionCheck(FO, CLIENT, 'Cosmetics');
  await check('a new group that gets the SAME name ("Refillable-Prestige packaging") -> merged into the first trend', async () =>
    (trends().filter((t) => t.status === 'active').length === before && trendOf('d1') === big().id && trendOf('d3') === big().id) || [trends().map((t) => [t.status, t.name]), trendOf('d1'), big().id]);

  log('\n── F4: a lonely signal finds another lonely signal ──');
  resetData();
  const v = (a, b) => { const x = new Array(384).fill(0); x[0] = a; x[1] = b; return x; };
  table('trend_clusters').push({ id: 'tr-active', module_id: FO, client_id: CLIENT, industry: 'Cosmetics', status: 'active', name: 'Big active trend' },
    { id: 'tr-lonely', module_id: FO, client_id: CLIENT, industry: 'Cosmetics', status: 'candidate' });
  const scope = { module_id: FO, client_id: CLIENT, industry: 'Cosmetics', type: 'signal' };
  for (let i = 0; i < 8; i++) {
    table('trend_signals').push({ id: `sa${i}`, signal_title: `Active signal ${i}` });
    table('trend_membership').push({ id: `ma${i}`, trend_id: 'tr-active', signal_id: `sa${i}` });
    coll('trend_matching').push({ id: `pa${i}`, vector: v(1, 0.05), payload: { ...scope, article_id: `sa${i}` } });   // 8 signals of the active trend, all closer
  }
  table('trend_signals').push({ id: 'sl', signal_title: 'The lonely signal' });
  table('trend_membership').push({ id: 'ml', trend_id: 'tr-lonely', signal_id: 'sl' });
  coll('trend_matching').push({ id: 'pl', vector: v(0.75, 0.66), payload: { ...scope, article_id: 'sl' } });
  const options = await tc.findTrendOptions(v(1, 0), FO, CLIENT, 'Cosmetics');
  await check('8 closer signals belong to an active trend: the lonely candidate is STILL found (before: only the 5 closest were looked at)', async () =>
    (options.length === 1 && options[0].trendId === 'tr-lonely' && options[0].status === 'candidate') || options);

  log('\n── F6: old data quick cleanup (scripts/cleanOutlookData.js) ──');
  resetData();
  const clean = require('./cleanOutlookData');
  const sig = (id, client, title, date, extra = {}) => table('trend_signals').push({ id, article_id: `art-${id}`, client_id: client, signal_title: title, organization: 'Unknown', sector: 'Consumer', source_published_date: date, ...extra });
  sig('k1', CLIENT, 'Lumo launches refill pouch', '2026-10-01'); sig('k2', CLIENT, 'Lumo Launches Refill Pouch', '2026-10-03');
  sig('k3', CLIENT, 'Fizz adds refill jars', '2026-10-04'); sig('k4', CLIENT, 'A signal in no trend', '2026-10-05');
  sig('k5', 'client-gone', 'Old news of a deleted client', '2026-10-01'); sig('k6', CLIENT, 'Only signal of its trend, a copy', '2026-10-06');
  sig('k7', CLIENT, 'Only signal of its trend, a copy', '2026-10-07');
  table('trend_clusters').push({ id: 'T1', client_id: CLIENT, status: 'active', name: '', sector: 'Unknown', centroid_point_id: 'c1' },
    { id: 'T2', client_id: 'client-gone', status: 'active', name: 'Dead client trend', sector: 'Product' },
    { id: 'T3', client_id: CLIENT, status: 'candidate' }, { id: 'T4', client_id: CLIENT, status: 'candidate' });
  [['k1', 'T1'], ['k2', 'T1'], ['k3', 'T1'], ['k5', 'T2'], ['k6', 'T3'], ['k7', 'T4']].forEach(([s, t], i) => table('trend_membership').push({ id: `mm${i}`, trend_id: t, signal_id: s }));
  table('trend_snapshots').push({ id: 'sn1', trend_id: 'T2' });
  const plan = clean.buildPlan(table('trend_signals').map((x) => ({ ...x })), trends().map((x) => ({ ...x })), members().map((x) => ({ ...x })), new Map([[CLIENT, { id: CLIENT, company_name: 'Northwind Beauty' }]]));
  await check('to delete: the dead client signal, 2 same-title copies, the signal in no trend - nothing else', async () =>
    plan.remove.map((r) => r.row.id).sort().join() === 'k2,k4,k5,k7' || plan.remove.map((r) => [r.row.id, r.why]));
  await check('trends to delete: the dead client trend and the one left with no signal', async () => plan.deleteTrends.map((d) => d.trend.id).sort().join() === 'T2,T4' || plan.deleteTrends.map((d) => d.trend.id));
  await check('the active trend with no name and sector "Unknown" gets a real name and a real sector', async () =>
    (plan.fixTrends.length === 1 && plan.fixTrends[0].patch.name === 'Lumo launches refill pouch' && plan.fixTrends[0].patch.sector === 'Consumer') || plan.fixTrends);
  await check('the dry plan changed nothing', async () => signals().length === 7 && trends().length === 4);
  const done = await clean.applyPlan(plan, { db: fakeSupabase, qd: new FakeQdrant() });
  await check('apply: 3 signals left, each in a trend; 2 trends left; the dead trend history is gone; no errors', async () =>
    (signals().map((x) => x.id).sort().join() === 'k1,k3,k6' && signals().every((x) => members().some((m) => m.signal_id === x.id)) && trends().map((t) => t.id).sort().join() === 'T1,T3'
      && table('trend_snapshots').length === 0 && trends().find((t) => t.id === 'T1').name === 'Lumo launches refill pouch' && !done.errors.length) || [signals().map((x) => x.id), trends(), done]);

  log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
