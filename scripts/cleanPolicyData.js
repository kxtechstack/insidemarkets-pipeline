/**
 * scripts/cleanPolicyData.js
 *
 * ONE-TIME CLEANUP of the old Policy & Risk data, with the SAME rules the pipeline uses now.
 *
 *   node scripts/cleanPolicyData.js            DRY RUN: changes nothing, writes a report to scripts/logs/
 *   node scripts/cleanPolicyData.js --apply    does the changes in the report
 *
 * What it does (decided with Sneha on 13 Nov):
 *   1. Rows of deleted clients (client_id no longer in admin.clients)  -> deleted everywhere
 *   2. Rows that are not policy news (category "Mergers and Acquisitions" ...)  -> deleted everywhere
 *   3. Copies: the same title saved again for the same client (first one kept), and near-copies
 *      (same client, same country, published within 7 days, same words by the strict word rule,
 *      AND the AI confirms it is the same event - the same check the pipeline does)  -> deleted everywhere
 *      AI answers are saved in scripts/logs/policySameEventCheck.json (reused by --apply).
 *   4. Rows NOT about the client's industry (food labels for a cosmetics client...)  -> deleted everywhere
 *      Checked with the SAME AI industry question the pipeline asks for new articles (one short call per
 *      row). The answers are saved in scripts/logs/policyIndustryCheck.json, so the dry run asks the AI,
 *      and --apply (or a second dry run) reuses the saved answers - no second AI call, same result.
 *      If the AI fails for a row, that row is KEPT (and asked again next time).
 *      Skip this step with --skip-industry (fast dry run without AI).
 *   5. Kept rows:
 *        category     -> one of the 15 general categories (old names mapped; the vague old
 *                        "Regulatory Risk" type is sorted by the words of its title)
 *        source type  -> one of the 9 allowed source types
 *        country      -> standard names, only the countries (regions / "Global" / states removed
 *                        when a country is named)
 *        impact       -> Critical / High / Medium / Low from the client profile, with a reason
 *   "Deleted everywhere" = policy_signals + policy_articles_metadata + policy_articles_full + the chat
 *   text in Qdrant (the same undo the pipeline uses when a save fails).
 *   Links stay in processed_urls, so the pipeline does not fetch the deleted copies again.
 *
 * No AI calls. Safe to run the dry run as often as you like.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Module = require('module');

// the pipeline modules load a Redis client; this script does not need Redis (same trick as runPipelineLocal.js)
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
const { compareHeadlines } = require('../modules/topicDedup');
const { standardPlaces, isCountry, REGIONS } = require('../modules/placeNames');

const APPLY = process.argv.includes('--apply');
const SKIP_AI = process.argv.includes('--skip-ai');   // no AI at all: near copies and other-industry rows are kept
const SKIP_INDUSTRY = SKIP_AI || process.argv.includes('--skip-industry');
const SAME_CACHE_FILE = path.join(__dirname, 'logs', 'policySameEventCheck.json');
const INDUSTRY_CACHE_FILE = path.join(__dirname, 'logs', 'policyIndustryCheck.json');
const INDUSTRY_PARALLEL = 3;   // rows prepared at a time; the AI itself is limited by aiSlot below

// ── AI speed limit (16 Nov: 7 clients at once hit the AI provider's limit, "429 rate limited") ──
// At most AI_PARALLEL questions at the same time, and at least AI_GAP_MS between two questions.
const AI_PARALLEL = Number(process.env.CLEANUP_AI_PARALLEL) || 2;
// Novita limit for our model: 30 requests per minute -> one question every 2.1 seconds (about 28 a minute).
// If the limit is raised in Novita (Quotas & Limits -> Increase Limit), set CLEANUP_AI_GAP_MS lower in .env.
const AI_GAP_MS = Number(process.env.CLEANUP_AI_GAP_MS) || 2100;
let aiActive = 0; let aiLast = 0;
const aiWaiting = [];
async function aiSlot(fn) {
  while (aiActive >= AI_PARALLEL) await new Promise((r) => aiWaiting.push(r));
  aiActive++;
  try {
    const wait = aiLast + AI_GAP_MS - Date.now();
    aiLast = Math.max(Date.now(), aiLast + AI_GAP_MS);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return await fn();
  } finally {
    aiActive--;
    const next = aiWaiting.shift();
    if (next) next();
  }
}
const MODULE_ID = proc.POLICY_MODULE_ID;
const NEAR_COPY_DAYS = 7;    // same rule as the live same-event check (published within 7 days)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── report ────────────────────────────────────────────────────────────────
const reportLines = [];
const out = (line = '') => { reportLines.push(line); };
const say = (line = '') => { console.log(line); out(line); };

// ── read everything ───────────────────────────────────────────────────────
async function readAll(table, columns, filter) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns).order('created_at', { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

// ── rules ─────────────────────────────────────────────────────────────────
const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dayOf = (row) => new Date(row.source_published_date || row.created_at).getTime() / 864e5;

/** Country: standard names; when a country is named, only the countries are kept. */
function cleanCountry(value) {
  const list = standardPlaces(value);
  const countries = list.filter(isCountry);
  if (countries.length) return countries.join(', ');
  const regions = list.filter((p) => REGIONS.has(p) && p !== 'Global');
  if (regions.length) return regions.join(', ');
  if (list.includes('Global')) return 'Global';
  return list.length ? list.join(', ') : 'Unknown';
}

