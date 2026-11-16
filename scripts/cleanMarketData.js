/**
 * scripts/cleanMarketData.js
 *
 * ONE-TIME CLEANUP of the old Market Dynamics data (signals + cards), with the SAME rules the
 * pipeline uses now. Same design and flags as scripts/cleanPolicyData.js.
 *
 *   node scripts/cleanMarketData.js --skip-ai   DRY RUN with NO AI: counts everything + how many AI questions
 *                                                the real run needs (cost and time), changes nothing
 *   node scripts/cleanMarketData.js             DRY RUN with AI: asks the AI questions, writes the new card
 *                                                titles into the report, changes nothing (answers are saved)
 *   node scripts/cleanMarketData.js --apply     does the changes in the report (reuses the saved AI answers)
 *   --counts-only                                QUICK FINISH (a few minutes, no AI, no regrouping): every card's count
 *                                                = its real number of signals; cards with no signal are deleted
 *   --skip-industry                              no industry check (quicker, fewer AI questions)
 *   --light                                      SHORT RUN (about 30 minutes of AI): the AI only writes the cards with 2+
 *                                                signals. Same-title copies, dead clients and no-sub-category signals are
 *                                                deleted; cards are regrouped with the free rules only. Use the same flag
 *                                                for the dry run and for --apply.
 *
 * Signals (decided with Sneha, same as Policy):
 *   1. signals of deleted clients                                  -> deleted everywhere
 *      signals with NO sub-category (old data): the WORDS of the title pick the sub-category, only among the
 *      sub-categories of the signal's own dimension ("acquires" -> Mergers & acquisitions, "raises" -> Funding
 *      rounds ...). Free. No clear word -> deleted (16 Nov: the meaning model picked wrong too often, and the
 *      vague titles were mostly off-topic).
 *   2. copies: the same title again for the same client (first kept), and the same event
 *      (same client, same country or both "Global", published within 7 days, same words by the strict
 *      word rule, AND the AI confirms) - the same check the pipeline does now -> deleted everywhere
 *   3. not the client's industry (the pipeline's AI industry question; rows that name the
 *      industry or a focus area are not asked)                        -> deleted everywhere
 *   4. kept signals: country written one way
 *   "Deleted everywhere" = market_dynamics_signals + article rows + chat text in Qdrant + card link.
 *
 * Cards (the 16 Nov card check: wrong sub-category 24%, unrelated signals 48%, copies 38%):
 *   The kept signals are grouped again with the NEW card rule, replayed in date order:
 *     - only inside the same client + the same sub-category (a VC signal never sits on a Funding-rounds card)
 *     - a signal can join a group whose newest signal is at most 30 days older
 *     - meaning score to the group (title + summary, local model, free):
 *         below 0.45                  -> new card
 *         0.75 or more                -> joins (very close, no AI)
 *         in between                  -> the pipeline's AI question "which card, or none?"
 *     - below 0.55 the AI is not asked (new card)
 *   Each group keeps the old card that holds most of its signals (others get a new card).
 *   A card whose signals did not change is NOT rewritten (no AI). A changed card with ONE signal takes that
 *   signal's own title and summary (no AI). A changed card with 2+ signals gets a new title and summary
 *   from the AI (it sees ALL its signals). Importance is recomputed for every card (free).
 *   Old cards left with no signals are deleted.
 *
 * Saved AI answers (so --apply asks nothing again): scripts/logs/marketSameEventCheck.json,
 * marketIndustryCheck.json, marketCardFit.json, marketCardWriteups.json.
 * If an AI question fails: copies/industry -> the row is KEPT; card fit -> new card; write-up -> that
 * card is left as it was (run again later).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

// the pipeline modules load a Redis client; this script does not need Redis (same as cleanPolicyData.js)
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
const proc = require('../modules/llmRelevanceProcessor');
const md = require('../modules/marketInsights');
const { compareHeadlines } = require('../modules/topicDedup');
const { standardPlaces } = require('../modules/placeNames');
const { industryStep, aiSlot, obviouslyOnIndustry } = require('./cleanPolicyData');

const APPLY = process.argv.includes('--apply');
const SKIP_AI = process.argv.includes('--skip-ai');
// --light (16 Nov, to keep the run short): the AI only writes the cards that have 2+ signals (about 30 minutes).
// No same-event question (only same-title copies are deleted), no industry question, no card-fit question
// (only very close signals join a card; an unsure signal starts its own card).
const LIGHT = process.argv.includes('--light');
const SKIP_INDUSTRY = SKIP_AI || LIGHT || process.argv.includes('--skip-industry');
const LOG_DIR = path.join(__dirname, 'logs');
const CACHE = {
  same: path.join(LOG_DIR, 'marketSameEventCheck.json'),
  industry: path.join(LOG_DIR, 'marketIndustryCheck.json'),
  fit: path.join(LOG_DIR, 'marketCardFit.json'),
  writeup: path.join(LOG_DIR, 'marketCardWriteups.json'),
};
const MODULE_ID = proc.MARKET_DYNAMICS_MODULE_ID;
const NEAR_COPY_DAYS = 7;                                              // same as the live same-event check
const FIT_DAYS = Number(process.env.MD_CARD_FIT_DAYS) || 30;           // same as the live card rule
const FIT_MIN = Number(process.env.MD_CARD_FIT_MIN_SCORE) || 0.45;     // same as the live card rule
const JOIN_SCORE = Number(process.env.CLEAN_MD_JOIN_SCORE) || 0.75;    // this close: joins without the AI
const ASK_MIN = Number(process.env.CLEAN_MD_ASK_MIN_SCORE) || 0.55;    // below this: new card, the AI is not asked (16 Nov: halves the AI questions)
// A card with ONE signal needs no AI: it takes the signal's own title and summary.
const singleCard = (m) => ({ title: m.signal_title, summary: m.summary || m.signal_title, short_summary: String(m.summary || m.signal_title).slice(0, 200), business_impact: [], country: m.country || 'Global' });
const APPLY_PARALLEL = Number(process.env.CLEAN_MD_APPLY_PARALLEL) || 6;   // cards written at the same time in --apply
const AI_SECONDS = (Number(process.env.CLEANUP_AI_GAP_MS) || 2100) / 1000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const reportLines = [];
const out = (line = '') => { reportLines.push(line); };
const say = (line = '') => { console.log(line); out(line); };

async function readAll(tableName, columns, filter, schema, orderCol = 'id') {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = (schema ? supabase.schema(schema) : supabase).from(tableName).select(columns).order(orderCol, { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${tableName}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; } };
const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); };

// ── small helpers ──────────────────────────────────────────────────────────
const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dateOf = (s) => String(s.published_date || s.created_at || '');
const dayOf = (s) => new Date(dateOf(s)).getTime() / 864e5;
const day10 = (s) => dateOf(s).slice(0, 10);
const placesOf = (country) => standardPlaces(country).filter((p) => p && p !== 'Unknown');
const standardCountry = (value) => standardPlaces(value).join(', ') || 'Global';
const dot = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); };
const memberKey = (articleIds) => crypto.createHash('sha1').update([...articleIds].sort().join('|')).digest('hex');
const bySignalDate = (a, b) => (dateOf(a) < dateOf(b) ? -1 : dateOf(a) > dateOf(b) ? 1 : String(a.id) < String(b.id) ? -1 : 1);

let embedder = null;
async function embedMany(texts) {
  if (!embedder) {
    const { pipeline } = require('@xenova/transformers');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  const vecs = [];
  for (let i = 0; i < texts.length; i++) {
    const o = await embedder(String(texts[i] || '').slice(0, 500), { pooling: 'mean', normalize: true });
    vecs.push(Array.from(o.data));
    if (texts.length >= 500 && i % 500 === 499) process.stdout.write(`\r  reading the meaning of signals: ${i + 1}/${texts.length}`);
  }
  if (texts.length >= 500) console.log('');
  return vecs;
}

// Sub-category from the title words (old signals with no sub-category). First rule whose sub-category is
// in the signal's own dimension wins. Names as in admin.signals (Market Dynamics).
const SUB_WORD_RULES = [
  ['Private equity investments', /private equity|\bPE[- ](firm|fund|backed)|buy-?out/i],
  ['Venture capital investments', /venture capital|\bVCs?\b|venture fund|seed (round|funding|stage)|series [a-f]\b/i],
  ['Funding rounds announced', /funding round|\braise[sd]?\b(?!\s+(\w+\s+)?(concerns?|questions?|doubts?|alarms?|eyebrows|fears?|issues?|hopes?|stakes|risks?|prices?|rates?))|secures? .{0,40}funding|closes? .{0,30}round|\bIPO\b/i],
  ['Debt and project financing', /\bdebt\b|\bloans?\b|\bbonds?\b(?!\s+(market|selloff|sell-off|yields?|prices?))|project financ|credit facility|refinanc|financing/i],
  ['Mergers & acquisitions', /acqui|merger|\bmerge|takeover|\bbuys?\b|\bbought\b|to buy|\bsells?\b|\bsold\b|divest|disposal|stake in|majority stake/i],
  ['Market consolidation', /consolidat/i],
  ['Partnerships & joint ventures', /partner|joint venture|\bJVs?\b|collaborat|alliance|teams? up|\bMoUs?\b|tie-?up/i],
  ['New industry entrants', /\benters?\b|\bentry\b|entrant|expands? into|debut/i],
];
function subCategoryFromTitle(title, submoduleId, subCats) {
  const mine = subCats.filter((c) => c.submodule_id === submoduleId);
  for (const [name, re] of SUB_WORD_RULES) {
    if (!re.test(title || '')) continue;
    const c = mine.find((x) => String(x.signal_name || '').trim().toLowerCase() === name.toLowerCase());
    if (c) return c;
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════
// PART 1: which signals go (dead clients, copies) - changes nothing
// confirmSame(a, b) -> { same, reason, failed? } (the pipeline's AI question), or null = no AI:
// then a near copy is only COUNTED (kept), exactly like the Policy cleanup.
// ═════════════════════════════════════════════════════════════════════════
async function planSignals(signals, clientById, { confirmSame = null, subCats = [] } = {}) {
  const remove = [];         // { row, why }
  const updates = [];        // { row, patch }  (signal country)
  const count = { dead: 0, noSub: 0, exact: 0, near: 0, nearNotSame: 0, nearAiFailed: 0, nearWouldAsk: 0, countryFixed: 0 };
  const nearSamples = []; const notSameSamples = []; const assigned = [];

  const byClient = new Map();
  for (const s of signals) {
    if (!byClient.has(s.client_id)) byClient.set(s.client_id, []);
    byClient.get(s.client_id).push(s);
  }
  await Promise.all([...byClient.entries()].map(async ([clientId, list]) => {
    const client = clientById.get(clientId);
    if (!client) { list.forEach((row) => remove.push({ row, why: 'client no longer exists' })); count.dead += list.length; return; }
    const industryWords = new Set(String(client.industry || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).flatMap((w) => [w, w.replace(/s$/, '')]));
    const keptByTitle = new Map();
    const keptByPlace = new Map();
    for (const row of [...list].sort(bySignalDate)) {           // oldest first: the first one is kept
      // old signal with no sub-category: the title words pick one of its dimension, or it goes
      let gaveSub = null;
      if (!row.signal_id) {
        const c = row.submodule_id ? subCategoryFromTitle(row.signal_title, row.submodule_id, subCats) : null;
        if (!c) { remove.push({ row, why: 'no sub-category (no clear word in the title)' }); count.noSub++; continue; }
        row.signal_id = c.id;
        gaveSub = c;
      }
      const t = normTitle(row.signal_title);
      if (t && keptByTitle.has(t)) { remove.push({ row, why: `same title as ${keptByTitle.get(t).article_id}` }); count.exact++; continue; }
      const places = placesOf(row.country);                     // Market Dynamics: "Global" counts as a place
      let near = null; let asked = 0;
      for (const p of places) {
        for (const k of keptByPlace.get(p) || []) {
          if (Math.abs(dayOf(k) - dayOf(row)) > NEAR_COPY_DAYS) continue;
          const h = compareHeadlines(row.signal_title, k.signal_title, industryWords, { strict: true });
          if (!h.same) continue;
          if (!confirmSame) { count.nearWouldAsk++; asked = 2; break; }   // no AI: counted, kept
          if (asked >= 2) break;
          asked++;
          const ai = await confirmSame(row, k);
          if (ai.same) { near = { k, h, ai }; break; }
          if (ai.failed) count.nearAiFailed++;
          else { count.nearNotSame++; notSameSamples.push(`  [${client.company_name}] ${day10(row)} "${row.signal_title}"\n      # ${day10(k)} "${k.signal_title}"   (AI: ${ai.reason})`); }
        }
        if (near || asked >= 2) break;
      }
      if (near) {
        remove.push({ row, why: `same event as ${near.k.article_id} (${near.h.shared.join(', ')}; AI: ${near.ai.reason})` });
        count.near++;
        nearSamples.push(`  [${client.company_name}] ${day10(row)} "${row.signal_title}"\n      = ${day10(near.k)} "${near.k.signal_title}"   (AI: ${near.ai.reason})`);
        continue;
      }
      if (t) keptByTitle.set(t, row);
      places.forEach((p) => { if (!keptByPlace.has(p)) keptByPlace.set(p, []); keptByPlace.get(p).push(row); });
      const country = standardCountry(row.country);
      const patch = {};
      if (country !== row.country) { patch.country = country; count.countryFixed++; }
      if (gaveSub) { patch.signal_id = gaveSub.id; assigned.push({ s: row, name: gaveSub.signal_name }); }
      if (Object.keys(patch).length) updates.push({ row, patch });
    }
  }));
  return { remove, updates, count, nearSamples, notSameSamples, assigned };
}

// ═════════════════════════════════════════════════════════════════════════
// PART 2: group the kept signals into cards with the new rule - changes nothing
// askFit(signal, groups) -> index of the group (0..n-1), -1 = none, or null = no AI / failed
// embed(texts) -> vectors
// ═════════════════════════════════════════════════════════════════════════
async function planCards(plan, signals, cards, clientById, { embed, askFit = null, dimName = new Map(), members = null }) {
  const gone = new Set(plan.remove.map((r) => r.row.id));
  const kept = signals.filter((s) => !gone.has(s.id) && clientById.has(s.client_id));
  const count = { autoJoin: 0, aiJoin: 0, aiNone: 0, fitWouldAsk: 0, fitFailed: 0, newNoClose: 0 };
  const samples = { autoJoin: [], aiJoin: [], aiNone: [] };
  const fitScores = [];

  const vecs = kept.length ? await embed(kept.map((s) => `${s.signal_title}. ${s.summary || ''}`)) : [];
  kept.forEach((s, i) => { s.vec = vecs[i]; });


  // group by client + sub-category; replay in date order
  const lanes = new Map();
  for (const s of kept) {
    const k = `${s.client_id}|${s.signal_id || `none:${s.id}`}`;        // no sub-category: its own lane
    if (!lanes.has(k)) lanes.set(k, []);
    lanes.get(k).push(s);
  }
  const groups = [];
  for (const list of lanes.values()) {
    const open = [];
    for (const s of list.sort(bySignalDate)) {
      const client = clientById.get(s.client_id);
      const candidates = s.signal_id ? open.filter((g) => dayOf(s) - g.lastDay <= FIT_DAYS) : [];
      const scored = candidates.map((g) => ({ g, score: dot(s.vec, unit(g.sum)) })).sort((a, b) => b.score - a.score);
      const top = scored.filter((x) => x.score >= FIT_MIN).slice(0, 3);
      let target = null;
      if (!top.length || top[0].score < ASK_MIN) count.newNoClose++;
      else if (top[0].score >= JOIN_SCORE) {
        target = top[0].g; count.autoJoin++;
        if (samples.autoJoin.length < 40) samples.autoJoin.push(`  [${client.company_name}] ${top[0].score.toFixed(2)} "${s.signal_title}"\n      joins: ${target.members.slice(-3).map((m) => `"${m.signal_title}"`).join('; ')}`);
      } else {
        fitScores.push(top[0].score);
        const pick = askFit ? await askFit(s, top.map((x) => x.g)) : null;
        if (pick === null || pick === undefined) { if (askFit) count.fitFailed++; else count.fitWouldAsk++; }
        else if (pick >= 0) {
          target = top[pick].g; count.aiJoin++;
          if (samples.aiJoin.length < 40) samples.aiJoin.push(`  [${client.company_name}] ${top[pick].score.toFixed(2)} "${s.signal_title}"\n      joins: ${target.members.slice(-3).map((m) => `"${m.signal_title}"`).join('; ')}`);
        } else {
          count.aiNone++;
          if (samples.aiNone.length < 40) samples.aiNone.push(`  [${client.company_name}] ${top[0].score.toFixed(2)} "${s.signal_title}"\n      not with: ${top[0].g.members.slice(-2).map((m) => `"${m.signal_title}"`).join('; ')}`);
        }
      }
      if (!target) {
        target = { client_id: s.client_id, signal_id: s.signal_id || null, submodule_id: s.submodule_id || null, members: [], sum: new Array(s.vec.length).fill(0), lastDay: dayOf(s) };
        open.push(target); groups.push(target);
      }
      target.members.push(s);
      s.vec.forEach((x, i) => { target.sum[i] += x; });
      target.lastDay = Math.max(target.lastDay, dayOf(s));
    }
  }

  // which old card each group keeps (the one holding most of its signals)
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const oldMembers = new Map();
  for (const s of signals) {
    if (!s.insight_id) continue;
    if (!oldMembers.has(s.insight_id)) oldMembers.set(s.insight_id, new Set());
    oldMembers.get(s.insight_id).add(s.id);
  }
  const claimed = new Set();
  for (const g of [...groups].sort((a, b) => b.members.length - a.members.length)) {
    const votes = new Map();
    g.members.forEach((m) => { if (m.insight_id && cardById.has(m.insight_id)) votes.set(m.insight_id, (votes.get(m.insight_id) || 0) + 1); });
    const best = [...votes.entries()].filter(([id]) => !claimed.has(id)).sort((a, b) => b[1] - a[1])[0];
    g.cardId = best ? best[0] : null;
    if (g.cardId) claimed.add(g.cardId);
    const old = g.cardId ? oldMembers.get(g.cardId) : null;
    g.sameSignals = !!old && old.size === g.members.length && g.members.every((m) => old.has(m.id));
    g.key = memberKey(g.members.map((m) => m.article_id));
    g.category = dimName.get(g.submodule_id) || null;
  }
  const deleteCards = cards.filter((c) => !claimed.has(c.id));
  // the second link table (market_insight_members) of a card whose signals did not change
  const linkedByCard = new Map();
  (members || []).forEach((m) => { if (!linkedByCard.has(m.insight_id)) linkedByCard.set(m.insight_id, new Set()); linkedByCard.get(m.insight_id).add(m.article_id); });
  for (const g of groups) {
    g.card = g.cardId ? cardById.get(g.cardId) : null;
    if (g.sameSignals && members) {
      const linked = linkedByCard.get(g.cardId) || new Set();
      g.membersTableOff = linked.size !== g.members.length || g.members.some((m) => !linked.has(m.article_id));
    }
  }

  plan.groups = groups;
  plan.deleteCards = deleteCards;
  plan.cardCount = count;
  plan.cardSamples = samples;
  plan.fitScores = fitScores;
  plan.keptSignals = kept.length;
  return plan;
}

// ═════════════════════════════════════════════════════════════════════════
// PART 3: do it (only with --apply)
// writeupFor(group) -> { title, summary, short_summary, business_impact, country } or null (failed)
// ═════════════════════════════════════════════════════════════════════════
// QUICK FINISH (--counts-only): no regrouping. Every card's count = its real number of signals, and cards
// left with no signal are deleted. Used when the long card step is skipped or stopped halfway.
async function fixCounts(db = supabase, { deleteEmpty = true } = {}) {
  const out = { countsFixed: 0, emptyDeleted: 0, cards: 0 };
  const cardsNow = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('market_insights').select('id, signal_count').eq('module_id', MODULE_ID).order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`market_insights: ${error.message}`);
    cardsNow.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const real = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('market_dynamics_signals').select('id, insight_id').eq('module_id', MODULE_ID).order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`market_dynamics_signals: ${error.message}`);
    (data || []).forEach((x) => { if (x.insight_id) real.set(x.insight_id, (real.get(x.insight_id) || 0) + 1); });
    if (!data || data.length < 1000) break;
  }
  out.cards = cardsNow.length;
  for (const c of cardsNow) {
    const n = real.get(c.id) || 0;
    if (!n && deleteEmpty) {
      try { await quietly(() => md.deleteInsightCentroid(c.id)); } catch (e) { /* no centroid */ }
      await db.from('market_insight_members').delete().eq('insight_id', c.id);
      await db.from('market_insights').delete().eq('id', c.id);
      out.emptyDeleted++;
    } else if (n && n !== c.signal_count) {
      await db.from('market_insights').update({ signal_count: n }).eq('id', c.id);
      out.countsFixed++;
    }
    if ((out.emptyDeleted + out.countsFixed) % 50 === 0) process.stdout.write(`\r  cards checked... fixed ${out.countsFixed}, empty deleted ${out.emptyDeleted}   `);
  }
  return out;
}

