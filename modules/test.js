 //test-marketInsights.js — run: node test-marketInsights.js
// Mocks Supabase, Qdrant, the embedder, and the LLM so Tier 1 / Tier 2
// clustering logic runs against controlled fake data. Verifies scenarios A-F.

const path = require('path');
const assert = require('assert');

const CLUSTER_MODULE_PATH = path.resolve(__dirname, 'marketInsights.js'); // <-- rename if needed

// ---------- deterministic fake embeddings (orthogonal per theme cluster) ----------
const EMBED_TAGS = {
  '(TAG:A)':  [1, 0, 0, 0, 0, 0, 0, 0, 0],
  '(TAG:B)':  [0, 1, 0, 0, 0, 0, 0, 0, 0],
  '(TAG:C1)': [0, 0, 1, 0, 0, 0, 0, 0, 0],
  '(TAG:C2)': [0, 0, 0.9, 0.1, 0, 0, 0, 0, 0],   // cosine vs C1 ≈ 0.994 → should merge
  '(TAG:D1)': [0, 0, 0, 0, 1, 0, 0, 0, 0],
  '(TAG:D2)': [0, 0, 0, 0, 0, 1, 0, 0, 0],       // cosine vs D1 = 0 → should NOT merge
  '(TAG:E)':  [0, 0, 0, 0, 0, 0, 1, 0, 0],
  '(TAG:F)':  [0, 0, 0, 0, 0, 0, 0, 1, 0],
  '(TAG:G)':  [0, 0, 0, 0, 0, 0, 0, 0, 1],       // new, orthogonal to everything else
};
const normalize = (v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};
const getFakeEmbedding = (text) => {
  const tag = Object.keys(EMBED_TAGS).find((t) => text.includes(t));
  return normalize(tag ? EMBED_TAGS[tag] : [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]);
};
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

// ---------- fake Supabase ----------
let nextId = 1;
const uuid = () => `id-${nextId++}`;
const store = { tables: {} };

class FakeQuery {
  constructor(table) { this.table = table; this.filters = []; this.op = 'select'; }
  select() { return this; }
  eq(col, val) { this.filters.push((row) => row[col] === val); return this; }
  not(col, _op, val) { this.filters.push((row) => (val === null ? row[col] != null : true)); return this; }
  in(col, vals) { this.filters.push((row) => vals.includes(row[col])); return this; }
  order(col, opts) { this._order = { col, asc: opts?.ascending !== false }; return this; }
  limit(n) { this._limit = n; return this; }
  single() { this._single = 'single'; return this; }
  maybeSingle() { this._single = 'maybe'; return this; }
  insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload) { this.op = 'update'; this.payload = payload; return this; }
  _rows() { return store.tables[this.table] || (store.tables[this.table] = []); }
  _run() {
    const table = this._rows();
    if (this.op === 'insert') {
      const row = { id: uuid(), ...(Array.isArray(this.payload) ? this.payload[0] : this.payload) };
      table.push(row);
      return { data: JSON.parse(JSON.stringify(row)), error: null };
    }
    if (this.op === 'update') {
      let updated = null;
      for (const row of table) if (this.filters.every((f) => f(row))) Object.assign(row, this.payload) && (updated = row);
      return { data: updated ? JSON.parse(JSON.stringify(updated)) : null, error: null };
    }
    let rows = table.filter((r) => this.filters.every((f) => f(r)));
    if (this._order) rows = rows.slice().sort((a, b) => (this._order.asc ? 1 : -1) * (a[this._order.col] > b[this._order.col] ? 1 : -1));
    if (this._limit) rows = rows.slice(0, this._limit);
    const copies = rows.map((r) => JSON.parse(JSON.stringify(r)));
    if (this._single === 'single') return copies.length ? { data: copies[0], error: null } : { data: null, error: { message: 'not found' } };
    if (this._single === 'maybe') return { data: copies[0] || null, error: null };
    return { data: copies, error: null };
  }
  then(resolve, reject) { try { resolve(this._run()); } catch (e) { reject ? reject(e) : Promise.reject(e); } }
}

const fakeSupabase = {
  from: (table) => new FakeQuery(table),
  schema: (name) => ({ from: (table) => new FakeQuery(`${name}.${table}`) }),
};