// old vague categories (the old default "Regulatory Risk" etc.): sorted by the words of the title.
// First match wins; nothing matches -> "Regulation & Guidance".
const VAGUE_OLD = /^(regulatory risk|other regulatory risk|regulatory change|regulatory development|regulatory guidance|stablecoin & crypto regulation|payments system|healthcare regulation|life insurance)$/i;
const TITLE_RULES = [
  [/\b(court|ruling|judge|lawsuit|tribunal|litigation|appeal)\b/i, 'Court Rulings & Litigation'],
  [/\b(sanction|sanctions|embargo|blacklist)\b/i, 'Sanctions & Restrictions'],
  [/\b(fine|fines|fined|penalt\w*|warning letter|warns|raid\w*|crack\w* down|crackdown|seiz\w*|probe|investigat\w*|prosecut\w*|charged|enforcement)\b/i, 'Enforcement & Penalties'],
  [/\b(draft|consultation|propos\w*|seeks? (public )?(comments?|feedback|input))\b/i, 'Consultation & Proposal'],
  [/\b(licen[cs]\w*|permit\w*|approv\w*|registration|authori[sz]ation|sandbox)\b/i, 'Licensing & Approvals'],
  [/\b(tariff\w*|customs|import\w*|export\w*|trade)\b/i, 'Trade, Tariffs & Customs'],
  [/\b(tax\w*|vat|capital|central bank|interest rate|stablecoin\w*|crypto\w*|payment\w*|monetary)\b/i, 'Tax & Financial Rules'],
  [/\b(data|privacy|cyber\w*|artificial intelligence|\bai\b|digital)\b/i, 'Data, Privacy & Technology'],
  [/\b(climate|emission\w*|carbon|esg|packaging|waste|plastic\w*|environment\w*|sustainab\w*|pfas)\b/i, 'Environment & Sustainability'],
  [/\b(ban|bans|banned|restrict\w*|recall\w*|label\w*|ingredient\w*|safety|standard\w*|testing)\b/i, 'Product Safety & Standards'],
  [/\b(labour|labor|employment|wage\w*|worker\w*)\b/i, 'Labour & Employment'],
  [/\b(deadline|reporting|disclos\w*|compliance|kyc|aml|notification\w*)\b/i, 'Compliance & Reporting'],
  [/\b(law|act|bill|legislation|parliament|enact\w*|executive order)\b/i, 'New Law & Legislation'],
];
function newCategory(row, mapped) {
  if (mapped !== 'Regulation & Guidance' || !VAGUE_OLD.test(String(row.category || '').trim())) return mapped;
  const hit = TITLE_RULES.find(([re]) => re.test(row.signal_title || ''));
  return hit ? hit[1] : 'Regulation & Guidance';
}

// ── run small jobs a few at a time ─────────────────────────────────────────
async function inBatches(items, size, fn, label) {
  let done = 0;
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
    done = Math.min(items.length, i + size);
    if (done % 200 < size || done === items.length) process.stdout.write(`\r  ${label}: ${done}/${items.length}`);
  }
  if (items.length) console.log('');
}

// applyPolicyRules prints a line for every mapped category: quiet here (thousands of rows)
const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

