/**
 * scripts/testPolicyPipeline.js
 *
 * DUMMY-DATA TEST for the Policy & Risk pipeline.
 * Runs the REAL pipeline code (modules/*.js) with fake news, a fake AI, and an
 * in-memory Supabase / Qdrant / Redis. Nothing real is read or written: no
 * database, no Qdrant, no AI calls, no search credits.
 *
 * Run:   node scripts/testPolicyPipeline.js
 *        DR_TEST_REAL_EMBEDDINGS=off node scripts/testPolicyPipeline.js   (fake meaning-model, faster)
 *
 * What it proves (one line per problem found in the Policy audit):
 *   P1  the same news from 2 or 3 sub-searches is saved ONCE (at the same time, and minutes apart)
 *   P2  the link check sees ALL old links, not only the first 1,000
 *   P3  the AI writing "false" as text is NOT saved
 *   P4  a short copy can no longer push out the full copy
 *   P5  a failed save leaves nothing half-saved, and the article is tried again later
 *   P6  only allowed categories / source types, M&A rejected, countries written one way
 *   P7  dates like 25/10/2026 are read; news with no date is rejected
 *   P8  "**Title:" is cleaned from rewritten titles
 *   P9  two DIFFERENT stories that sound alike are both kept (measures the similarity)
 *   +   impact (Critical / High / Medium / Low) decided from the client profile, with the reason
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
    eq(c, v) { st.filters.push((r) => r[c] === v); return q; },
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
  if (c.match) return v === c.match.value;
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
async function fakeCallLLM(messages) {
  const prompt = messages.map((m) => m.content).join('\n');
  promptsSeen.push(prompt);
  await new Promise((r) => setTimeout(r, 5));
  const item = [...aiScript.entries()].find(([marker]) => prompt.includes(marker));
  const s = item ? item[1] : {};
  if (prompt.includes('You check which industry')) {
    return JSON.stringify({ about_industry: s.gate !== false, main_industry: s.gate === false ? 'Banking' : 'Cosmetics', reason: 'test' });
  }
  if (prompt.includes('First line must be: Title:')) {
    return `${s.synthFormat || 'Title: '}${s.synthTitle || 'A rewritten title for the test'}${s.synthFormat ? '**' : ''}\n\n${'This is the rewritten body of the article in new words. '.repeat(12)}`;
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
const { removeUrlDuplicates, normalizeUrl } = require(path.join(MODULES, 'deduplicator.js'));
const topic = require(path.join(MODULES, 'topicDedup.js'));
const { removeSameTopicArticles } = topic;
const { filterLowQualityArticles } = require(path.join(MODULES, 'qualityFilter.js'));
const places = require(path.join(MODULES, 'placeNames.js'));

// ═════════════════════════════════════════════════════════════════════════
// Test setup: one fake client (nothing about a real client is fixed in the code)
// ═════════════════════════════════════════════════════════════════════════
const CLIENT = 'client-test-1';
const POLICY = proc.POLICY_MODULE_ID;
const SUB_A = 'sub-a';
const SUB_B = 'sub-b';
const SUB_C = 'sub-c';

function resetData() {
  for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(qd)) delete qd[k];
  aiScript.clear();
  promptsSeen.length = 0;
  table('admin.clients').push({ id: CLIENT, company_name: 'Northwind Beauty', industry: 'Cosmetics' });
  table('admin.client_icp').push({ client_id: CLIENT, context_json: {
    competitors: ['Glowly', 'Unknown'], core_sectors: ['Prestige Beauty'],
    focus_products_services: ['Prestige skincare', 'Colour cosmetics'],
    geographic_focus: ['SG', 'UK'], sectors_to_avoid: ['Fragrance', "Men's grooming"],
  } });
  table('admin.competitors').push({ id: 'k1', client_id: CLIENT, name: 'Lumina Labs', search_name: 'Lumina Labs', aliases: ['Lumina'], is_active: true });
  table('prompts').push(
    { id: 'policy_risk_relevance_v1', is_active: true, prompt_template: 'Policy and Risk Monitor for {industry}. Title: {title}\nText: {text}\nCLIENT PROFILE:\n{client_context}' },
    { id: 'article_synthesis_v1', is_active: true, prompt_template: 'First line must be: Title: ...\nArticle Title: {title}\n{text}' },
    { id: 'industry_gate_v1', is_active: true, prompt_template: 'You check which industry. INDUSTRY: {industry}\nARTICLE TITLE: {title}\n{text}' },
  );
}

// each fake article's text is about its own topic only (no shared filler), so different news looks different
const longText = (topic) => `${topic}. `.repeat(Math.ceil(320 / (topic.length + 2)));
const art = (marker, title, extra = {}) => ({
  title: `${title} [${marker}]`, url: `https://news.example.com/${marker}`, publishedDate: '2026-11-10T08:00:00Z', text: longText(title), ...extra,
});
const relevant = (over = {}) => ({
  is_relevant: true, reason: 'test', signal_title: 'Test signal', category: 'Regulation & Guidance', source_type: 'News Report',
  country: 'United Kingdom', competitors_named: [], focus_matches: [], avoid_matches: [], summary: 'A summary of the rule.', business_impact: ['a', 'b', 'c'], ...over,
});
const run = (articles, sub, jobId) => proc.processArticlesForRelevance(articles, CLIENT, 'Cosmetics', jobId || `job-${sub}`, POLICY, sub);
const signals = () => table('policy_signals');
const textPieces = () => coll('policy_articles').length;

// ── tiny test runner ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const log = (...a) => console.log(...a);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true) { passed++; log(`  PASS  ${name}`); } else { failed++; log(`  FAIL  ${name}\n        got: ${JSON.stringify(r)}`); }
  } catch (e) { failed++; log(`  FAIL  ${name}\n        crashed: ${e.stack || e.message}`); }
}

// ═════════════════════════════════════════════════════════════════════════
async function main() {
  log(`Policy pipeline dummy-data test (${REAL_EMBEDDINGS ? 'real meaning model' : 'fake meaning model'})\n`);

  log('── P3: the AI answer "false" written as text ──');
  await check('isYes: "false" text is NO', async () => proc.isYes('false') === false && proc.isYes(false) === false && proc.isYes(' FALSE ') === false);
  await check('isYes: true and "true" are YES', async () => proc.isYes(true) === true && proc.isYes('true') === true);
  await check('isYes: empty / missing is NO', async () => proc.isYes(undefined) === false && proc.isYes('') === false && proc.isYes(null) === false);

  log('\n── P8: clean rewritten titles ──');
  const titles = [['**Title:** Saudi Arabia Tightens Rules', 'Saudi Arabia Tightens Rules'], ['**Title: EU Bans X**', 'EU Bans X'],
    ['## Title: New Labelling Rule', 'New Labelling Rule'], ['1. **Title: "FDA warns firm"**', 'FDA warns firm'], ['3M fined over PFAS', '3M fined over PFAS'], ['Title:', null]];
  for (const [input, want] of titles) await check(`cleanTitle ${JSON.stringify(input)}`, async () => proc.cleanTitle(input) === want || proc.cleanTitle(input));

  log('\n── P6: categories, source types, countries ──');
  const rule = (c) => proc.applyPolicyRules({ is_relevant: true, category: c.category, source_type: c.source, country: c.country });
  await check('allowed category kept', async () => rule({ category: 'Product Safety & Standards' }).category === 'Product Safety & Standards');
  await check('old "Regulatory Risk" -> Regulation & Guidance', async () => rule({ category: 'Regulatory Risk' }).category === 'Regulation & Guidance');
  await check('invented "Regulatory Requirement" -> Compliance & Reporting', async () => rule({ category: 'Regulatory Requirement' }).category === 'Compliance & Reporting');
  await check('"AML & KYC Compliance" -> Compliance & Reporting', async () => rule({ category: 'AML & KYC Compliance' }).category === 'Compliance & Reporting');
  await check('"Mergers and Acquisitions" -> NOT relevant', async () => rule({ category: 'Mergers and Acquisitions' }).is_relevant === false);
  await check('unknown category -> Regulation & Guidance', async () => rule({ category: 'Something Odd' }).category === 'Regulation & Guidance');
  await check('every new category is in the allowed list', async () => proc.POLICY_CATEGORIES.length === 15);
  await check('source "Regulatory Update" -> Government Announcement', async () => rule({ source: 'Regulatory Update' }).source_type === 'Government Announcement');
  await check('unknown source -> News Report', async () => rule({ source: 'Blog' }).source_type === 'News Report');
  await check('country "USA" -> United States', async () => rule({ country: 'USA' }).country === 'United States');
  await check('country "UAE, KSA" -> United Arab Emirates, Saudi Arabia', async () => rule({ country: 'UAE, KSA' }).country === 'United Arab Emirates, Saudi Arabia');
  await check('country empty -> Unknown', async () => rule({ country: '' }).country === 'Unknown');
  await check('places: England = United Kingdom, Korea = South Korea, EU = European Union', async () =>
    places.standardPlace('England') === 'United Kingdom' && places.standardPlace('Korea') === 'South Korea' && places.standardPlace('EU') === 'European Union');
  await check('places: client codes SG, UK read as countries', async () => places.standardPlaces(['SG', 'UK']).join() === 'Singapore,United Kingdom');
  await check('places: EU covers France, GCC covers UAE, Global covers nothing', async () =>
    places.placeCovers('European Union', 'FR') && places.placeCovers('GCC', 'AE') && !places.placeCovers('Global', 'UK'));

  log('\n── Impact from the client profile ──');
  resetData();
  const profile = await proc.getClientProfile(CLIENT);
  await check('profile: competitors from both lists, "Unknown" ignored', async () =>
    profile.competitors.map((c) => c.name).sort().join() === 'Glowly,Lumina Labs' || profile.competitors);
  await check('profile: countries SG, UK -> Singapore, United Kingdom', async () => profile.places.join() === 'Singapore,United Kingdom' || profile.places);
  await check('profile text for the prompt has competitors and focus', async () => {
    const t = proc.profileForPrompt(profile);
    return (t.includes('Lumina Labs') && t.includes('Prestige skincare') && t.includes('Singapore')) || t;
  });
  const impact = (articleText, cls) => proc.decideImpact({ signal_title: '', summary: '', country: 'Unknown', focus_matches: [], avoid_matches: [], ...cls },
    { title: articleText, text: '' }, profile);
  await check('competitor + focus -> Critical', async () => impact('Lumina Labs fined over skincare claims', { focus_matches: ['Prestige skincare'] }).impact_level === 'Critical');
  await check('competitor + country -> Critical', async () => impact('Lumina fined', { country: 'United Kingdom' }).impact_level === 'Critical');
  await check('competitor only -> High', async () => impact('Glowly fined in Brazil', { country: 'Brazil' }).impact_level === 'High');
  await check('client itself named -> High', async () => impact('Northwind Beauty receives warning', {}).impact_level === 'High');
  await check('focus + country -> High', async () => impact('New skincare rule', { focus_matches: ['Prestige skincare'], country: 'Singapore' }).impact_level === 'High');
  await check('focus only -> Medium', async () => impact('New rule for colour cosmetics', { focus_matches: ['Colour cosmetics'], country: 'Brazil' }).impact_level === 'Medium');
  await check('country only (region covering it) -> Medium', async () => impact('ASEAN rule', { country: 'ASEAN' }).impact_level === 'Medium');
  await check('nothing matches -> Low', async () => impact('Brazil hair dye rule', { country: 'Brazil' }).impact_level === 'Low');
  await check('AI focus pick NOT on the client list is ignored -> Low', async () => impact('Rule', { focus_matches: ['Shampoo'], country: 'Brazil' }).impact_level === 'Low');
  await check('lower-priority sector -> Low', async () => impact('Fragrance labelling rule', { focus_matches: ['Colour cosmetics'], country: 'Singapore' }).impact_level === 'Low');
  await check('lower-priority sector but a competitor is named -> not lowered', async () => impact('Glowly fragrance ban', { country: 'Singapore' }).impact_level === 'Critical');
  await check('impact has a reason', async () => /names Lumina Labs; about Prestige skincare/.test(impact('Lumina Labs skincare', { focus_matches: ['Prestige skincare'] }).impact_reason));
  await check('competitor name with accents / no accents still found', async () => impact('LUMINA LABS warned', {}).impact_level === 'High');

  log('\n── P7: dates ──');
  resetData();
  {
    const dated = art('dates', 'The ministry published a new rule for cosmetic labels');
    await check('dated, long, English -> kept', async () => (await filterLowQualityArticles([dated])).length === 1);
    await check('the SAME article with no date -> rejected', async () => (await filterLowQualityArticles([{ ...dated, publishedDate: null }])).length === 0);
  }
  {
    const fetcherSrc = require('fs').readFileSync(path.join(MODULES, 'fetcher.js'), 'utf8');
    const read = new Function(`${fetcherSrc.match(/const disambiguateSlashDate[\s\S]*?\n};/)[0]}; return disambiguateSlashDate;`)();
    const day = (x) => { const d = new Date(read(x)); return isNaN(d) ? 'not a date' : d.toISOString().slice(0, 10); };
    await check('25/10/2026 (day first) -> 2026-10-25', async () => day('25/10/2026') === '2026-10-25' || day('25/10/2026'));
    await check('10/25/2026 (month first) -> 2026-10-25', async () => day('10/25/2026') === '2026-10-25' || day('10/25/2026'));
    await check('2026-10-25T08:00:00Z unchanged', async () => day('2026-10-25T08:00:00Z') === '2026-10-25');
  }

  log('\n── P2: the link check reads ALL old links ──');
  resetData();
  for (let i = 0; i < 1500; i++) table('processed_urls').push({ client_id: CLIENT, module_id: POLICY, source_url: `https://news.example.com/old-${i}`, created_at: new Date(Date.now() - 86400000 + i).toISOString() });
  await check('link number 1,400 (beyond the first 1,000) is found as already seen', async () =>
    (await removeUrlDuplicates([{ url: 'https://www.news.example.com/old-1400?utm_source=x', title: 't' }], CLIENT, POLICY)).length === 0);
  await check('a new link passes', async () => (await removeUrlDuplicates([{ url: 'https://news.example.com/brand-new', title: 't' }], CLIENT, POLICY)).length === 1);

  log('\n── P4: quality check before the same-topic check ──');
  resetData();
  {
    const shortCopy = { title: 'Singapore bans ingredient X in skincare', url: 'https://a.example.com/1', publishedDate: '2026-11-10T08:00:00Z', text: 'Singapore bans ingredient X in skincare products.' };
    const fullCopy = { title: 'Singapore bans ingredient X in skincare', url: 'https://b.example.com/2', publishedDate: '2026-11-10T08:00:00Z', text: longText('Singapore bans ingredient X in skincare products') };
    const good = await filterLowQualityArticles([shortCopy, fullCopy]);
    const kept = await removeSameTopicArticles(good, CLIENT, POLICY);
    await check('the FULL copy survives (the short one is removed first)', async () => (kept.length === 1 && kept[0].url === fullCopy.url) || kept.map((k) => k.url));
    const runner = require('fs').readFileSync(path.join(MODULES, 'pipelineRunner.js'), 'utf8');
    await check('pipelineRunner.js runs the quality check BEFORE the same-topic check', async () =>
      runner.indexOf('await filterLowQualityArticles(') < runner.indexOf('await removeSameTopicArticles(') || 'topic check runs first');
  }

  log('\n── P3 + P6 + impact through the real article flow ──');
  resetData();
  aiScript.set('[t-false]', { answer: '{"is_relevant": "false", "reason": "not policy"}' });
  aiScript.set('[t-ok]', { answer: relevant({ signal_title: 'UK limits ingredient in prestige skincare', category: 'Regulatory Requirement', source_type: 'Regulatory Update', country: 'UK', focus_matches: ['Prestige skincare'] }), synthTitle: 'UK Limits Ingredient Use in Prestige Skincare', synthFormat: '**Title: ' });
  aiScript.set('[t-ma]', { answer: relevant({ category: 'Mergers and Acquisitions' }) });
  aiScript.set('[t-gate]', { gate: false, answer: relevant() });
  await run([art('t-false', 'Report on beauty trends'), art('t-ok', 'UK limits ingredient in skincare'), art('t-ma', 'Brand buys rival'), art('t-gate', 'Bank rule')], SUB_A);
  const saved = signals();
  await check('"false" as text -> NOT saved', async () => !saved.some((s) => /t-false/.test(s.source_article_url || '')) || saved.map((s) => s.source_article_url));
  await check('M&A -> NOT saved', async () => !saved.some((s) => s.category === 'Mergers and Acquisitions'));
  await check('not the client industry -> NOT saved', async () => !saved.some((s) => /t-gate/.test(s.source_article_url || '')) || saved.map((s) => s.source_article_url));
  await check('the one good article IS saved', async () => saved.length === 1 || saved.map((s) => s.source_article_url));
  const s1 = saved[0] || {};
  await check('saved with an allowed category (Regulatory Requirement -> Compliance & Reporting)', async () => s1.category === 'Compliance & Reporting' || s1.category);
  await check('saved with an allowed source type', async () => s1.source_type === 'Government Announcement' || s1.source_type);
  await check('country saved as "United Kingdom" (AI said UK)', async () => s1.country === 'United Kingdom' || s1.country);
  await check('impact decided by code: focus + client country -> High, with reason', async () =>
    (s1.impact_level === 'High' && /Prestige skincare/.test(s1.impact_reason) && /United Kingdom/.test(s1.impact_reason)) || [s1.impact_level, s1.impact_reason]);
  await check('the client profile was put in the AI prompt', async () => promptsSeen.some((p) => p.includes('Policy and Risk Monitor') && p.includes('Lumina Labs') && p.includes('Prestige skincare')));
  await check('P8: saved rewritten title has no "**Title:"', async () => {
    const full = table('policy_articles_full')[0] || {};
    return full.title === 'UK Limits Ingredient Use in Prestige Skincare' || full.title;
  });
  await check('text saved in Qdrant for the saved signal', async () => coll('policy_articles').every((p) => p.payload.article_id === s1.article_id) && textPieces() > 0);
  await check('the 3 rejected articles are logged as skipped and their links remembered', async () =>
    table('article_processing_log').filter((r) => r.status === 'skipped').length === 3 && table('processed_urls').length === 4);

  log('\n── P1: the same news from 3 sub-searches ──');
  resetData();
  for (const m of ['dup-a', 'dup-b', 'dup-c']) {
    aiScript.set(`[${m}]`, { answer: relevant({ signal_title: 'Singapore bans ingredient X' }), synthTitle: 'Singapore Bans Ingredient X in Cosmetics' });
  }
  // same link, all three sub-searches at the same moment
  const same = (m) => ({ ...art(m, 'Singapore bans ingredient X in cosmetics'), url: 'https://news.example.com/sg-ban', title: 'Singapore bans ingredient X in cosmetics [dup-a]' });
  await Promise.all([run([same('dup-a')], SUB_A), run([same('dup-a')], SUB_B), run([same('dup-a')], SUB_C)]);
  await check('same link, 3 sub-searches AT THE SAME TIME -> saved once', async () => signals().length === 1 || signals().length);
  await check('the AI read that news only ONCE (the lock stopped the other 2 before the AI)', async () => {
    const reads = promptsSeen.filter((p) => p.includes('Policy and Risk Monitor') && p.includes('[dup-a]')).length;
    return reads === 1 || `${reads} AI reads`;
  });
  await check('the 2 extra copies are logged as duplicates', async () =>
    table('article_processing_log').filter((r) => r.status === 'skipped' && /Duplicate/i.test(r.error_message || r.reason || JSON.stringify(r))).length === 2);
  // different links (syndicated copies), minutes apart
  resetData();
  for (const m of ['syn-a', 'syn-b', 'syn-c']) {
    aiScript.set(`[${m}]`, { answer: relevant({ signal_title: 'Malaysia tightens cosmetic notification rules' }), synthTitle: 'Malaysia Tightens Cosmetic Notification Rules' });
  }
  await run([{ ...art('syn-a', 'Malaysia tightens cosmetic notification rules'), url: 'https://site-one.example.com/my-rule' }], SUB_A);
  await run([{ ...art('syn-b', 'Malaysia tightens cosmetic notification rules for brands'), url: 'https://site-two.example.com/news/123' }], SUB_B);
  await run([{ ...art('syn-c', 'Cosmetic notification rules tightened in Malaysia'), url: 'https://site-three.example.com/a/b' }], SUB_C);
  await check('3 copies on 3 different sites, 3 sub-searches, minutes apart -> saved once', async () => signals().length === 1 || signals().map((s) => s.signal_title));
  await check('only one article\'s text in Qdrant', async () => new Set(coll('policy_articles').map((p) => p.payload.article_id)).size === 1);
  await check('the copies were stopped BEFORE the AI read them (only 1 full AI read)', async () => {
    const reads = promptsSeen.filter((p) => p.includes('Policy and Risk Monitor') && /\[syn-/.test(p)).length;
    return reads === 1 || `${reads} AI reads`;
  });

  log('\n── P9: two DIFFERENT stories that sound alike ──');
  resetData();
  aiScript.set('[sim-a]', { answer: relevant({ signal_title: 'FDA warns Glowly over sunscreen labels' }), synthTitle: 'FDA Warns Glowly Over Sunscreen Labelling' });
  aiScript.set('[sim-b]', { answer: relevant({ signal_title: 'FDA warns Lumina over preservative safety' }), synthTitle: 'FDA Warns Lumina Over Preservative Safety Data' });
  const simA = { ...art('sim-a', 'FDA sends warning letter to Glowly over sunscreen labels'), text: longText('The FDA sent a warning letter to Glowly about missing sunscreen label information and SPF claims') };
  const simB = { ...art('sim-b', 'FDA sends warning letter to Lumina over preservative safety data'), text: longText('The FDA sent a warning letter to Lumina about preservative safety testing records at its factory') };
  {
    const { pipeline } = require('@xenova/transformers');
    const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    const vec = async (a) => Array.from((await embedder(`${a.title}. ${a.text.slice(0, 400)}`, { pooling: 'mean', normalize: true })).data);
    const score = cosine(await vec(simA), await vec(simB));
    log(`  INFO  similarity of the two different stories: ${score.toFixed(3)} (counted as the same news from 0.68)`);
  }
  const topicKept = await removeSameTopicArticles([simA, simB], CLIENT, POLICY);
  await check('the same-topic check keeps BOTH different stories', async () => topicKept.length === 2 || topicKept.map((a) => a.title));
  await run(topicKept, SUB_A);
  await check('both different stories are saved', async () => signals().length === 2 || signals().map((s) => s.signal_title));

  log('\n── Real run (13 Nov): the AI copied the client\'s whole lists ──');
  resetData();
  {
    const prof = await proc.getClientProfile(CLIENT);
    const all = { focus_matches: [...prof.focus], avoid_matches: [...prof.avoid] };
    const imp = (title, text, cls) => proc.decideImpact({ signal_title: title, summary: '', country: 'Unknown', focus_matches: [], avoid_matches: [], ...cls }, { title, text }, prof);
    const china = imp('China NIDC Proposes STSC Updates on Cosmetic Ingredient Lists', 'The regulator proposed updates to the lists of cosmetic ingredients.', { ...all, country: 'China' });
    await check('whole lists copied by the AI are ignored -> not "lower-priority", not focus', async () =>
      (china.impact_level === 'Low' && !/lower-priority|about (Prestige|Specialty|Colour|Anti)/.test(china.impact_reason)) || china);
    const sun = imp('South Korea Updates Sunscreen Testing Rules', 'New in vitro testing for sunscreen products.', { ...all, country: 'South Korea' });
    await check('sunscreen rule in Korea: no fake "lower-priority" reason', async () => !/lower-priority/.test(sun.impact_reason) || sun);
    const uk = imp('UK limits a preservative', 'The rule covers skin care creams and serums sold in the UK.', { country: 'United Kingdom' });
    await check('"skin care" in the text = focus "Prestige skincare" (+ UK) -> High', async () =>
      (uk.impact_level === 'High' && /Prestige skincare/.test(uk.impact_reason)) || uk);
    const color = imp('New pigment limits', 'Limits for color cosmetics such as lipstick.', { country: 'Brazil' });
    await check('"color cosmetics" (US spelling) = focus "Colour cosmetics" -> Medium', async () =>
      (color.impact_level === 'Medium' && /Colour cosmetics/.test(color.impact_reason)) || color);
    const frag = imp('Fragrance allergen labelling rule in Singapore', 'Fragrance labels must list allergens.', { country: 'Singapore' });
    await check('"Fragrance" in the headline -> lower-priority -> Low', async () => (frag.impact_level === 'Low' && /Fragrance/.test(frag.impact_reason)) || frag);
    const fragBody = imp('Singapore labelling rule for cosmetics', 'It also mentions fragrance products once.', { country: 'Singapore' });
    await check('"fragrance" only in the body -> NOT lower-priority (Singapore -> Medium)', async () => fragBody.impact_level === 'Medium' || fragBody);
    const chose = imp('New rule on lip products', 'Rules for lip products.', { focus_matches: ['Colour cosmetics'], country: 'Brazil' });
    await check('the AI picked an item with NO word of it in the article -> ignored -> Low', async () => chose.impact_level === 'Low' || chose);
    const wide = imp('Indonesia issues new cosmetic notification rule', 'Brands must submit cosmetic notifications online.', { focus_matches: ['Prestige Beauty'], country: 'Indonesia' });
    await check('AI picked "Prestige Beauty" (only general words, phrase not written) -> ignored -> Low (real run 13 Nov)', async () => wide.impact_level === 'Low' || wide);
    const widePhrase = imp('Rule for prestige beauty brands', 'The rule covers prestige beauty brands.', { country: 'Brazil' });
    await check('"prestige beauty" written in the article -> counts -> Medium', async () => widePhrase.impact_level === 'Medium' || widePhrase);
    const half = imp('Serum rule', 'New limits for face serums and skincare.', { focus_matches: ['Prestige skincare'], country: 'Brazil' });
    await check('AI pick with its word ("skincare") in the article -> counts -> Medium', async () => half.impact_level === 'Medium' || half);
    const beauty = imp('Beauty market rule', 'A rule for the beauty market and cosmetic products.', { country: 'Brazil' });
    await check('general words only ("beauty", "cosmetic") -> not focus -> Low', async () => beauty.impact_level === 'Low' || beauty);
  }

  log('\n── Real run (13 Nov): different news from the same regulator ──');
  resetData();
  {
    const cand = (score, title) => ({ score, title });
    const me = { title: 'Indonesia Issues a New Regulation on the Procedure for Submitting Cosmetic Notifications', text: 'BPOM set a new procedure for cosmetic notifications.' };
    const before = promptsSeen.length;
    let r = await topic.findSameNews(me, [cand(0.95, 'Copy of the same story')], 'test', CLIENT);
    await check('score 0.95 -> same news', async () => Boolean(r) || r);
    r = await topic.findSameNews(me, [cand(0.60, 'Indonesia Issues a New Regulation on the Procedure for Submitting Cosmetic Notifications')], 'test', CLIENT);
    await check('score 0.60 -> different news', async () => r === null || r);
    r = await topic.findSameNews(me, [cand(0.797, 'Indonesia BPOM Releases Draft Regulation on Preclinical Study Approval Procedures Covering Cosmetics')], 'test', CLIENT);
    await check('score 0.797, different headline words -> KEPT (was dropped in the real run)', async () => r === null || r);
    r = await topic.findSameNews({ title: 'India BIS Amends the Fragrance Allergen Labeling Limits', text: 'x' }, [cand(0.887, 'India BIS Corrects Fragrance Allergen Labeling Thresholds under IS 4707 (Part 2): 2025')], 'test', CLIENT);
    await check('score 0.887, same headline words -> duplicate', async () => Boolean(r) || r);
    r = await topic.findSameNews({ title: 'New rule on X', text: 'x' }, [cand(0.80, 'New rule on Y')], 'test', CLIENT);
    await check('too few specific words to compare -> KEPT (when unsure, keep)', async () => r === null || r);
    await check('the same-news check made NO AI calls', async () => promptsSeen.length === before || `${promptsSeen.length - before} AI calls`);

    // the client's own industry word does not count as a match ("cosmetic" here)
    const h = topic.compareHeadlines('Cosmetic ingredient list updated', 'Cosmetic labelling rule updated', new Set(['cosmetics', 'cosmetic']));
    await check('the client\'s industry word is not counted as a shared word', async () => !h.shared.includes('cosmetic') || h);
    const n = topic.compareHeadlines('Regulator bans 11 dangerous creams', 'Regulator bans 25 dangerous creams', new Set());
    await check('different numbers (11 vs 25) -> different news', async () => (n.clash && !n.same) || n);
    const c = topic.compareHeadlines('Malaysia raids unlicensed cosmetic units', 'Indonesia raids unlicensed cosmetic units', new Set());
    await check('same words but different countries in the headlines -> different news', async () => (c.clash && !c.same) || c);
    const c2 = topic.compareHeadlines("Indonesia's BPOM revokes 11 cosmetic permits", 'BPOM revokes 11 cosmetic permits in Jakarta', new Set());
    await check('one headline names the country, the other does not -> can still be the same news', async () => c2.same || c2);
    // real run 13 Nov (30 days): a shared TOPIC is not the same news
    const ind2 = new Set(['cosmetics', 'cosmetic']);
    const t1 = topic.compareHeadlines('Indonesia Extends Halal Certification Deadline to October 2028: Key Takeaways for Business - Regulatory News - CIRS Group', 'Government Boosts Halal Ecosystem with SME Certification - RRI.co.id', ind2);
    await check('only "halal certification" shared (a topic, not an event) -> different news', async () => !t1.same || t1);
    const t2 = topic.compareHeadlines('Indonesia Regulatory Update: BPOM Cracks Down on Illegal Cosmetics Production Facility, with Seized Goods Worth Over Rp16 Billion', 'BPOM Uncovers Illegal Cosmetics Factory with Annual Turnover of Rp9 Billion - jawawa', ind2);
    await check('two raids, Rp16 billion vs Rp9 billion -> different news (numbers inside words)', async () => (t2.clash && !t2.same) || t2);
    // the AI's own signal titles (strict: action words count, 3+ shared words)
    const S = (a, b) => topic.compareHeadlines(a, b, ind2, { strict: true }).same;
    await check('signal titles: Delhi raids = Delhi crackdown on unlicensed manufacturing -> same', async () => S('Delhi Raids Unlicensed Cosmetic Manufacturing Units', 'Delhi Government Cracks Down on Unlicensed Cosmetic Manufacturing'));
    await check('signal titles: "Extends Halal Certification Deadline" = "Extends Halal Certification Transition Period" -> same', async () => S('Indonesia Extends Halal Certification Deadline for Cosmetics', 'Indonesia Extends Halal Certification Transition Period for Cosmetics'));
    await check('signal titles: two different illegal-production raids -> different', async () => !S('Indonesia Cracks Down on Illegal Cosmetics Production Facility', 'Indonesia Cracks Down on Illegal Cosmetics Production'));
    await check('signal titles: "Delays Halal Mandate" vs "Mandates Halal Certification" -> different', async () => !S('Indonesia Delays Halal Cosmetic Mandate to 2028', 'Indonesia Mandates Halal Certification for Cosmetics'));
    await check('signal titles: halal rules for sales services vs halal deadline extension -> different', async () => !S('Indonesia Mandates Halal Certification for Cosmetics Sales Services', 'Indonesia Extends Halal Certification Transition Period for Cosmetics'));
    const one = topic.compareHeadlines('Sunday Business Review: Regulatory Requirement - Global Cosmetics News', 'Global Cosmetics News \u2013 Weekly Review | Week 40, October 2026 - Hang Cosmetics', new Set(['cosmetics', 'cosmetic']));
    await check('only ONE shared word ("review") -> different news (real run 13 Nov)', async () => !one.same || one);
  }
  resetData();
  {
    // the 6 real pairs that were wrongly dropped, and 3 real copies, through the real same-topic check
    const different = [
      ['Indonesia Issues a New Regulation on the Procedure for Submitting Cosmetic Notifications', 'Indonesia BPOM Releases Draft Regulation on Preclinical Study Approval Procedures Covering Cosmetics'],
      ['China NIDC Released the Guidelines for the Use of Cosmetic Ingredient Data (Draft for Comments)', 'China NIDC Seeks Public Comments on Updated Information of 913 Existing Cosmetic Ingredients'],
      ['China NIDC Issued a Notice to Further Optimize Matters Related to Changes of Special Cosmetics', 'China NIDC Seeks Public Comments on Updated Information of 913 Existing Cosmetic Ingredients'],
      ["Indonesia's BPOM Reveals 11 Dangerous Cosmetics, Revokes Distribution Permits", 'BPOM Raided Illegal Cosmetic Under International Brand'],
      ["Indonesia's new halal certification rules take effect: transition period for selected cosmetics extended to 2028", 'Indonesia Confirms Mandatory Halal Certification Will Be Implemented as Scheduled from October 18, 2026'],
      ['South Korea Proposes to Revise the Guideline for the Management of Cosmetic Labeling and Advertising', 'South Korea Revises the Guidelines on Analysis Methods for Ingredients Prohibited in Cosmetics'],
    ];
    const copies = [
      ['India BIS Amends the Fragrance Allergen Labeling Limits', 'India BIS Corrects Fragrance Allergen Labeling Thresholds under IS 4707 (Part 2): 2025'],
      ['Medicube Capsule Cream Resumes Sales After Sudan IV Dye Concern Addressed by HSA', 'Medicube Cream Recall Update: HSA Lifts Suspension on Unaffected Batches'],
      ['China Updates the Safety and Technical Standards for Cosmetics (STSC): Adding 2 Testing Methods and Revising 5 Testing Methods', 'China Adds Seven Cosmetic Testing Methods to the Safety and Technical Standards for Cosmetics'],
    ];
    const mk = (title, i) => ({ title, url: `https://site${i}.example.com/${i}`, publishedDate: '2026-11-11T08:00:00Z', text: longText(title) });
    let i = 0;
    let lostDifferent = 0;
    let caughtCopies = 0;
    for (const [older, newer] of [...different, ...copies]) {
      resetData();
      await topic.commitTopicSeen(mk(newer, ++i), CLIENT, POLICY);   // saved by an earlier run
      const kept = await removeSameTopicArticles([mk(older, ++i)], CLIENT, POLICY);
      if (different.some(([a]) => a === older) && kept.length === 0) lostDifferent++;
      if (copies.some(([a]) => a === older) && kept.length === 0) caughtCopies++;
    }
    await check('none of the 6 DIFFERENT real stories is lost', async () => lostDifferent === 0 || `${lostDifferent} lost`);
    log(`  INFO  real copies caught here: ${caughtCopies} of ${copies.length} (the rest go on to the later save-time check)`);
    if (REAL_EMBEDDINGS) await check('at least 2 of the 3 real copies are caught with no AI', async () => caughtCopies >= 2 || `${caughtCopies} caught`);
  }

  log('\n── Real run (13 Nov): the same event under very different headlines ──');
  resetData();
  aiScript.set('[ev-a]', { answer: relevant({ signal_title: 'Delhi Government Cracks Down on Unlicensed Cosmetic Manufacturing', country: 'India', category: 'Enforcement & Penalties' }), synthTitle: 'Delhi Health Minister Cracks Down on Unlicensed Cosmetic Manufacturers' });
  aiScript.set('[ev-b]', { answer: relevant({ signal_title: 'Delhi Raids Unlicensed Cosmetic Manufacturing Units', country: 'India', category: 'Enforcement & Penalties' }), synthTitle: 'Enforcement Action Targets Unlicensed Cosmetic Manufacturing in Delhi' });
  aiScript.set('[ev-c]', { answer: relevant({ signal_title: 'Indonesia Cracks Down on Illegal Cosmetics Production', country: 'Indonesia', category: 'Enforcement & Penalties' }), synthTitle: 'Indonesian Regulatory Agency Uncovers Illicit Cosmetics Operation' });
  aiScript.set('[ev-d]', { answer: relevant({ signal_title: 'Indonesia Revokes Distribution Permits for 11 Hazardous Cosmetics', country: 'Indonesia', category: 'Enforcement & Penalties' }), synthTitle: 'Indonesian Regulatory Agency Cracks Down on Hazardous Cosmetics' });
  aiScript.set('[ev-e]', { answer: relevant({ signal_title: 'Malaysia Raids Unlicensed Cosmetic Manufacturing Units', country: 'Malaysia', category: 'Enforcement & Penalties' }), synthTitle: 'Malaysia Raids Unlicensed Cosmetic Makers' });
  await run([art('ev-a', '"Strict action will be taken against those manufacturing and selling cosmetic products illegally": Delhi Health Minister')], SUB_A);
  const rewritesBefore = promptsSeen.filter((p) => p.includes('First line must be: Title:')).length;
  await run([art('ev-b', 'Delhi Raids Crack Down on Unlicensed Cosmetic Manufacturing Units')], SUB_B);
  await check('same Delhi event, very different headlines -> saved ONCE', async () => signals().filter((x) => x.country === 'India').length === 1 || signals().map((x) => x.signal_title));
  await check('the copy cost no rewrite AI call', async () => promptsSeen.filter((p) => p.includes('First line must be: Title:')).length === rewritesBefore || 'rewrite was called');
  await check('the copy is logged as a duplicate and its link remembered', async () =>
    table('article_processing_log').some((r) => r.status === 'skipped' && /Duplicate/i.test(JSON.stringify(r))));
  await run([art('ev-c', 'BPOM Uncovers Illegal Cosmetics Factory with Annual Turnover of Rp9 Billion')], SUB_A);
  await run([art('ev-d', "Indonesia's BPOM Reveals 11 Dangerous Cosmetics, Revokes Distribution Permits")], SUB_A);
  await check('two DIFFERENT Indonesia enforcement stories (both "crack down") -> both saved', async () => signals().filter((x) => x.country === 'Indonesia').length === 2 || signals().map((x) => x.signal_title));
  await run([art('ev-e', 'Malaysia NPRA seizes unregistered cosmetics from home factories in Selangor')], SUB_A);
  await check('same words but ANOTHER country (Malaysia vs India) -> saved', async () => signals().some((x) => x.country === 'Malaysia') || signals().map((x) => x.signal_title));

  log('\n── Real run (13 Nov): Qdrant drops the connection once ──');
  resetData();
  {
    dropNextSearch = true;
    searchDrops = 0;
    let kept = null;
    try { kept = await removeSameTopicArticles([art('blip', 'Thailand FDA bans mercury in whitening creams')], CLIENT, POLICY); } catch (e) { kept = e; }
    await check('one dropped connection -> tried again, the run goes on', async () => (Array.isArray(kept) && kept.length === 1 && searchDrops === 1) || [String(kept), searchDrops]);
  }

  log('\n── Real run (13 Nov): how-to guides are not news ──');
  {
    const { checkNotGuide } = require(path.join(MODULES, 'qualityFilter.js'));
    const g = (t) => checkNotGuide({ title: t }).passed;
    await check('"How to open a beauty salon in the UK in 2026" -> rejected', async () => !g('How to open a beauty salon in the UK in 2026'));
    await check('"What is MoCRA?" and "5 tips for ..." -> rejected', async () => !g('What is MoCRA? A guide for brands') && !g('5 tips for passing a cosmetic audit'));
    await check('real news with "how" inside is kept ("FDA explains how brands must report...")', async () => g('FDA explains how brands must report adverse events') && g('Delhi Raids Unlicensed Cosmetic Units'));
  }

  log('\n── Old data cleanup (scripts/cleanPolicyData.js), dry plan ──');
  resetData();
  {
    const clean = require(path.join(__dirname, 'cleanPolicyData.js'));
    const clientById = new Map([[CLIENT, { id: CLIENT, company_name: 'Northwind Beauty', industry: 'Cosmetics' }]]);
    let n = 0;
    const row = (over) => ({ id: `r${++n}`, article_id: `a${n}`, client_id: CLIENT, summary: '', category: 'Regulatory Risk', source_type: 'News Report',
      country: 'United Kingdom', impact_level: 'High', impact_reason: null, is_duplicate: false,
      created_at: `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`, source_published_date: `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`, ...over });
    const rows = [
      row({ signal_title: 'UK bans microbeads in rinse-off cosmetics' }),                                   // kept
      row({ signal_title: 'UK bans microbeads in rinse-off cosmetics' }),                                   // same title -> delete
      row({ signal_title: 'Delhi Government Cracks Down on Unlicensed Cosmetic Manufacturing', country: 'India' }), // kept
      row({ signal_title: 'Delhi Raids Unlicensed Cosmetic Manufacturing Units', country: 'India, South Asia, Global' }), // near copy -> delete
      row({ signal_title: 'Brand X buys Brand Y', category: 'Mergers and Acquisitions' }),                  // not policy -> delete
      row({ signal_title: 'Old copy', is_duplicate: true }),                                                // marked before -> delete
      row({ signal_title: 'Rule for a dead client', client_id: 'gone-client' }),                            // dead client -> delete
      row({ signal_title: 'EU fines Glowly over sunscreen claims', country: 'European Union, EU, Global', category: 'Regulatory Enforcement', source_type: 'Regulatory Update' }),
      row({ signal_title: 'Thailand proposes draft rule on cosmetic notification fees', country: 'Thailand, Asia, Global' }),
    ];
    const plan = await clean.buildPlan(rows, clientById);
    const gone = (id) => plan.remove.some((r) => r.row.article_id === id);
    const upd = (id) => (plan.updates.find((u) => u.row.article_id === id) || {}).patch || {};
    await check('cleanup: first copy kept, same-title copy deleted', async () => (!gone('a1') && gone('a2')) || plan.remove.map((r) => r.why));
    await check('cleanup: same event under another title (same country) deleted', async () => (!gone('a3') && gone('a4')) || plan.remove.map((r) => r.why));
    await check('cleanup: M&A, old marked copy and dead client deleted', async () => (gone('a5') && gone('a6') && gone('a7')) || plan.remove.map((r) => r.why));
    await check('cleanup: exactly 5 rows to delete (nothing else)', async () => plan.remove.length === 5 || plan.remove.map((r) => r.why));
    await check('cleanup: "Regulatory Enforcement" -> "Enforcement & Penalties", "Regulatory Update" -> "Government Announcement"', async () =>
      (upd('a8').category === 'Enforcement & Penalties' && upd('a8').source_type === 'Government Announcement') || upd('a8'));
    await check('cleanup: competitor named -> impact recomputed, reason names the competitor', async () =>
      (['Critical', 'High'].includes(upd('a8').impact_level || 'High') && /Glowly/.test(upd('a8').impact_reason || '')) || upd('a8'));
    await check('cleanup: old vague "Regulatory Risk" + "proposes draft" title -> "Consultation & Proposal"', async () => upd('a9').category === 'Consultation & Proposal' || upd('a9'));
    await check('cleanup: country "Thailand, Asia, Global" -> "Thailand"', async () => upd('a9').country === 'Thailand' || upd('a9'));
    await check('cleanup: country "European Union, EU, Global" -> "European Union"', async () => upd('a8').country === 'European Union' || upd('a8'));
    await check('cleanup: country "United States, Oregon" -> "United States"; "Nigeria, United Kingdom" kept both', async () =>
      (clean.cleanCountry('United States, Oregon') === 'United States' && clean.cleanCountry('Nigeria, United Kingdom') === 'Nigeria, United Kingdom') || [clean.cleanCountry('United States, Oregon'), clean.cleanCountry('Nigeria, United Kingdom')]);
    await check('cleanup: the dry plan changed nothing in the database', async () => signals().length === 0);
  }

  log('\n── P5: a failed save leaves nothing half-saved ──');
  resetData();
  aiScript.set('[fail-save]', { answer: relevant({ signal_title: 'Rule that fails to save' }), synthTitle: 'Rule That Fails To Save' });
  failInsertInto = 'policy_signals';
  await run([art('fail-save', 'Rule that fails to save')], SUB_A);
  await check('no signal row', async () => signals().length === 0);
  await check('no text left in Qdrant', async () => textPieces() === 0 || textPieces());
  await check('no article rows left', async () => table('policy_articles_full').length === 0 && table('policy_articles_metadata').length === 0);
  await check('logged as FAILED (so it is retried)', async () => table('article_processing_log').some((r) => r.status === 'failed'));
  await check('link NOT remembered (so the next run tries it again)', async () => table('processed_urls').length === 0);
  // the next run works
  await run([art('fail-save', 'Rule that fails to save')], SUB_A);
  await check('next run saves it normally', async () => signals().length === 1 && textPieces() > 0);

  log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('TEST CRASHED:', e); process.exit(1); });
