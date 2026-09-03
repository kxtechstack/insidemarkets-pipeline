// Stress test with ~100 signals, matching CURRENT marketInsights.js logic:
// plain 0.70 threshold, no gray-zone LLM check.
// Signals are generated from templates across 4 submodules:
//   - duplicate clusters (2-3 articles about the SAME real event) -> SHOULD merge
//   - singleton events (same template shape, different company) -> should NOT merge with each other
// This specifically stress-tests whether same-sentence-structure-different-company
// cases produce false merges at volume.

const { pipeline } = require('@xenova/transformers');

const CARD_SIMILARITY_THRESHOLD = 0.70;

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return embedderPromise;
};
const embedText = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

const cosineSimilarity = (a, b) => {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const mean = (vectors) => {
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
};

// ── Seeded RNG so results are reproducible run to run ────────────────────
let seedState = 42;
const rand = () => {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const shuffleArr = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const companies = [
  'Remedy', 'Dolce Glow', 'Inglot', 'Merit', 'Saltair', 'Be Clinical', 'CiFLAVORS', 'Diamond Wipes',
  'Hello Klean', 'Rael', 'Phitku', 'Yepoda', 'Tarte Cosmetics', 'Beekman 1802', 'Ulta Beauty',
  'Noli', 'Cosmecca Korea', 'DOUGLAS Group', 'COSMAX', 'AmorePacific', 'Grupo Boticário', 'Natura&Co',
  'L\u2019Or\u00e9al', 'Sephora', 'LVMH', 'Estee Lauder', 'Shiseido', 'Kao Corp', 'Coty', 'Revlon',
  'Glossier', 'Fenty Beauty', 'Rare Beauty', 'Kylie Cosmetics', 'Charlotte Tilbury', 'Drunk Elephant',
  'Youth To The People', 'Summer Fridays', 'Tower 28', 'Merit Beauty', 'Ilia Beauty', 'Kosas',
  'Vacation Inc', 'Topicals', 'Non Gender Specific', 'Pattern Beauty', 'K18 Hair', 'Olaplex',
  'Living Proof', 'Function of Beauty', 'Prose', 'Curology', 'Nutrafol', 'Ouai Haircare',
];

const investors = ['L Catterton', 'CAVU Consumer Partners', 'TSG Consumer Partners', 'Avallon', 'KKR', 'River Associates', 'General Atlantic', 'Advent International'];

const investmentTemplates = [
  (c, i, amt) => `${c} closed a $${amt} million Series A led by ${i}. The capital will fund inventory, retail distribution, product innovation and team expansion.`,
  (c, i, amt) => `${i} has led a $${amt} million investment into ${c}, aiming to accelerate clinical research and retail distribution.`,
  (c, i, amt) => `${c} raised $${amt} million in growth funding backed by ${i}, reshaping product, supply, and go-to-market strategy.`,
];

const aiTemplates = [
  (c) => `${c} is deploying generative AI across its marketing and product functions to cut turnaround time and improve personalization.`,
  (c) => `${c}'s new AI-powered tool accelerates R&D timelines, turning weeks of research into minutes.`,
  (c) => `${c} partners with an AI vendor to build conversational try-on and product discovery tools for consumers.`,
];

const corporateTemplates = [
  (c1, c2) => `${c1} announced a strategic partnership with ${c2} to strengthen distribution across North America and Europe.`,
  (c1, c2) => `${c1} completed its acquisition of ${c2}, consolidating manufacturing capacity and expanding its supply chain footprint.`,
  (c1, c2) => `${c1} and ${c2} are merging operations to create a combined entity focused on sustainable beauty manufacturing.`,
];

const regTemplates = [
  (c) => `Regulators issued new labeling requirements for cosmetic ingredients, directly affecting ${c}'s product line across EU markets.`,
  (c) => `A new import compliance rule will require ${c} and other manufacturers to update packaging disclosures within 90 days.`,
  (c) => `${c} confirmed it is adjusting its supply chain to comply with updated chemical safety regulations in key export markets.`,
];

const usedCompanies = shuffleArr(companies);
let companyIdx = 0;
const nextCompany = () => usedCompanies[companyIdx++ % usedCompanies.length];

const signals = [];

// ── 15 duplicate clusters (2-3 articles each about the SAME event) — should MERGE ──
for (let k = 0; k < 15; k++) {
  const submodule = k % 2 === 0 ? 'Investment Activity' : 'AI Adoption';
  const company = nextCompany();
  const clusterSize = 2 + (k % 2); // alternates 2 or 3
  if (submodule === 'Investment Activity') {
    const investor = pick(investors);
    const amt = 5 + Math.floor(rand() * 45);
    for (let v = 0; v < clusterSize; v++) {
      const text = investmentTemplates[v % investmentTemplates.length](company, investor, amt);
      signals.push({ group: `DUP-${k}-${company}`, submodule, title: text.slice(0, 60), text });
    }
  } else {
    for (let v = 0; v < clusterSize; v++) {
      const text = aiTemplates[v % aiTemplates.length](company);
      signals.push({ group: `DUP-${k}-${company}`, submodule, title: text.slice(0, 60), text });
    }
  }
}

// ── ~65 singleton events — same template SHAPE but different company/facts — should NOT merge with each other ──
const singletonSubmodules = ['Investment Activity', 'AI Adoption', 'Corporate Activity', 'Regulatory & Compliance'];
for (let s = 0; s < 65; s++) {
  const submodule = singletonSubmodules[s % singletonSubmodules.length];
  const company = nextCompany();
  let text;
  if (submodule === 'Investment Activity') {
    const investor = pick(investors);
    const amt = 3 + Math.floor(rand() * 60);
    text = investmentTemplates[Math.floor(rand() * investmentTemplates.length)](company, investor, amt);
  } else if (submodule === 'AI Adoption') {
    text = aiTemplates[Math.floor(rand() * aiTemplates.length)](company);
  } else if (submodule === 'Corporate Activity') {
    const company2 = nextCompany();
    text = corporateTemplates[Math.floor(rand() * corporateTemplates.length)](company, company2);
  } else {
    text = regTemplates[Math.floor(rand() * regTemplates.length)](company);
  }
  signals.push({ group: `SINGLE-${s}-${company}`, submodule, title: text.slice(0, 60), text });
}

const ordered = shuffleArr(signals); // simulate real-world arrival order

console.log(`Total signals to process: ${ordered.length}\n`);

(async () => {
  const cardsBySubmodule = {};
  let nextCardId = 1;
  const log = [];

  for (const sig of ordered) {
    const vec = await embedText(sig.text.slice(0, 4000));
    const bucket = (cardsBySubmodule[sig.submodule] ||= []);

    let best = null;
    for (const card of bucket) {
      const score = cosineSimilarity(vec, card.centroid);
      if (!best || score > best.score) best = { card, score };
    }

    if (best && best.score >= CARD_SIMILARITY_THRESHOLD) {
      best.card.members.push({ title: sig.title, group: sig.group, vec });
      best.card.centroid = mean(best.card.members.map(m => m.vec));
      log.push({ title: sig.title, group: sig.group, action: 'MERGED', cardId: best.card.id, score: best.score });
    } else {
      const card = { id: nextCardId++, members: [{ title: sig.title, group: sig.group, vec }], centroid: vec };
      bucket.push(card);
      log.push({ title: sig.title, group: sig.group, action: 'NEW CARD', cardId: card.id, score: best ? best.score : null });
    }
  }

  console.log('=== DECISION LOG ===\n');
  for (const l of log) {
    const scoreStr = l.score !== null ? l.score.toFixed(3) : '  —  ';
    console.log(`[score ${scoreStr}] ${l.action.padEnd(9)} card#${l.cardId}  "${l.title}"  (group: ${l.group})`);
  }

  console.log('\n=== FINAL CARDS ===\n');
  let totalCards = 0;
  let mixedCards = 0;
  let singleSignalCards = 0;
  let maxCardSize = 0;

  for (const [submodule, cards] of Object.entries(cardsBySubmodule)) {
    console.log(`--- ${submodule} (${cards.length} cards) ---`);
    for (const card of cards) {
      totalCards++;
      const groups = new Set(card.members.map(m => m.group.split('-').slice(0, 2).join('-'))); // group by cluster prefix, ignore company suffix
      const mixed = groups.size > 1 ? '  ⚠ MIXED' : '';
      if (groups.size > 1) mixedCards++;
      if (card.members.length === 1) singleSignalCards++;
      if (card.members.length > maxCardSize) maxCardSize = card.members.length;
      console.log(`  Card #${card.id} (${card.members.length} signal${card.members.length > 1 ? 's' : ''})${mixed}`);
      for (const m of card.members) console.log(`     - [${m.group}] ${m.title}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total signals processed: ${ordered.length}`);
  console.log(`Total cards created: ${totalCards}`);
  console.log(`Cards with MIXED (wrongly merged) groups: ${mixedCards}`);
  console.log(`Single-signal cards: ${singleSignalCards}`);
  console.log(`Largest card size: ${maxCardSize}`);
})();