// ── the plan: what to delete and what to update (changes nothing) ─────────
// confirmSame(rowA, rowB) -> Promise<{ same, reason, failed? }>: the AI "same event?" question, asked only
// when the words already say "same" (the same question the pipeline asks). Without it (no AI) a near
// copy is NOT deleted - safe: only exact same titles are deleted then.
async function buildPlan(rows, clientById, { confirmSame = null } = {}) {
  const remove = [];          // { row, why }
  const updates = [];         // { row, patch }
  const nearSamples = [];
  const count = { dead: 0, notPolicy: 0, markedBefore: 0, exact: 0, near: 0, nearNotSame: 0, nearAiFailed: 0 };
  const notSameSamples = [];
  const catMoves = new Map(); const srcMoves = new Map(); const impactMoves = new Map();
  const countrySamples = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  // group by client
  const byClient = new Map();
  for (const r of rows) {
    if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
    byClient.get(r.client_id).push(r);
  }

  // clients run side by side (each client's own rows stay in order: the first one is kept)
  await Promise.all([...byClient.entries()].map(async ([clientId, list]) => {
    const client = clientById.get(clientId);
    if (!client) {
      list.forEach((row) => remove.push({ row, why: 'client no longer exists' }));
      count.dead += list.length;
      return;
    }
    const profile = await proc.getClientProfile(clientId);
    const industryWords = new Set(String(client.industry || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).flatMap((w) => [w, w.replace(/s$/, '')]));
    const keptByTitle = new Map();
    const keptByCountry = new Map();   // country -> kept rows (for near copies)

    for (const row of list) {       // oldest first: the first one is kept
      if (row.is_duplicate) { remove.push({ row, why: 'already marked as a duplicate' }); count.markedBefore++; continue; }

      const fixed = quiet(() => proc.applyPolicyRules({ is_relevant: true, category: row.category, source_type: row.source_type, country: row.country }));
      if (!fixed.is_relevant) { remove.push({ row, why: `not policy news (category "${row.category}")` }); count.notPolicy++; continue; }

      const t = normTitle(row.signal_title);
      if (t && keptByTitle.has(t)) {
        remove.push({ row, why: `same title as ${keptByTitle.get(t).article_id}` });
        count.exact++;
        continue;
      }
      const country = cleanCountry(row.country);
      const places = country.split(', ').filter((p) => p !== 'Unknown' && p !== 'Global');
      let near = null;
      let asked = 0;
      const d = (r) => String(r.source_published_date || r.created_at).slice(0, 10);
      for (const p of places) {
        for (const k of keptByCountry.get(p) || []) {
          if (Math.abs(dayOf(k) - dayOf(row)) > NEAR_COPY_DAYS) continue;
          const h = compareHeadlines(row.signal_title, k.signal_title, industryWords, { strict: true });
          if (!h.same) continue;
          if (!confirmSame || asked >= 2) break;           // no AI: never delete a near copy
          asked++;
          const ai = await confirmSame(row, k);
          if (ai.same) { near = { k, h, ai }; break; }
          if (ai.failed) count.nearAiFailed++;
          else {
            count.nearNotSame++;
            notSameSamples.push(`  [${client.company_name}] ${d(row)} "${row.signal_title}"\n      # ${d(k)} "${k.signal_title}"   (AI: ${ai.reason})`);
          }
        }
        if (near || asked >= 2) break;
      }
      if (near) {
        remove.push({ row, why: `same event as ${near.k.article_id} (${near.h.shared.join(', ')}; AI: ${near.ai.reason})` });
        count.near++;
        nearSamples.push(`  [${client.company_name}] ${d(row)} "${row.signal_title}"\n      = ${d(near.k)} "${near.k.signal_title}"   (AI: ${near.ai.reason})`);
        continue;
      }
      if (t) keptByTitle.set(t, row);
      places.forEach((p) => { if (!keptByCountry.has(p)) keptByCountry.set(p, []); keptByCountry.get(p).push(row); });

      // kept row: new values
      const category = newCategory(row, fixed.category);
      const impact = proc.decideImpact(
        { signal_title: row.signal_title, summary: row.summary, country, focus_matches: [], avoid_matches: [] },
        { title: row.signal_title, text: row.summary || '' },
        profile,
      );
      const patch = {};
      if (category !== row.category) { patch.category = category; bump(catMoves, `${row.category || '(empty)'} -> ${category}`); }
      if (fixed.source_type !== row.source_type) { patch.source_type = fixed.source_type; bump(srcMoves, `${row.source_type || '(empty)'} -> ${fixed.source_type}`); }
      if (country !== row.country) {
        patch.country = country;
        if (countrySamples.size < 40) countrySamples.set(row.country || '(empty)', country);
      }
      if (impact.impact_level !== row.impact_level) { patch.impact_level = impact.impact_level; bump(impactMoves, `${row.impact_level || '(empty)'} -> ${impact.impact_level}`); }
      if (impact.impact_reason !== row.impact_reason) patch.impact_reason = impact.impact_reason;
      if (Object.keys(patch).length) updates.push({ row, patch });
    }
  }));
  return { remove, updates, count, nearSamples, notSameSamples, catMoves, srcMoves, impactMoves, countrySamples };
}

