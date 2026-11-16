/**
 * scripts/checkMarketCards.js
 *
 * READ-ONLY health check of the Market Dynamics CARDS (changes nothing, no AI calls).
 *
 *   node scripts/checkMarketCards.js
 *
 * For every live client -> dimension -> sub-category (signal) -> card, it checks:
 *   1. WRONG CATEGORY   a signal on the card belongs to another sub-category than the card
 *                       (e.g. a Venture Capital signal on a "Funding Rounds Announced" card)
 *   2. NOT SIMILAR      a signal on the card is about something else than the rest of the card
 *   3. COPIES           the same news twice on one card
 *   4. TITLE OFF        the card title + summary do not describe the signals under it
 * Similarity uses the same local meaning model as the pipeline (MiniLM), not the AI.
 * Report: scripts/logs/checkMarketCards-<date>.txt
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { pipeline } = require('@xenova/transformers');

const MD_MODULE_ID = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const NOT_SIMILAR_BELOW = 0.45;   // a signal this far from the rest of its card is about something else
const COPY_FROM = 0.9;            // two signals this close are the same news
const TITLE_OFF_BELOW = 0.5;      // card title + summary this far from its signals does not describe them

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const lines = [];
const out = (l = '') => lines.push(l);
const say = (l = '') => { console.log(l); out(l); };

async function readAll(table, columns, filter, schema) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = (schema ? supabase.schema(schema) : supabase).from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

let embedder = null;
async function embedMany(texts) {
  if (!embedder) embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const vecs = [];
  for (let i = 0; i < texts.length; i++) {
    const o = await embedder(String(texts[i] || '').slice(0, 500), { pooling: 'mean', normalize: true });
    vecs.push(Array.from(o.data));
    if (i % 500 === 499) process.stdout.write(`\r  reading meaning of signals: ${i + 1}/${texts.length}`);
  }
  if (texts.length >= 500) console.log('');
  return vecs;
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const mean = (vs) => { const m = new Array(vs[0].length).fill(0); vs.forEach((v) => v.forEach((x, i) => { m[i] += x; })); const n = Math.sqrt(m.reduce((s, x) => s + x * x, 0)) || 1; return m.map((x) => x / n); };
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');

async function main() {
  say(`Market Dynamics card check (read only) - ${new Date().toISOString()}`);
  const clients = await readAll('clients', 'id, company_name, industry', null, 'admin');
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const signalNames = new Map((await readAll('signals', 'id, signal_name, submodule_id', (q) => q.eq('module_id', MD_MODULE_ID), 'admin')).map((s) => [s.id, s.signal_name]));
  const dimNames = new Map((await readAll('submodules', 'id, submodule_name', null, 'admin')).map((s) => [s.id, s.submodule_name]));

  const cards = (await readAll('market_insights', 'id, client_id, submodule_id, signal_id, title, summary, signal_count, relevance_level, last_enriched_at',
    (q) => q.eq('module_id', MD_MODULE_ID))).filter((c) => clientById.has(c.client_id));
  const sigs = (await readAll('market_dynamics_signals', 'id, client_id, signal_id, submodule_id, insight_id, signal_title, summary, organization, published_date',
    (q) => q.eq('module_id', MD_MODULE_ID))).filter((s) => clientById.has(s.client_id) && s.insight_id);
  say(`Live clients: ${clients.length} | cards: ${cards.length} | signals on cards: ${sigs.length}`);

  console.log('Reading the meaning of every signal and card (local model, no AI)...');
  const sigVec = await embedMany(sigs.map((s) => `${s.signal_title}. ${s.summary || ''}`));
  sigs.forEach((s, i) => { s.vec = sigVec[i]; });
  const cardVec = await embedMany(cards.map((c) => `${c.title}. ${c.summary || ''}`));
  cards.forEach((c, i) => { c.vec = cardVec[i]; });

  const byCard = new Map();
  for (const s of sigs) { if (!byCard.has(s.insight_id)) byCard.set(s.insight_id, []); byCard.get(s.insight_id).push(s); }

  const totals = { cards: 0, multi: 0, wrongCat: 0, wrongCatCards: 0, notSimilar: 0, notSimilarCards: 0, copies: 0, copyCards: 0, titleOff: 0, empty: 0, countMismatch: 0 };
  const per = new Map();   // client|dimension|signal -> counts
  const examples = { wrongCat: [], notSimilar: [], copies: [], titleOff: [] };

  for (const c of cards) {
    totals.cards++;
    const members = byCard.get(c.id) || [];
    const key = `${clientById.get(c.client_id).company_name} | ${dimNames.get(c.submodule_id) || c.submodule_id} | ${signalNames.get(c.signal_id) || c.signal_id || '(no sub-category)'}`;
    if (!per.has(key)) per.set(key, { cards: 0, bad: 0 });
    per.get(key).cards++;
    if (!members.length) { totals.empty++; continue; }
    if ((c.signal_count || 0) !== members.length) totals.countMismatch++;
    let bad = false;

    // 1. wrong category
    const wrong = members.filter((m) => m.signal_id && c.signal_id && m.signal_id !== c.signal_id);
    if (wrong.length) {
      bad = true; totals.wrongCatCards++; totals.wrongCat += wrong.length;
      if (examples.wrongCat.length < 25) examples.wrongCat.push(`  [${key}] card "${c.title}"\n      has: ${wrong.slice(0, 3).map((m) => `"${m.signal_title}" (${signalNames.get(m.signal_id) || m.signal_id})`).join('; ')}`);
    }

    if (members.length >= 2) {
      totals.multi++;
      const centre = mean(members.map((m) => m.vec));
      // 2. not similar to the rest of the card
      const odd = members.filter((m) => {
        const others = members.filter((o) => o !== m);
        return dot(m.vec, mean(others.map((o) => o.vec))) < NOT_SIMILAR_BELOW;
      });
      if (odd.length) {
        bad = true; totals.notSimilarCards++; totals.notSimilar += odd.length;
        if (examples.notSimilar.length < 25) examples.notSimilar.push(`  [${key}] card "${c.title}" (${members.length} signals)\n      odd one(s): ${odd.slice(0, 3).map((m) => `"${m.signal_title}"`).join('; ')}\n      e.g. others: ${members.filter((m) => !odd.includes(m)).slice(0, 2).map((m) => `"${m.signal_title}"`).join('; ')}`);
      }
      // 3. copies on the card
      let copyHere = 0;
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          if (norm(members[i].signal_title) === norm(members[j].signal_title) || dot(members[i].vec, members[j].vec) >= COPY_FROM) {
            copyHere++;
            if (examples.copies.length < 25) examples.copies.push(`  [${key}] "${members[i].signal_title}"  =  "${members[j].signal_title}"`);
          }
        }
      }
      if (copyHere) { bad = true; totals.copyCards++; totals.copies += copyHere; }
      // 4. title + summary vs the signals
      const fit = dot(c.vec, centre);
      if (fit < TITLE_OFF_BELOW) {
        bad = true; totals.titleOff++;
        if (examples.titleOff.length < 25) examples.titleOff.push(`  [${key}] card "${c.title}" (match ${fit.toFixed(2)})\n      signals: ${members.slice(0, 3).map((m) => `"${m.signal_title}"`).join('; ')}`);
      }
    }
    if (bad) per.get(key).bad++;
  }

  say('');
  say('SUMMARY');
  say(`  cards checked:                         ${totals.cards} (with 2+ signals: ${totals.multi}, with no signals: ${totals.empty})`);
  say(`  1. cards with a WRONG-CATEGORY signal:   ${totals.wrongCatCards} (${pct(totals.wrongCatCards, totals.cards)})   signals: ${totals.wrongCat}`);
  say(`  2. cards with a NOT-SIMILAR signal:      ${totals.notSimilarCards} (${pct(totals.notSimilarCards, totals.multi)} of cards with 2+)   signals: ${totals.notSimilar}`);
  say(`  3. cards with COPIES on them:            ${totals.copyCards} (${pct(totals.copyCards, totals.multi)} of cards with 2+)   copy pairs: ${totals.copies}`);
  say(`  4. cards whose TITLE does not fit:       ${totals.titleOff} (${pct(totals.titleOff, totals.multi)} of cards with 2+)`);
  say(`  card "signal count" different from the real number of signals: ${totals.countMismatch}`);
  out('');
  out('PER CLIENT | DIMENSION | SUB-CATEGORY: cards (cards with a problem)');
  [...per.entries()].sort().forEach(([k, v]) => out(`  ${k}: ${v.cards} (${v.bad})`));
  for (const [name, list] of [['1. WRONG CATEGORY (examples)', examples.wrongCat], ['2. NOT SIMILAR (examples)', examples.notSimilar],
    ['3. COPIES (examples)', examples.copies], ['4. TITLE DOES NOT FIT (examples)', examples.titleOff]]) {
    out(''); out(name); list.forEach((l) => out(l));
  }
  const dir = path.join(__dirname, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `checkMarketCards-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`);
  fs.writeFileSync(file, lines.join('\n'));
  console.log(`\nFull report: ${file}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(`Check stopped: ${e.message}`); process.exit(1); });
