/**
 * scripts/runPipelineLocal.js
 *
 * Runs one pipeline job with YOUR LOCAL code (the admin console's "Run now"
 * button always calls the VPS). It runs the same function the button starts
 * (runPipeline), with the sub-search's saved prompt from admin.prompts, right
 * here in this terminal - so a PAUSED sub-search can be tested too, nothing in
 * the admin console is changed, and the whole log is printed here.
 * At the end it prints the signals this run saved.
 *
 * Run (no server needed; it uses the same .env: Supabase, Qdrant, Redis, AI):
 *   node scripts/runPipelineLocal.js                     list the test client's Policy sub-searches
 *   node scripts/runPipelineLocal.js 1                   run sub-search number 1 of that list
 *   node scripts/runPipelineLocal.js 1 7                 ... looking back 7 days (default 7)
 *   node scripts/runPipelineLocal.js 1 7 market          ... for another module: policy | market | outlook
 *
 * Client: DR_TEST_CLIENT_ID from .env (the same test client as the other test scripts).
 */

require('dotenv').config();
const Module = require('module');
const { createClient } = require('@supabase/supabase-js');

// ── In-memory Redis for local runs ──────────────────────────────────────
// The .env REDIS_URL points to "redis", the Redis server's name INSIDE the VPS,
// which a laptop cannot reach. The pipeline only uses Redis as a short-lived
// queue for one run, so a local test run keeps it in memory instead.
// (Set LOCAL_REDIS=real in .env to use a real Redis, e.g. one running on this laptop.)
class MemoryRedis {
  constructor() { this.data = new Map(); }
  on() { return this; }
  async quit() {} disconnect() {}
  list(key) { if (!Array.isArray(this.data.get(key))) this.data.set(key, []); return this.data.get(key); }
  async get(key) { const v = this.data.get(key); return v === undefined ? null : v; }
  async set(key, value, ...opts) {
    if (opts.map(String).map((o) => o.toUpperCase()).includes('NX') && this.data.has(key)) return null;
    this.data.set(key, String(value));
    return 'OK';
  }
  async del(...keys) { let n = 0; for (const k of keys.flat()) if (this.data.delete(k)) n++; return n; }
  async expire() { return 1; }
  async rpush(key, ...values) { const l = this.list(key); l.push(...values.flat().map(String)); return l.length; }
  async llen(key) { return this.list(key).length; }
  async lpop(key) { const l = this.list(key); return l.length ? l.shift() : null; }
  async lrange(key, start, stop) {
    const l = this.list(key);
    const end = stop < 0 ? l.length + stop : stop;
    return l.slice(start < 0 ? Math.max(l.length + start, 0) : start, end + 1);
  }
  async lrem(key, count, value) {
    const l = this.list(key);
    let removed = 0;
    for (let i = 0; i < l.length && (count === 0 || removed < Math.abs(count)); ) {
      if (l[i] === String(value)) { l.splice(i, 1); removed++; } else i++;
    }
    return removed;
  }
  async rpoplpush(src, dst) {
    const l = this.list(src);
    if (!l.length) return null;
    const v = l.pop();
    this.list(dst).unshift(v);
    return v;
  }
}
if (String(process.env.LOCAL_REDIS || '').toLowerCase() !== 'real') {
  const realLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'ioredis') return MemoryRedis;
    return realLoad.call(this, request, ...rest);
  };
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const CLIENT_ID = process.env.DR_TEST_CLIENT_ID;
const MODULES = {
  policy: '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960',
  market: '55c5ee19-bfca-468b-81b3-b89ca4f303c8',
  outlook: '2eb989fd-0ea0-4320-b73a-f7eb8b970473',
};

async function main() {
  const pick = Number(process.argv[2]) || null;
  const lookbackDays = Number(process.argv[3]) || 7;
  const moduleKey = (process.argv[4] || 'policy').toLowerCase();
  const moduleId = MODULES[moduleKey];
  if (!CLIENT_ID) throw new Error('DR_TEST_CLIENT_ID is not set in .env');
  if (!moduleId) throw new Error(`module must be one of: ${Object.keys(MODULES).join(', ')}`);

  const { data: client, error: cErr } = await supabase.schema('admin').from('clients')
    .select('company_name, industry, status').eq('id', CLIENT_ID).maybeSingle();
  if (cErr || !client) throw new Error(`client ${CLIENT_ID} not found: ${cErr ? cErr.message : ''}`);

  const { data: rows, error } = await supabase.schema('admin').from('prompts')
    .select('submodule_id, prompt_text, source, status, is_active, schedule_time')
    .eq('client_id', CLIENT_ID).eq('module_id', moduleId).order('schedule_time');
  if (error) throw new Error(error.message);
  if (!rows || !rows.length) throw new Error(`no ${moduleKey} sub-searches for ${client.company_name}`);

  console.log(`${client.company_name} (${client.industry}) – ${moduleKey} sub-searches:`);
  rows.forEach((r, i) => console.log(`  ${i + 1}. ${r.submodule_id} · ${r.status || ''}${r.is_active === false ? ' (paused)' : ''} · source ${r.source || 'Exa'} · "${String(r.prompt_text || '').slice(0, 70)}…"`));
  if (!pick) {
    console.log('\nPick one: node scripts/runPipelineLocal.js <number> [days back]');
    return;
  }
  const row = rows[pick - 1];
  if (!row) throw new Error(`there is no number ${pick}`);

  const { runPipeline } = require('../modules/pipelineRunner');
  const jobId = `job_local_${Date.now()}`;
  const started = new Date().toISOString();
  console.log(`\nRunning sub-search ${pick} here with the LOCAL code (last ${lookbackDays} days), job ${jobId}...\n`);
  await runPipeline(jobId, CLIENT_ID, row.prompt_text, client.industry, moduleId, row.submodule_id, row.source || 'Exa', lookbackDays);

  // what this run saved
  const table = { policy: 'policy_signals', market: 'market_dynamics_signals', outlook: 'trend_signals' }[moduleKey];
  const cols = moduleKey === 'policy'
    ? 'signal_title, category, source_type, country, impact_level, impact_reason'
    : '*';
  const { data: saved } = await supabase.from(table).select(cols)
    .eq('client_id', CLIENT_ID).gte('created_at', started).order('created_at');
  console.log(`\n════ SAVED BY THIS RUN: ${(saved || []).length} signal(s) ════`);
  for (const r of saved || []) {
    if (moduleKey === 'policy') {
      console.log(`- ${r.signal_title}\n    ${r.category} · ${r.source_type} · ${r.country} · ${r.impact_level} (${r.impact_reason || 'no reason'})`);
    } else {
      console.log(`- ${JSON.stringify(r)}`);
    }
  }
  process.exit(0);   // Redis keeps the process open otherwise
}

main().catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