// ── step 4: rows not about the client's industry (AI, answers saved) ────────
// checkFn(article, industry, clientId) -> { pass, reason, main_industry }   (the pipeline's checkIndustry)
// textOf(articleIds) -> Map(article_id -> full text)                          (rewritten text from policy_articles_full)
// To keep AI use small, a row is NOT asked when its title or summary already names the client's
// industry or one of the client's own focus areas (e.g. "cosmetic" for a Cosmetics client,
// "solar" for an energy client): such a row is clearly about the industry.
const wordsOf = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 4).map((w) => w.replace(/(ies|es|s)$/, ''));
const SKIP_WORDS = new Set(['general', 'other', 'product', 'service', 'solution', 'industry', 'sector', 'market', 'prestige', 'premium', 'retail', 'specialty', 'global']);
function obviouslyOnIndustry(row, client, profile) {
  const keys = new Set([
    ...wordsOf(client.industry),
    ...((profile && profile.focus) || []).flatMap(wordsOf),
  ].filter((w) => !SKIP_WORDS.has(w)));
  if (!keys.size) return false;
  const text = new Set(wordsOf(`${row.signal_title} ${row.summary || ''}`));
  return [...keys].some((k) => text.has(k));
}

async function industryStep(plan, rows, clientById, { checkFn, textOf, cache, saveCache, profileOf = null }) {
  const removing = new Set(plan.remove.map((r) => r.row.id));
  const candidates = rows.filter((r) => !removing.has(r.id) && clientById.get(r.client_id));
  const todo = [];
  let obvious = 0;
  for (const r of candidates) {
    const profile = profileOf ? await profileOf(r.client_id) : null;
    if (obviouslyOnIndustry(r, clientById.get(r.client_id), profile)) obvious++;
    else todo.push(r);
  }
  console.log(`  industry check: ${obvious} rows clearly name the industry (no AI), ${todo.length} rows to ask`);
  const wrong = [];
  let asked = 0; let fromCache = 0; let failed = 0;
  for (let i = 0; i < todo.length; i += 100) {
    const part = todo.slice(i, i + 100);
    const texts = await textOf(part.filter((r) => !cache[r.article_id]).map((r) => r.article_id));
    for (let j = 0; j < part.length; j += INDUSTRY_PARALLEL) {
      await Promise.all(part.slice(j, j + INDUSTRY_PARALLEL).map(async (row) => {
        let answer = cache[row.article_id];
        if (answer) fromCache++;
        else {
          const industry = clientById.get(row.client_id).industry;
          answer = await checkFn({ title: row.signal_title, text: texts.get(row.article_id) || row.summary || '' }, industry, row.client_id);
          asked++;
          // an AI failure is not an answer: keep the row and ask again next time
          if (/check (failed|gave no answer|off)/.test(answer.reason || '')) { failed++; return; }
          cache[row.article_id] = { pass: !!answer.pass, main_industry: answer.main_industry || '', reason: answer.reason || '' };
        }
        if (!answer.pass) wrong.push({ row, answer });
      }));
    }
    if (saveCache) saveCache(cache);
    if (checkFn.name !== 'fakeCheck') process.stdout.write(`\r  industry check: ${Math.min(i + 100, todo.length)}/${todo.length} (asked AI ${asked}, saved answers ${fromCache}, AI failed ${failed})`);
  }
  if (todo.length && checkFn.name !== 'fakeCheck') console.log('');
  for (const { row, answer } of wrong) {
    const industry = clientById.get(row.client_id).industry;
    plan.remove.push({ row, why: `not about the ${industry} industry (it is about: ${answer.main_industry || '?'}) - ${answer.reason}` });
  }
  const gone = new Set(wrong.map((w) => w.row.id));
  plan.updates = plan.updates.filter((u) => !gone.has(u.row.id));
  plan.count.wrongIndustry = wrong.length;
  plan.count.industryNoAi = obvious;
  plan.count.industryAsked = todo.length;
  plan.count.industryFailed = failed;
  plan.wrongIndustry = wrong;
  return plan;
}