// the centroid helper prints one line per card: hidden here (thousands of cards)
const realLog = console.log;
let quietDepth = 0;
async function quietly(fn) {
  quietDepth++; console.log = (...a) => { if (!/^\s*\[Centroid\]/.test(String(a[0]))) realLog(...a); };
  try { return await fn(); } finally { quietDepth--; if (!quietDepth) console.log = realLog; }
}
async function applyPlan(plan, clientById, { writeupFor, db = supabase, progress = () => {} }) {
  const result = { deletedSignals: 0, rewritten: 0, created: 0, unchanged: 0, writeupFailed: 0, cardsDeleted: 0, cardsKeptWithSignals: 0, countsFixed: 0, errors: [] };
  const must = (r, what) => { if (r && r.error) throw new Error(`${what}: ${r.error.message}`); return r; };

  // 1. signals that go
  for (const { row } of plan.remove) {
    await db.from('market_insight_members').delete().eq('article_id', row.article_id);
    await proc.undoSave(row.article_id, 'market_dynamics_signals');
    result.deletedSignals++;
    progress('signals deleted', result.deletedSignals, plan.remove.length);
  }
  // 2. signal country
  for (const { row, patch } of plan.updates) await db.from('market_dynamics_signals').update(patch).eq('id', row.id);

  // 3. cards
  // CHANGED (16 Nov): several cards at a time (one by one took about 4 hours for 9,500 cards).
  // Each card only touches its own rows, so this is safe.
  let done = 0;
  const oneCard = async (g) => {
    try {
      const ids = g.members.map((m) => m.id);
      const articleIds = g.members.map((m) => m.article_id);
      const orgs = [...new Set(g.members.map((m) => m.organization).filter((o) => o && o !== 'Unknown'))];
      let fields;
      if (g.sameSignals) {
        const card = g.card;
        const impact = await md.cardImpact(g.client_id, { title: card.title, summary: card.summary, business_impact: card.business_impact || [], country: card.country }, orgs);
        fields = { country: standardCountry(card.country), relevance_level: impact.impact_level, impact_reason: impact.impact_reason };
        result.unchanged++;
      } else {
        const w = await writeupFor(g);
        if (!w || !w.title) { result.writeupFailed++; return; }   // left as it was; run again later
        const impact = await md.cardImpact(g.client_id, w, orgs);
        fields = {
          title: w.title, summary: w.summary, short_summary: w.short_summary, business_impact: w.business_impact,
          country: standardCountry(w.country), relevance_level: impact.impact_level, impact_reason: impact.impact_reason,
          last_enriched_at: new Date(Math.max(...g.members.map((m) => new Date(dateOf(m)).getTime() || 0)) || Date.now()).toISOString(),
        };
      }
      Object.assign(fields, { submodule_id: g.submodule_id, signal_id: g.signal_id, category: g.category, signal_count: g.members.length });
      let cardId = g.cardId;
      if (cardId) must(await db.from('market_insights').update(fields).eq('id', cardId), 'card update');
      else {
        const r = must(await db.from('market_insights').insert({ client_id: g.client_id, module_id: MODULE_ID, ...fields }).select().single(), 'card insert');
        cardId = r.data.id; g.cardId = cardId; result.created++;
      }
      if (!g.sameSignals || g.membersTableOff) {
        // the card's links: exactly these signals (both link tables)
        await db.from('market_insight_members').delete().eq('insight_id', cardId);
        for (let i = 0; i < articleIds.length; i += 100) await db.from('market_insight_members').delete().in('article_id', articleIds.slice(i, i + 100));
        must(await db.from('market_insight_members').insert(articleIds.map((a) => ({ insight_id: cardId, article_id: a }))), 'card members');
        for (let i = 0; i < ids.length; i += 100) must(await db.from('market_dynamics_signals').update({ insight_id: cardId }).in('id', ids.slice(i, i + 100)), 'signal link');
        try { await quietly(() => md.updateInsightCentroid(cardId)); } catch (e) { /* rebuilt on the next update */ }
        if (!g.sameSignals) result.rewritten++;
      }
    } catch (e) {
      result.errors.push(`${g.cardId || 'new card'}: ${e.message}`);
    } finally {
      done++;
      progress('cards', done, plan.groups.length);
    }
  };
  for (let i = 0; i < plan.groups.length; i += APPLY_PARALLEL) await Promise.all(plan.groups.slice(i, i + APPLY_PARALLEL).map(oneCard));

  // 4. old cards with no signal left
  for (const c of plan.deleteCards) {
    const { data: still } = await db.from('market_dynamics_signals').select('id').eq('insight_id', c.id).limit(1);
    if (still && still.length) { result.cardsKeptWithSignals++; continue; }   // a write-up failed: kept for now
    try { await md.deleteInsightCentroid(c.id); } catch (e) { /* no centroid */ }
    await db.from('market_insight_members').delete().eq('insight_id', c.id);
    await db.from('market_insights').delete().eq('id', c.id);
    result.cardsDeleted++;
    progress('old cards deleted', result.cardsDeleted, plan.deleteCards.length);
  }

  // 5. every card's count = its real number of signals
  const cardsNow = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('market_insights').select('id, signal_count').eq('module_id', MODULE_ID).range(from, from + 999);
    cardsNow.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const real = new Map();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('market_dynamics_signals').select('insight_id').eq('module_id', MODULE_ID).range(from, from + 999);
    (data || []).forEach((s) => { if (s.insight_id) real.set(s.insight_id, (real.get(s.insight_id) || 0) + 1); });
    if (!data || data.length < 1000) break;
  }
  for (const c of cardsNow) {
    const n = real.get(c.id) || 0;
    if (n && n !== c.signal_count) { await db.from('market_insights').update({ signal_count: n }).eq('id', c.id); result.countsFixed++; }
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════════════
// main
// ═════════════════════════════════════════════════════════════════════════
async function main() {
  if (process.argv.includes('--counts-only')) {
    console.log('Quick finish: fixing card counts and deleting cards with no signals (no regrouping, no AI)...');
    const r = await fixCounts();
    console.log(`\nDone. Cards checked: ${r.cards} | counts fixed: ${r.countsFixed} | empty cards deleted: ${r.emptyDeleted}`);
    return;
  }
  say(`Market Dynamics data cleanup - ${APPLY ? 'APPLY (changes will be made)' : `DRY RUN (nothing is changed)${SKIP_AI ? ', NO AI' : ''}`} - ${new Date().toISOString()}`);
  const clients = await readAll('clients', 'id, company_name, industry', null, 'admin');
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const dimName = new Map((await readAll('submodules', 'id, submodule_name', null, 'admin')).map((d) => [d.id, d.submodule_name]));
  const subCats = await readAll('signals', 'id, signal_name, signal_definition, submodule_id', (q) => q.eq('module_id', MODULE_ID), 'admin');
  const subName = new Map(subCats.map((s) => [s.id, s.signal_name]));
  const signals = await readAll('market_dynamics_signals',
    'id, article_id, client_id, submodule_id, signal_id, insight_id, signal_title, summary, organization, country, published_date, created_at',
    (q) => q.eq('module_id', MODULE_ID));
  const cards = await readAll('market_insights',
    'id, client_id, submodule_id, signal_id, title, summary, short_summary, business_impact, country, category, signal_count, relevance_level, centroid_point_id, last_enriched_at',
    (q) => q.eq('module_id', MODULE_ID));
  const members = await readAll('market_insight_members', 'insight_id, article_id', null, null, 'article_id');
  say(`Read: ${signals.length} signals, ${cards.length} cards, ${clients.length} live clients`);

  // ── part 1: signals ──
  const sameCache = readJson(CACHE.same);
  let sameAsked = 0;
  const confirmSame = (SKIP_AI || LIGHT) ? null : async (a, b) => {
    const k = `${a.article_id}|${b.article_id}`;
    if (sameCache[k]) return sameCache[k];
    const ai = await aiSlot(() => proc.isSameEvent({ title: a.signal_title, summary: a.summary }, { title: b.signal_title, summary: b.summary }));
    sameAsked++;
    if (!ai.failed) sameCache[k] = { same: ai.same, reason: ai.reason };
    if (sameAsked % 25 === 0) { writeJson(CACHE.same, sameCache); process.stdout.write(`\r  same-event check: asked AI ${sameAsked}`); }
    return ai;
  };
  console.log('Copies check...');
  const plan = await planSignals(signals, clientById, { confirmSame, subCats });
  if (confirmSame) { writeJson(CACHE.same, sameCache); console.log(`\n  same-event check done: asked AI ${sameAsked}`); }

  let industryWouldAsk = 0;
  if (SKIP_INDUSTRY) {
    plan.count.wrongIndustry = 0;
    const removing = new Set(plan.remove.map((r) => r.row.id));
    const icache = readJson(CACHE.industry);
    for (const r of signals) {
      if (removing.has(r.id) || !clientById.has(r.client_id) || icache[r.article_id]) continue;
      if (!obviouslyOnIndustry(r, clientById.get(r.client_id), await proc.getClientProfile(r.client_id))) industryWouldAsk++;
    }
  } else {
    const cache = readJson(CACHE.industry);
    console.log(`Industry check (one short AI question per unclear signal, saved answers reused: ${Object.keys(cache).length})...`);
    await industryStep(plan, signals, clientById, {
      checkFn: (article, industry, clientId) => aiSlot(() => proc.checkIndustry(article, industry, clientId)),
      textOf: async () => new Map(),
      profileOf: (clientId) => proc.getClientProfile(clientId),
      cache,
      saveCache: (c) => writeJson(CACHE.industry, c),
    });
  }

  // ── part 2: cards ──
  const fitCache = readJson(CACHE.fit);
  let fitAsked = 0;
  const askFit = (SKIP_AI || LIGHT) ? null : async (s, groups) => {
    const k = `${s.article_id}>${groups.map((g) => g.members[0].article_id).sort().join(',')}`;
    if (fitCache[k] !== undefined) {
      if (fitCache[k] === '0') return -1;
      return groups.findIndex((g) => g.members[0].article_id === fitCache[k]);
    }
    const r = await aiSlot(() => md.askCardFit({ title: s.signal_title, summary: s.summary },
      groups.map((g) => ({ title: g.members[g.members.length - 1].signal_title, memberTitles: g.members.slice(-6).reverse().map((m) => m.signal_title) }))));
    fitAsked++;
    if (fitAsked % 25 === 0) { writeJson(CACHE.fit, fitCache); process.stdout.write(`\r  card fit: asked AI ${fitAsked}`); }
    if (r.failed) return null;
    fitCache[k] = r.index >= 0 ? groups[r.index].members[0].article_id : '0';
    return r.index;
  };
  console.log('Grouping the signals into cards (new rule)...');
  await planCards(plan, signals, cards, clientById, { embed: embedMany, askFit, dimName, members });
  if (askFit) { writeJson(CACHE.fit, fitCache); console.log(`\n  card fit done: asked AI ${fitAsked}`); }

  const changed = plan.groups.filter((g) => !g.sameSignals);
  const toWrite = changed.filter((g) => g.members.length > 1);   // only these need the AI

  // card write-ups (AI, saved; the dry run with AI writes them so the report shows the new titles)
  const writeCache = readJson(CACHE.writeup);
  let writeAsked = 0;
  const writeupFor = async (g) => {
    if (g.members.length === 1) return singleCard(g.members[0]);
    if (writeCache[g.key]) return writeCache[g.key];
    if (SKIP_AI) return null;
    const client = clientById.get(g.client_id);
    const list = [...g.members].sort(bySignalDate).reverse();
    try {
      const w = await aiSlot(() => md.generateInsightWriteup(null, `${list[0].signal_title}\n${list[0].summary || ''}`, client.industry, { members: list }));
      writeAsked++;
      if (w && w.title) { writeCache[g.key] = w; if (writeAsked % 10 === 0) { writeJson(CACHE.writeup, writeCache); process.stdout.write(`\r  card write-ups: ${writeAsked}`); } }
      return w;
    } catch (e) { return null; }
  };
  if (!SKIP_AI) {
    console.log(`Writing ${toWrite.length} changed cards (saved ones reused: ${toWrite.filter((g) => writeCache[g.key]).length})...`);
    for (let i = 0; i < toWrite.length; i += 2) await Promise.all(toWrite.slice(i, i + 2).map(writeupFor));
    writeJson(CACHE.writeup, writeCache);
    console.log('');
  }

  // ── report ──
  const c1 = plan.count; const c2 = plan.cardCount;
  const multi = plan.groups.filter((g) => g.members.length > 1);
  const writeNeeded = toWrite.filter((g) => !writeCache[g.key]).length;
  say('');
  say('SIGNALS TO DELETE (signal + article rows + chat text)');
  say(`  deleted clients:            ${c1.dead}`);
  say(`  no sub-category, no clear word in the title: ${c1.noSub}`);
  say(`  same title again:           ${c1.exact}`);
  say((SKIP_AI || LIGHT)
    ? `  same event (near copy):     not checked (no AI) - ${c1.nearWouldAsk} word matches kept`
    : `  same event (near copy):     ${c1.near}   (AI said "different" for ${c1.nearNotSame}: kept${c1.nearAiFailed ? `; AI failed ${c1.nearAiFailed}: kept` : ''})`);
  say(SKIP_INDUSTRY
    ? `  not the client's industry:  not checked - ${industryWouldAsk} signals would be asked (the rest name the industry)`
    : `  not the client's industry:  ${c1.wrongIndustry}${c1.industryFailed ? `   (AI failed for ${c1.industryFailed}: kept)` : ''}`);
  say(`  TOTAL:                      ${plan.remove.length}`);
  say(`SIGNALS KEPT: ${plan.keptSignals}   (country written one way: ${c1.countryFixed})`);
  if (plan.assigned && plan.assigned.length) {
    const per = new Map();
    plan.assigned.forEach((a) => per.set(a.name, (per.get(a.name) || 0) + 1));
    say(`OLD SIGNALS WITH NO SUB-CATEGORY, given one from the title words (free): ${plan.assigned.length}`);
    [...per.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, k]) => say(`    ${String(k).padStart(5)}  ${n}`));
  }
  say('');
  say('CARDS (new rule: same client + same sub-category + same theme)');
  say(`  cards now:                  ${cards.length}`);
  say(`  cards after:                ${plan.groups.length}${SKIP_AI ? '  (upper number: without the AI every unsure signal starts its own card)' : ''}   (2+ signals: ${multi.length}, biggest: ${Math.max(0, ...plan.groups.map((g) => g.members.length))})`);
  say(`  unchanged (no AI):          ${plan.groups.length - changed.length}   (of these, card links to repair: ${plan.groups.filter((g) => g.membersTableOff).length})`);
  say(`  one-signal cards changed (signal's own title + summary, no AI): ${changed.length - toWrite.length}`);
  say(`  new title + summary (AI):   ${toWrite.length}${SKIP_AI ? '' : `   (written now: ${toWrite.length - writeNeeded}, failed: ${writeNeeded})`}`);
  say(`  old cards deleted:          ${plan.deleteCards.length}`);
  say(`  joining: very close (no AI) ${c2.autoJoin} | AI said same theme ${c2.aiJoin} | AI said none ${c2.aiNone} | nothing close ${c2.newNoClose}${(SKIP_AI || LIGHT) ? ` | unsure, own card ${c2.fitWouldAsk}` : ` | AI failed ${c2.fitFailed}`}`);
  if (plan.fitScores.length) {
    const b = (lo, hi) => plan.fitScores.filter((x) => x >= lo && x < hi).length;
    say(`  unsure scores (AI asked): 0.55-0.65: ${b(0.55, 0.65)} | 0.65-0.75: ${b(0.65, 0.75)}`);
  }
  if (SKIP_AI) {
    const calls = LIGHT ? toWrite.length : c1.nearWouldAsk + (SKIP_INDUSTRY ? industryWouldAsk : 0) + c2.fitWouldAsk + toWrite.length;
    if (LIGHT) say(`\nLIGHT RUN: only the ${toWrite.length} card write-ups use the AI -> about ${Math.ceil((toWrite.length * AI_SECONDS) / 60)} minutes`);
    say('');
    say('AI NEEDED FOR THE REAL RUN (most it can be)');
    say(`  same-event questions: ${c1.nearWouldAsk} | industry questions: ${industryWouldAsk} | card fit questions: ${c2.fitWouldAsk} | card write-ups: about ${toWrite.length}`);
    say(`  total about ${calls} AI calls -> about ${Math.ceil((calls * AI_SECONDS) / 60)} minutes at our speed limit`);
    say(`  (write-ups are the big ones, about 1,500 words each; the rest are short questions)`);
  }
  out('');
  out('PER CLIENT: signals now -> kept | cards now -> after');
  for (const c of clients) {
    const sNow = signals.filter((s) => s.client_id === c.id).length;
    if (!sNow) continue;
    const kept = plan.groups.filter((g) => g.client_id === c.id).reduce((n, g) => n + g.members.length, 0);
    out(`  ${c.company_name}: ${sNow} -> ${kept} | ${cards.filter((x) => x.client_id === c.id).length} -> ${plan.groups.filter((g) => g.client_id === c.id).length}`);
  }
  const showGroup = (g) => {
    const client = clientById.get(g.client_id);
    const w = writeCache[g.key];
    out(`  [${client.company_name} | ${subName.get(g.signal_id) || '(no sub-category)'}] ${g.members.length} signals`);
    out(`      ${g.card ? `old card: "${g.card.title}"` : 'new card'}${w ? `  ->  NEW: "${w.title}"` : ''}`);
    g.members.slice(0, 8).forEach((m) => out(`        - ${day10(m)} "${m.signal_title}"`));
    if (g.members.length > 8) out(`        ... and ${g.members.length - 8} more`);
  };
  out('');
  out('CHANGED CARDS WITH 2+ SIGNALS (first 150) - please check the groups are about ONE theme:');
  toWrite.filter((g) => g.members.length > 1).slice(0, 150).forEach(showGroup);
  if (plan.assigned && plan.assigned.length) {
    out('');
    out('SUB-CATEGORY GIVEN TO OLD SIGNALS (examples, 8 per sub-category) - please check:');
    const shown = new Map();
    for (const a of plan.assigned) {
      if ((shown.get(a.name) || 0) >= 8) continue;
      shown.set(a.name, (shown.get(a.name) || 0) + 1);
      out(`  ${a.name}: "${a.s.signal_title}"`);
    }
  }
  out('');
  out('JOINED WITHOUT AI (very close, examples):');
  plan.cardSamples.autoJoin.forEach((l) => out(l));
  out('');
  out('AI SAID SAME THEME (examples):');
  plan.cardSamples.aiJoin.forEach((l) => out(l));
  out('');
  out('AI SAID NOT THE SAME THEME (examples):');
  plan.cardSamples.aiNone.forEach((l) => out(l));
  out('');
  out('NEAR COPIES (deleted first, KEPT second):');
  plan.nearSamples.forEach((l) => out(l));
  out('');
  out('WORD MATCHES THE AI SAID ARE DIFFERENT (both KEPT):');
  plan.notSameSamples.forEach((l) => out(l));
  if (plan.wrongIndustry && plan.wrongIndustry.length) {
    out('');
    out("NOT THE CLIENT'S INDUSTRY (all) - please check:");
    plan.wrongIndustry.forEach(({ row, answer }) => { const c = clientById.get(row.client_id); out(`  [${c.company_name} / ${c.industry}] "${row.signal_title}" -> about: ${answer.main_industry || '?'} | ${answer.reason}`); });
  }
  out('');
  out('ALL SIGNALS TO DELETE');
  plan.remove.forEach(({ row, why }) => out(`  ${row.article_id} | ${clientById.get(row.client_id) ? clientById.get(row.client_id).company_name : row.client_id} | "${row.signal_title}" | ${why}`));

  const file = path.join(LOG_DIR, `cleanMarketData-${APPLY ? 'applied' : 'dryrun'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(file, reportLines.join('\n'));
  console.log(`\nFull report: ${file}`);

  if (!APPLY) { console.log('\nDRY RUN - nothing was changed. Read the report, then run with --apply.'); return; }
  if (SKIP_AI) { console.log('\n--apply needs the AI answers: run without --skip-ai.'); return; }

  console.log('\nApplying...');
  let lastShown = 0;
  const r = await applyPlan(plan, clientById, {
    writeupFor,
    progress: (label, n, total) => { if (n === total || Date.now() - lastShown > 3000) { lastShown = Date.now(); process.stdout.write(`\r  ${label}: ${n}/${total}      `); } },
  });
  writeJson(CACHE.writeup, writeCache);
  console.log(`\n\nDone. Signals deleted: ${r.deletedSignals} | cards rewritten: ${r.rewritten} (new: ${r.created}) | unchanged: ${r.unchanged} | old cards deleted: ${r.cardsDeleted}`);
  console.log(`Card write-up failed (left as it was, run again): ${r.writeupFailed} | old cards kept because a signal is still on them: ${r.cardsKeptWithSignals} | counts fixed: ${r.countsFixed}`);
  if (r.errors.length) { console.log(`Errors (${r.errors.length}):`); r.errors.slice(0, 20).forEach((e) => console.log(`  ${e}`)); }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(`\nCleanup stopped: ${e.message}`); process.exit(1); });
}
module.exports = { planSignals, planCards, applyPlan, subCategoryFromTitle, fixCounts };   // used by scripts/testMarketPipeline.js