// ---------- fake Qdrant ----------
const fakeQdrant = {
  collections: {},
  async getCollections() { return { collections: Object.keys(this.collections).map((name) => ({ name })) }; },
  async createCollection(name) { this.collections[name] = { points: {} }; },
  async createPayloadIndex() { return {}; },
  async scroll(name, { filter }) {
    const coll = this.collections[name] || { points: {} };
    const ids = filter.must[0].match.any;
    const points = Object.values(coll.points).filter((p) => ids.includes(p.payload.article_id));
    return { points: points.map((p) => ({ vector: p.vector })) };
  },
  async upsert(name, { points }) {
    const coll = this.collections[name] || (this.collections[name] = { points: {} });
    for (const p of points) coll.points[p.id] = p;
  },
  async retrieve(name, { ids }) {
    const coll = this.collections[name] || { points: {} };
    return ids.map((id) => coll.points[id]).filter(Boolean);
  },
  async search(name, { vector, filter, limit }) {
    const coll = this.collections[name] || { points: {} };
    let candidates = Object.values(coll.points);
    for (const cond of filter.must) candidates = candidates.filter((p) => p.payload[cond.key] === cond.match.value);
    const scored = candidates.map((p) => ({ score: cosine(vector, p.vector), payload: p.payload }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  },
  async delete(name, { points }) {
    const coll = this.collections[name];
    if (coll) for (const id of points) delete coll.points[id];
  },
};

// ---------- fake LLM ----------
const fakeCallLLM = async (messages) => {
  const userMsg = messages.find((m) => m.role === 'user')?.content || '';
  const firstLine = userMsg.split('\n').find((l) => l.trim()) || 'Untitled';
  return JSON.stringify({
    title: firstLine.slice(0, 50),
    summary: 'Fake summary for test.',
    short_summary: 'Fake short summary.',
    business_impact: ['Fake impact.'],
    country: 'Global',
  });
};

// ---------- stub the real requires before loading the module under test ----------
function stubModule(request, exportsObj) {
  const resolved = require.resolve(request, { paths: [path.dirname(CLUSTER_MODULE_PATH)] });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
stubModule('@supabase/supabase-js', { createClient: () => fakeSupabase });
stubModule('@qdrant/js-client-rest', { QdrantClient: function () { return fakeQdrant; } });
stubModule('@xenova/transformers', {
  pipeline: async () => async (text) => ({ data: getFakeEmbedding(text) }),
});
stubModule('./llmClient', { callLLM: fakeCallLLM });

const { enrichOrCreateInsight } = require(CLUSTER_MODULE_PATH);

// ---------- seed reference data ----------
const CLIENT_ID = 'client-1';
const MODULE_ID = 'module-md';
const INDUSTRY = 'Fintech';
const SUB_FUNDING = 'sub-funding';
const SUB_INDUSTRY = 'sub-industry';

store.tables['admin.clients'] = [{ id: CLIENT_ID, industry: INDUSTRY }];
store.tables['admin.submodules'] = [
  { id: SUB_FUNDING, submodule_name: 'Funding Rounds Announced' },
  { id: SUB_INDUSTRY, submodule_name: 'Industry Structure' },
];
store.tables['prompts'] = [{
  id: 'market_dynamics_writeup_v1',
  is_active: true,
  prompt_template: 'Industry: {industry}\n{existing_card}\nNEW ARTICLE:\n{new_article}',
}];

// helper: ingest an article — seeds its vector into policy_articles, then clusters it
async function ingest(submoduleId, signalId, text, organization) {
  const articleId = uuid();
  await fakeQdrant.upsert('policy_articles', {
    points: [{ id: uuid(), vector: getFakeEmbedding(text), payload: { article_id: articleId } }],
  });
  const result = await enrichOrCreateInsight(CLIENT_ID, MODULE_ID, submoduleId, signalId, articleId, text, INDUSTRY, organization);

  store.tables['market_dynamics_signals'] = store.tables['market_dynamics_signals'] || [];
  store.tables['market_dynamics_signals'].push({
    id: uuid(),
    client_id: CLIENT_ID,
    module_id: MODULE_ID,
    submodule_id: submoduleId,
    organization,
    insight_id: result.insightId,
    published_date: new Date().toISOString(),
  });

  return result;
}

(async () => {
  // A — same org + same submodule → MUST merge
  const a1 = await ingest(SUB_FUNDING, 'sig-fund', 'Aditya Birla Group raises new funding round. (TAG:A)', 'Aditya Birla Group');
  const a2 = await ingest(SUB_FUNDING, 'sig-fund', 'Aditya Birla Group closes second funding round. (TAG:A)', 'Aditya Birla Group');
  assert.strictEqual(a1.status, 'created');
  assert.strictEqual(a2.status, 'enriched');
  assert.strictEqual(a2.insightId, a1.insightId);
  console.log('✅ A passed (same org, same submodule → merged)');

  // B — same org + different submodule → MUST NOT merge
  const b1 = await ingest(SUB_INDUSTRY, 'sig-ind', 'Aditya Birla Group restructures its industry position. (TAG:B)', 'Aditya Birla Group');
  assert.strictEqual(b1.status, 'created');
  assert.notStrictEqual(b1.insightId, a1.insightId);
  console.log('✅ B passed (same org, different submodule → separate cards)');

  // C — different org + same theme + same submodule → SHOULD merge
  const c1 = await ingest(SUB_INDUSTRY, 'sig-ma', 'Company X acquires SolarCo in major solar deal. (TAG:C1)', 'Company X');
  const c2 = await ingest(SUB_INDUSTRY, 'sig-ma', 'Company Y acquires WindCo in wind energy deal. (TAG:C2)', 'Company Y');
  assert.strictEqual(c1.status, 'created');
  assert.strictEqual(c2.status, 'enriched');
  assert.strictEqual(c2.insightId, c1.insightId);
  console.log('✅ C passed (different org, similar theme, cosine ≥0.55 → merged)');

  // D — different org + different theme + same submodule → MUST NOT merge
  const d1 = await ingest(SUB_INDUSTRY, 'sig-ma2', 'Company Z acquires SolarPro Inc. (TAG:D1)', 'Company Z');
  const d2 = await ingest(SUB_INDUSTRY, 'sig-exec', 'Company W appoints new Chief Technology Officer. (TAG:D2)', 'Company W');
  assert.strictEqual(d1.status, 'created');
  assert.strictEqual(d2.status, 'created');
  assert.notStrictEqual(d2.insightId, d1.insightId);
  console.log('✅ D passed (different org, different theme, cosine <0.55 → separate cards)');

  // E — brand new org, no neighbors → MUST create new card
  const e1 = await ingest(SUB_INDUSTRY, 'sig-misc', 'Brand New Co launches an innovative product line. (TAG:E)', 'Brand New Co');
  assert.strictEqual(e1.status, 'created');
  console.log('✅ E passed (new org, no neighbors → new card)');

  // F — same org, 3 articles in a row → one card, count=3
  const f1 = await ingest(SUB_FUNDING, 'sig-f', 'Momentum Corp announces expansion. (TAG:F)', 'Momentum Corp');
  const f2 = await ingest(SUB_FUNDING, 'sig-f', 'Momentum Corp expands further. (TAG:F)', 'Momentum Corp');
  const f3 = await ingest(SUB_FUNDING, 'sig-f', 'Momentum Corp expansion continues. (TAG:F)', 'Momentum Corp');
  assert.strictEqual(f1.status, 'created');
  assert.strictEqual(f2.status, 'enriched');
  assert.strictEqual(f3.status, 'enriched');
  assert.strictEqual(f2.insightId, f1.insightId);
  assert.strictEqual(f3.insightId, f1.insightId);
  const finalCard = store.tables['market_insights'].find((r) => r.id === f1.insightId);
  assert.strictEqual(finalCard.signal_count, 3);
  console.log('✅ F passed (3 articles, same org → 1 card, count=3)');

  // G — same org, same submodule, DIFFERENT signal_ids → MUST still merge (Tier 1)
  const g1 = await ingest(SUB_FUNDING, 'sig-a', 'Reliance Retail raises new funding round. (TAG:G)', 'Reliance Retail');
  const g2 = await ingest(SUB_FUNDING, 'sig-b', 'Reliance Retail closes second funding round. (TAG:G)', 'Reliance Retail');
  const g3 = await ingest(SUB_FUNDING, 'sig-c', 'Reliance Retail expansion continues. (TAG:G)', 'Reliance Retail');
  assert.strictEqual(g1.status, 'created');
  assert.strictEqual(g2.status, 'enriched');
  assert.strictEqual(g3.status, 'enriched');
  assert.strictEqual(g2.insightId, g1.insightId);
  assert.strictEqual(g3.insightId, g1.insightId);
  const gCard = store.tables['market_insights'].find((r) => r.id === g1.insightId);
  assert.strictEqual(gCard.signal_count, 3);
  console.log('✅ G passed (same org, same submodule, 3 different signal_ids → 1 card)');

  // H — different orgs, same submodule, same theme → all merge via Tier 2
  const h1 = await ingest(SUB_FUNDING, 'sig-h', 'Alpha Co raises Series A. (TAG:C1)', 'Alpha Co');
  const h2 = await ingest(SUB_FUNDING, 'sig-h', 'Beta Co raises Series B. (TAG:C2)', 'Beta Co');
  const h3 = await ingest(SUB_FUNDING, 'sig-h', 'Gamma Co raises Series C. (TAG:C2)', 'Gamma Co');
  assert.strictEqual(h1.status, 'created');
  assert.strictEqual(h2.status, 'enriched');
  assert.strictEqual(h3.status, 'enriched');
  assert.strictEqual(h2.insightId, h1.insightId);
  assert.strictEqual(h3.insightId, h1.insightId);
  console.log('✅ H passed (3 different orgs, same theme → 1 card via Tier 2)');

  console.log('\n🎉 ALL SCENARIOS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('❌ TEST FAILED:', err.message);
  process.exit(1);
});