async function readFullTexts(articleIds) {
  const map = new Map();
  for (let i = 0; i < articleIds.length; i += 100) {
    const { data } = await supabase.from('policy_articles_full').select('article_id, full_text').in('article_id', articleIds.slice(i, i + 100));
    (data || []).forEach((r) => map.set(r.article_id, r.full_text || ''));
  }
  return map;
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  say(`Policy data cleanup - ${APPLY ? 'APPLY (changes will be made)' : 'DRY RUN (nothing is changed)'} - ${new Date().toISOString()}`);
  const rows = await readAll('policy_signals',
    'id, article_id, client_id, signal_title, summary, category, source_type, country, impact_level, impact_reason, is_duplicate, created_at, source_published_date',
    (q) => q.eq('module_id', MODULE_ID));
  const { data: clients, error } = await supabase.schema('admin').from('clients').select('id, company_name, industry');
  if (error) throw new Error(`admin.clients: ${error.message}`);
  const clientById = new Map((clients || []).map((c) => [c.id, c]));
  say(`Policy signals read: ${rows.length}`);
  let sameCache = {};
  try { sameCache = JSON.parse(fs.readFileSync(SAME_CACHE_FILE, 'utf8')); } catch (e) { /* first run */ }
  fs.mkdirSync(path.dirname(SAME_CACHE_FILE), { recursive: true });
  let sameAsked = 0;
  const confirmSame = SKIP_AI ? null : async (a, b) => {
    const k = `${a.article_id}|${b.article_id}`;
    if (sameCache[k]) return sameCache[k];
    const ai = await aiSlot(() => proc.isSameEvent({ title: a.signal_title, summary: a.summary }, { title: b.signal_title, summary: b.summary }));
    sameAsked++;
    if (!ai.failed) sameCache[k] = { same: ai.same, reason: ai.reason };
    if (sameAsked % 25 === 0) {
      fs.writeFileSync(SAME_CACHE_FILE, JSON.stringify(sameCache));
      process.stdout.write(`\r  same-event check: asked AI ${sameAsked}`);
    }
    return ai;
  };
  if (SKIP_AI) say('AI SKIPPED (--skip-ai): near copies and rows about other industries are KEPT, only exact copies are counted.');
  else console.log('Same-event check (AI asked only when the words already say "same")...');
  const plan = await buildPlan(rows, clientById, { confirmSame });
  if (confirmSame) { fs.writeFileSync(SAME_CACHE_FILE, JSON.stringify(sameCache)); console.log(`\n  same-event check done: asked AI ${sameAsked} (saved answers reused for the rest)`); }
  if (SKIP_INDUSTRY) {
    if (!SKIP_AI) say('Industry check SKIPPED (--skip-industry): rows about other industries are not counted below.');
    plan.count.wrongIndustry = 0;
  } else {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(INDUSTRY_CACHE_FILE, 'utf8')); } catch (e) { /* first run */ }
    fs.mkdirSync(path.dirname(INDUSTRY_CACHE_FILE), { recursive: true });
    console.log(`Industry check (one short AI question per row, saved answers reused: ${Object.keys(cache).length})...`);
    await industryStep(plan, rows, clientById, {
      checkFn: (article, industry, clientId) => aiSlot(() => proc.checkIndustry(article, industry, clientId)),
      textOf: async () => new Map(),   // title + short summary only (small AI questions, low cost)
      profileOf: (clientId) => proc.getClientProfile(clientId),
      cache,
      saveCache: (c) => fs.writeFileSync(INDUSTRY_CACHE_FILE, JSON.stringify(c)),
    });
  }
  const { remove, updates, count, nearSamples, notSameSamples, catMoves, srcMoves, impactMoves, countrySamples } = plan;

  // ── report ──
  const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  say('');
  say('TO DELETE (row + full text + chat text in Qdrant)');
  say(`  deleted clients:            ${count.dead}`);
  say(`  not policy news:            ${count.notPolicy}`);
  say(`  already marked duplicates:  ${count.markedBefore}`);
  say(`  same title again:           ${count.exact}`);
  say(`  same event (near copy):     ${count.near}   (AI said "different" for ${count.nearNotSame} word matches: kept${count.nearAiFailed ? `; AI failed ${count.nearAiFailed}: kept` : ''})`);
  say(`  not the client's industry:  ${count.wrongIndustry}${count.industryFailed ? `   (AI failed for ${count.industryFailed} rows: kept, run again to ask them)` : ''}`);
  say(`  TOTAL:                      ${remove.length}`);
  say(`TO UPDATE: ${updates.length} rows (category / source type / country / impact)`);
  say(`LEFT AFTER CLEANUP: ${rows.length - remove.length}`);
  out('');
  if (plan.wrongIndustry && plan.wrongIndustry.length) {
    out("NOT THE CLIENT'S INDUSTRY (all) - please check:");
    plan.wrongIndustry.forEach(({ row, answer }) => {
      const c = clientById.get(row.client_id);
      out(`  [${c.company_name} / ${c.industry}] "${row.signal_title}"  -> about: ${answer.main_industry || '?'} | ${answer.reason}`);
    });
    out('');
  }
  out('NEAR COPIES (all) - deleted row first, the row that is KEPT second, with published dates:');
  nearSamples.forEach((l) => out(l));
  out('');
  out('WORD MATCHES THE AI SAID ARE DIFFERENT NEWS (both KEPT) - please check:');
  notSameSamples.forEach((l) => out(l));
  out('');
  out('CATEGORY CHANGES');
  sorted(catMoves).forEach(([k, v]) => out(`  ${String(v).padStart(5)}  ${k}`));
  out('');
  out('SOURCE TYPE CHANGES');
  sorted(srcMoves).forEach(([k, v]) => out(`  ${String(v).padStart(5)}  ${k}`));
  out('');
  out('COUNTRY CHANGES (examples)');
  [...countrySamples.entries()].forEach(([a, b]) => out(`  "${a}" -> "${b}"`));
  out('');
  out('IMPACT CHANGES');
  sorted(impactMoves).forEach(([k, v]) => out(`  ${String(v).padStart(5)}  ${k}`));
  out('');
  out('ALL ROWS TO DELETE');
  remove.forEach(({ row, why }) => out(`  ${row.article_id} | ${clientById.get(row.client_id) ? clientById.get(row.client_id).company_name : row.client_id} | "${row.signal_title}" | ${why}`));

  const logDir = path.join(__dirname, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `cleanPolicyData-${APPLY ? 'applied' : 'dryrun'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`);
  fs.writeFileSync(file, reportLines.join('\n'));
  console.log(`\nFull report: ${file}`);

  if (!APPLY) {
    console.log('\nDRY RUN - nothing was changed. Read the report, then run with --apply.');
    return;
  }

  // ── apply ──
  console.log('\nApplying...');
  await inBatches(remove, 5, ({ row }) => proc.undoSave(row.article_id, 'policy_signals'), 'deleted');
  let failed = 0;
  await inBatches(updates, 10, async ({ row, patch }) => {
    const { error: e } = await supabase.from('policy_signals').update(patch).eq('id', row.id);
    if (e) { failed++; console.error(`\n  update failed for ${row.article_id}: ${e.message}`); }
  }, 'updated');
  const { count: left } = await supabase.from('policy_signals').select('id', { count: 'exact', head: true }).eq('module_id', MODULE_ID);
  console.log(`\nDone. Policy signals now: ${left}. Update errors: ${failed}.`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(`\nCleanup stopped: ${e.message}`); process.exit(1); });
}
module.exports = { buildPlan, industryStep, cleanCountry, newCategory, aiSlot, obviouslyOnIndustry };   // used by scripts/testPolicyPipeline.js and scripts/cleanMarketData.js
