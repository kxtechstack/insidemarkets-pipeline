/**
 * modules/dynamicRag/buildWorkflow.js
 *
 * STEP 7 of the Decision Intelligence chat (manager's doc: "Dynamic workflow
 * construction").
 *
 * Step 6 said WHAT information each goal needs and WHAT analysis to do.
 * Step 7 turns that into a numbered list of real jobs from the job list
 * (capabilityRegistry.js): T1, T2, T3... Each job says what it gets and which
 * earlier jobs it waits for. Nothing runs here: Step 8 checks the list and
 * Step 9 runs it.
 *
 * Who does what (the AI proposes, the code decides):
 *   The AI  writes the SEARCHES: what to look for in short words, which
 *           search is for which part of the plan, and, for a comparison of
 *           topics ("online vs offline"), the sides.
 *   The code
 *     - checks every search (known part, plain words, no date words)
 *     - adds the filters from Step 5 to every search: dates, places,
 *       companies. The AI can never set or change a filter.
 *     - gives a comparison one search per side (places, companies, own
 *       company, or the dates the user named)
 *     - builds the analysis jobs from the Step 6 plan, always in the same
 *       order (facts / groups -> patterns -> risks -> compare -> gaps ->
 *       opportunities -> summary), each one fed with the right earlier results
 *     - adds the evidence check once, at the end
 *     - keeps the limits (jobs, searches, AI calls). Anything cut is
 *       recorded and the answer can say what was left out.
 *   If the AI gives no usable searches, the code writes one search per part
 *   from its "information needed" (built_by_code). The question still goes on.
 *
 * Nothing in this file is about one client.
 */

const { callLLM } = require('../llmClient');
const { requirePrompt } = require('../promptStore');
const { ChatError } = require('./chatError');
const { WORKFLOW_PROMPT_ID } = require('./chatConfig');
const { getCapability, RUN_LIMITS, MODULES, GOAL_KEY_JOB } = require('./capabilityRegistry');
const { parseJsonLoose, withoutDateWords, withoutMetaNeeds } = require('./planTasks');
const { standardPlace, PLACES } = require('../placeNames');

const MAX_ATTEMPTS = 2;               // ask the AI at most twice
const MAX_SEARCHES_PER_PART = 3;
const MAX_WORDS_CHARS = 150;           // search words
const MAX_JOINED_CHARS = 300;          // joined search words (the search job takes up to 300)
const MAX_SIDE_CHARS = 80;
const MAX_SIDES = 4;                   // compare takes 2 to 4 sides

// The order of analysis jobs inside one part of the plan.
const ANALYSIS_ORDER = [
  'extract_facts', 'cluster', 'identify_patterns', 'analyse_risks',
  'compare', 'identify_gaps', 'discover_opportunities', 'summarise',
];
// Jobs that only help; they are the first to go when a limit is reached
// (unless one is the key job of its goal).
const HELPER_JOBS = ['extract_facts', 'cluster', 'summarise'];

const GOAL_LABELS = {
  fact_lookup: 'Facts', list: 'Latest items', company_profile: 'Company profile', trends: 'Trends',
  comparison: 'Comparison', opportunities: 'Opportunities', competitor_analysis: 'Competitor analysis',
  market_entry: 'Market entry', feasibility: 'Feasibility', forecast: 'Outlook', risks: 'Risks',
  campaign_ideas: 'Campaign ideas', strategy: 'Strategy', framework: 'Framework analysis',
};

const cleanText = (v, max) => String(v == null ? '' : v).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const same = (a, b) => cleanText(a, 300).toLowerCase() === cleanText(b, 300).toLowerCase();
const uniq = (list) => [...new Set(list)];

// AI calls a job may make (worst case, for the limit).
const aiCost = (jobId) => {
  const cap = getCapability(jobId);
  return cap && cap.uses_ai !== 'no' ? 1 : 0;
};

// ═════════════════════════════════════════════════════════════════════════
// 1. Things the code works out from the question (no AI — easy to test)
// ═════════════════════════════════════════════════════════════════════════

// Which modules a LIST question names. Searches by meaning always look in
// all 4 modules; only the exact table read ("latest ...") is narrowed, and
// only when the question names the kind of news.
const MODULE_WORDS = [
  ['policy', /\b(polic(y|ies)|regulat\w*|compliance|laws?|rules?|alerts?)\b/i],
  ['competitor', /\b(competit\w*|rivals?|competitive radar)\b/i],
  ['market', /\b(market dynamics|market signals?|market moves?)\b/i],
  ['outlook', /\b(outlook|forward outlook)\b/i],
];
function modulesNamed(question, understood) {
  const q = String(question || '');
  const named = MODULE_WORDS.filter(([, re]) => re.test(q)).map(([m]) => m);
  if (understood && understood.all_competitors && !named.includes('competitor')) named.push('competitor');
  return MODULES.filter((m) => named.includes(m));
}

// "critical alerts", "high impact signals" -> only those impact levels.
function impactAsked(question) {
  const q = String(question || '').toLowerCase();
  if (/\bcritical\b/.test(q) && !/\bhigh\b/.test(q)) return ['Critical'];
  if (/\b(critical|high[\s-]impact|high priority|important|major|big)\b/.test(q)) return ['Critical', 'High'];
  return null;
}

// Fixed headings for SWOT / PESTLE / Five Forces.
function headingsFor(question) {
  const q = String(question || '').toLowerCase();
  if (/\bswot\b/.test(q)) return ['Strengths', 'Weaknesses', 'Opportunities', 'Threats'];
  if (/\bpest(le|el)?\b/.test(q)) return ['Political', 'Economic', 'Social', 'Technological', 'Legal', 'Environmental'];
  if (/\b(five|5)\s+forces\b/.test(q)) {
    return ['Competitive rivalry', 'Threat of new entrants', 'Threat of substitutes', 'Buyer power', 'Supplier power'];
  }
  return null;
}

// Words that say "the newest things", not WHAT to look for.
const LATEST_WORDS = new Set([
  'latest', 'newest', 'new', 'recent', 'news', 'update', 'updates', 'alert', 'alerts', 'signal', 'signals',
  'highlight', 'highlights', 'change', 'changes', 'move', 'moves', 'announcement', 'announcements', 'activity',
  'activities', 'development', 'developments', 'event', 'events', 'item', 'items', 'important', 'critical',
  'high', 'impact', 'what', 'happened', 'all', 'any', 'the', 'of', 'in', 'for', 'about', 'and', 'our', 'my',
  'client', 'business', 'company', 'market', 'industry', 'policy', 'policies', 'competitor', 'competitors',
  'launch', 'launches', 'regulatory', 'regulation', 'regulations', 'rules', 'dynamics',
  'give', 'me', 'show', 'list', 'which', 'are', 'is', 'was', 'were', 'there', 'from', 'last', 'this', 'to', 'get',
  'tell', 'please', 'summarise', 'summarize', 'summary', 'brief', 'briefing', 'today', 'we', 'us', 'i', 'my',
  'sector', 'happening', 'going', 'on', 'did', 'do', 'anything', 'everything', 'know', 'should', 'team', 'big',
  'announce', 'announced', 'changed', 'launched', 'released', 'moved', 'happen', 'new', 'whats', 'has', 'have', 'been',
  'recently', 'lately', 'currently', 'now', 'so', 'far',
]);
// ignore: words that are filters, not topics (the client industry, places, company names)
const onlyLatestWords = (text, ignore = []) => {
  const skip = new Set(ignore.flatMap((x) => String(x).toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(Boolean));
  const words = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter((w) => w.length >= 2 && !skip.has(w));
  return words.every((w) => LATEST_WORDS.has(w));
};

// Is the QUESTION only asking for "the newest items" (no real topic)?
// Decided from the user's own words, not the AI's: dates, places, company
// names and the client industry are filters, so they do not count as a topic.
// "Give me all high impact signals from last month" -> yes
// "List all funding rounds in our industry this quarter" -> no (funding rounds)
function asksOnlyForLatest(question, understood) {
  const text = withoutDateWords([String(question || '')], [])[0] || '';
  const ignore = [
    ...(understood.places || []),
    ...(understood.companies || []).flatMap((c) => [c.name, c.matched && c.matched.name]),
    ...(understood.industries || []),
    (understood.client && understood.client.industry) || '',
    (understood.client && understood.client.company_name) || '',
  ].filter(Boolean);
  return onlyLatestWords(text, ignore);
}

// The sides of a comparison that the code can name for sure, with the
// filters each side gets. null = the code cannot tell (a comparison of
// topics, "online vs offline": the AI names those sides).
function codeSides(understood, aiSideNames = null) {
  if (understood.compare_sides !== undefined) return understood.compare_sides;   // already chosen
  const places = understood.places || [];
  const companies = (understood.companies || []).map((c) => (c.matched && c.matched.name) || c.name);
  const own = understood.client && understood.client.company_name;
  const ranges = (understood.time && understood.time.ranges) || [];
  const companySides = companies.length >= 2 ? companies.slice(0, MAX_SIDES).map((c) => ({ label: c, companies: [c] })) : null;
  const placeSides = places.length >= 2 ? places.slice(0, MAX_SIDES).map((p) => ({ label: p, countries: [p] })) : null;
  // Both 2+ companies and 2+ places: the question decides what is compared.
  // The AI names the sides; the code checks they are one of the two choices.
  // ("compare Lancôme and Estée Lauder in UAE and Saudi" -> the companies,
  //  "compare the Saudi and UAE markets for Lancôme and Estée Lauder" -> the places)
  if (companySides && placeSides) {
    const named = (aiSideNames || []).filter(Boolean);
    const hits = (list) => named.filter((n) => list.some((x) => sameSide(n, x.label))).length;
    return hits(placeSides) > hits(companySides) ? placeSides : companySides;
  }
  if (companySides) return companySides;
  if (companies.length === 1 && understood.about_own_business && own && !same(companies[0], own)) {
    return [{ label: companies[0], companies: [companies[0]] }, { label: own, companies: [own] }];
  }
  if (placeSides) return placeSides;
  // "How do we stand against our competitors?": own company vs the competitor list
  const rivals = (understood.client && understood.client.competitors) || [];
  const onlyOwn = companies.length === 0 || (companies.length === 1 && own && same(companies[0], own));
  if (understood.all_competitors && understood.about_own_business && own && rivals.length && onlyOwn) {
    return [{ label: own, companies: [own] }, { label: 'Competitors', companies: rivals.slice(0, 20) }];
  }
  if (ranges.length >= 2) {
    return ranges.slice(0, MAX_SIDES).map((r) => ({ label: r.text, date_from: r.from, date_to: r.to }));
  }
  return null;
}

// When the question names 2+ companies AND 2+ places, the AI is shown both
// choices; otherwise the fixed sides (or none).
function sideChoices(understood) {
  const places = understood.places || [];
  const companies = (understood.companies || []).map((c) => (c.matched && c.matched.name) || c.name);
  if (companies.length >= 2 && places.length >= 2) return [companies.slice(0, MAX_SIDES), places.slice(0, MAX_SIDES)];
  return null;
}

// Is this side the same as that one? ("UAE" = "United Arab Emirates")
// lower case, no accents, no punctuation: "Estée Lauder" -> "estee lauder"
const plain = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
const OWN_SIDE_WORDS = /\b(our|we|us|my|client|own company|our company|our brand)\b/;

// Is this side the same as that one? ("UAE" = "United Arab Emirates",
// "Estee Lauder" = "Estée Lauder", "our company" = the client's own company)
function sameSide(a, b, ownName = null) {
  if (!a || !b) return false;
  const x = plain(a);
  const y = plain(b);
  if (x === y) return true;
  const pa = standardPlace(a);
  const pb = standardPlace(b);
  if (pa && pb && same(pa, pb)) return true;
  if (ownName && plain(ownName) === y && OWN_SIDE_WORDS.test(x)) return true;
  return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x));
}

// Which fixed side do these search words talk about? One side named -> that
// side. None or several -> null.
function sideNamedIn(words, sides, ownName) {
  const w = ` ${plain(words)} `;
  const hits = sides.filter((s) => {
    const label = plain(s.label);
    const first = label.split(' ')[0];
    if (w.includes(` ${label} `)) return true;
    if (first.length >= 4 && first !== 'the' && w.includes(` ${first} `)) return true;
    return Boolean(ownName && plain(ownName) === label && OWN_SIDE_WORDS.test(w));
  });
  return hits.length === 1 ? hits[0].label : null;
}

// Search words for one side, without the names of the OTHER sides:
// for the Lancôme side, "Estee Lauder company profile" -> "company profile".
function wordsForSide(words, sides, label, ownName) {
  let w = ` ${plain(words)} `;
  for (const s of sides) {
    if (s.label === label) continue;
    const other = plain(s.label);
    // a place side is also written in short ("UAE", "Saudi"); longest
    // first, so "saudi arabia" goes whole, not "saudi" leaving "arabia"
    const names = uniq([other, ...(PLACES[s.label] || []).map(plain)]).sort((a, b) => b.length - a.length);
    for (const n of names) w = w.split(` ${n} `).join(' ');
    const first = other.split(' ')[0];
    if (first.length >= 4 && first !== 'the') w = w.split(` ${first} `).join(' ');
    if (ownName && plain(ownName) === other) w = w.replace(/\b(our|client|own) (company|brand|business)\b|\b(our|client)\b/g, ' ');
  }
  return tidyJoins(w);
}

// After names are taken out, joining words are left hanging:
// "market gaps in uae and and and" -> "market gaps in uae",
// "vs dior price comparison" -> "dior price comparison".
// A run of joining words keeps only its first one; none at either end.
const JOIN_WORDS = new Set(['and', 'or', 'vs', 'versus', 'with', 'between', 'compared', 'to', 'than', 'against', 'in', 'of', 'for', 'on', 'the', 'from']);
function tidyJoins(text) {
  const out = [];
  for (const t of String(text || '').split(/\s+/).filter(Boolean)) {
    if (JOIN_WORDS.has(t) && (out.length === 0 || JOIN_WORDS.has(out[out.length - 1]))) continue;
    out.push(t);
  }
  while (out.length && JOIN_WORDS.has(out[out.length - 1])) out.pop();
  return out.join(' ');
}

// A part that has a "compare" job needs sides (a comparison, or a
// competitor analysis that compares).
const comparesSides = (part) => part.goal === 'comparison' || (part.analysis || []).includes('compare');

// ═════════════════════════════════════════════════════════════════════════
// 2. What the AI is given (data only — the instruction is in the prompts table)
// ═════════════════════════════════════════════════════════════════════════
function buildMessage(question, understood, plan) {
  const sides = codeSides(understood);
  const parts = plan.requirements.map((r) => {
    const lines = [
      `${r.requirement_id}: goal ${r.goal}`,
      `  information needed: ${(r.information_needed || []).join('; ') || '-'}`,
    ];
    if (comparesSides(r) && sideChoices(understood)) {
      const [a, b] = sideChoices(understood);
      lines.push(`  SIDES (choose ONE of these two sets, the one the question compares, one search per side, the side name in "side"): ${a.join(' | ')}  OR  ${b.join(' | ')}`);
    } else if (comparesSides(r)) {
      lines.push(sides
        ? `  SIDES (fixed, write one search per side, put the side name in "side"): ${sides.map((s) => s.label).join(' | ')}`
        : '  SIDES: not fixed. Name the 2 to 4 things compared in "side", one search per side.');
    }
    return lines.join('\n');
  });
  return [
    `QUESTION:\n"""\n${question}\n"""`,
    `PARTS OF THE PLAN:\n${parts.join('\n')}`,
  ].join('\n\n');
}

// ═════════════════════════════════════════════════════════════════════════
// 3. Reading the AI's searches (no AI, no database — easy to test)
// ═════════════════════════════════════════════════════════════════════════
/**
 * @returns { searches, problem, removed }
 *   searches  [{ for: ['IR1'], words, side }] or null if nothing usable
 *   problem   why it cannot be used, in words the AI can act on
 */
function checkAiSearches(replyText, plan, understood) {
  const removed = [];
  const text = String(replyText || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1) return { searches: null, problem: 'there is no JSON object in it', removed };
  const p = parseJsonLoose(text.slice(start, end + 1)) || parseJsonLoose(text.slice(start).trim());
  if (!p || typeof p !== 'object') return { searches: null, problem: 'the JSON is broken', removed };
  if (!Array.isArray(p.searches)) return { searches: null, problem: 'it has no "searches" list', removed };

  const partIds = plan.requirements.map((r) => r.requirement_id);
  const partById = new Map(plan.requirements.map((r) => [r.requirement_id, r]));
  // the side names the AI wrote (used only to choose companies or places)
  const sideNames = p.searches.filter((x) => x && x.side).map((x) => String(x.side));
  const sides = codeSides(understood, sideNames);
  const out = [];

  for (const raw of p.searches) {
    if (!raw || typeof raw !== 'object') continue;
    const forList = (Array.isArray(raw.for) ? raw.for : [raw.for])
      .map((x) => String(x || '').trim().toUpperCase())
      .filter((x) => partIds.includes(x));
    const wordsRaw = cleanText(raw.words || raw.query, MAX_WORDS_CHARS);
    if (forList.length === 0) {
      removed.push({ what: 'search', value: wordsRaw || '(no words)', why: 'not for any part of the plan' });
      continue;
    }
    // plain words only: no date words, not just "dates" / "source"
    const cleaned = withoutMetaNeeds(withoutDateWords(wordsRaw ? [wordsRaw] : [], removed), removed);
    const words = cleaned[0] || '';
    if (!words) {
      removed.push({ what: 'search', value: wordsRaw || '(no words)', why: 'no words left to search for' });
      continue;
    }
    let side = raw.side == null ? null : cleanText(raw.side, MAX_SIDE_CHARS) || null;
    const forComparison = forList.some((id) => comparesSides(partById.get(id)));
    const ownName = understood.client && understood.client.company_name;
    // the AI often names the side in the words, not in "side"
    if (!side && forComparison && sides) side = sideNamedIn(words, sides, ownName);
    if (side && forComparison && sides) {
      // a fixed side: it must be one of them (written the standard way)
      const match = sides.find((s) => sameSide(side, s.label, ownName));
      if (!match) {
        removed.push({ what: 'search side', value: side, why: `not one of the sides (${sides.map((s) => s.label).join(', ')})` });
        side = null;
      } else {
        side = match.label;
      }
    }
    if (side && !forComparison) side = null;   // only a comparison has sides
    // no fixed sides: a side the AI names must be something the plan asks
    // about ("online" in "online beauty sales"), never an invented example
    if (side && forComparison && !sides) {
      const asked = ` ${plain(forList.flatMap((id) => partById.get(id).information_needed || []).join(' '))} ${plain([...(understood.topics || []), ...(understood.products || []), ...(understood.industries || []),
        ...(understood.places || []), ...(understood.companies || []).flatMap((c) => [c.name, c.matched && c.matched.name])].filter(Boolean).join(' '))} `;
      const sideWords = plain(side).split(' ').filter((x) => x.length >= 3 && !JOIN_WORDS.has(x));
      if (!sideWords.length || !sideWords.every((x) => asked.includes(` ${x} `))) {
        removed.push({ what: 'search side', value: side, why: 'not something the question or the plan talks about' });
        side = null;
      }
    }

    const twin = out.find((o) => same(o.words, words) && (o.side || '') === (side || ''));
    if (twin) {
      for (const id of forList) if (!twin.for.includes(id)) twin.for.push(id);
      continue;
    }
    out.push({ for: uniq(forList), words, side });
  }
  if (out.length === 0) return { searches: null, problem: 'none of its searches can be used (each needs "for" with a part id like IR1 and "words")', removed };

  const missing = partIds.filter((id) => !out.some((s) => s.for.includes(id)));
  return {
    searches: out,
    problem: missing.length ? `these parts have no search: ${missing.join(', ')}` : null,
    removed,
    side_names: sideNames,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 4. Building the workflow (no AI — easy to test)
// ═════════════════════════════════════════════════════════════════════════
// Search words made by code from a part's "information needed".
function wordsFromNeeds(part) {
  const needs = part.information_needed || [];
  const text = needs.slice(0, 3).join(', ');
  return cleanText(text || GOAL_LABELS[part.goal] || part.goal, MAX_WORDS_CHARS);
}

// Several searches become one: their words joined (each kept once), for all
// their parts. Used when one side got several searches, or a part has more
// searches than the limits allow. Nothing asked for is lost.
function mergeSearches(list) {
  const words = [];
  for (const s of list) for (const w of String(s.words).split(/\s*,\s*/)) if (w && !words.some((x) => same(x, w))) words.push(w);
  let text = '';
  for (const w of words) {
    const next = text ? `${text}, ${w}` : w;
    if (next.length > MAX_JOINED_CHARS) break;
    text = next;
  }
  return {
    for: uniq(list.flatMap((s) => s.for)),
    words: text || list[0].words,
    side: list[0].side || null,
    added_by_code: list.some((s) => s.added_by_code),
    merged: list.length,
  };
}
const replaceIn = (searches, oldOnes, merged) => {
  const at = searches.indexOf(oldOnes[0]);
  const rest = searches.filter((s) => !oldOnes.includes(s));
  rest.splice(Math.min(at, rest.length), 0, merged);
  return rest;
};

/**
 * Makes sure every part has its searches, and every comparison its sides.
 * @returns list of searches [{ for, words, side, sideFilter, added_by_code? }]
 */
function completeSearches(aiSearches, plan, understood, notes) {
  let searches = (aiSearches || []).map((s) => ({ ...s, for: [...s.for] }));
  const sides = codeSides(understood);

  for (const part of plan.requirements) {
    const id = part.requirement_id;
    const mine = () => searches.filter((s) => s.for.includes(id));

    if (comparesSides(part)) {
      // ONE search per side: several searches for the same side are joined
      for (const label of uniq(mine().filter((s) => s.side).map((s) => s.side))) {
        const same_ = mine().filter((s) => s.side === label);
        if (same_.length > 1) {
          searches = replaceIn(searches, same_, mergeSearches(same_));
          notes.push(`${id}: ${same_.length} searches for the side "${label}" joined into one (one search per side)`);
        }
      }
      if (sides) {
        // ONE search per fixed side. A search with no side (only for this
        // comparison) gives its words to EVERY side, without the other sides'
        // names: for Lancôme, "Estee Lauder pricing" -> "pricing". A side the
        // AI forgot gets its words the same way. Nothing asked for is lost.
        const ownName = understood.client && understood.client.company_name;
        // (a search shared with other parts is given out too, when every
        // part it serves compares the same sides)
        const sideless = mine().filter((s) => !s.side && s.for.every((f) => {
          const r = plan.requirements.find((x) => x.requirement_id === f);
          return r && comparesSides(r);
        }));
        const sideWords = (label) => {
          const fromSideless = sideless.map((s) => wordsForSide(s.words, sides, label, ownName)).filter(Boolean);
          return fromSideless.length ? mergeSearches(fromSideless.map((w) => ({ for: [id], words: w }))).words : '';
        };
        for (const side of sides) {
          const target = searches.find((x) => x.for.includes(id) && x.side === side.label);
          const extra = sideWords(side.label);
          if (target) {
            if (extra) {
              const forAll = uniq([...target.for, ...sideless.flatMap((x) => x.for)]);
              searches[searches.indexOf(target)] = { ...mergeSearches([target, { ...target, words: extra }]), side: side.label, for: forAll };
            }
            continue;
          }
          const other = mine().find((x) => x.side);
          const words = extra || (other && wordsForSide(other.words, sides, side.label, ownName)) || wordsFromNeeds(part);
          searches.push({ for: [id], words, side: side.label, added_by_code: true });
          notes.push(`${id}: search for the side "${side.label}" added by code`);
        }
        for (const s of sideless) {
          searches.splice(searches.indexOf(s), 1);
          notes.push(`${id}: search "${s.words}" had no side: its words were given to each side's search`);
        }
        // a side's search never names another side ("Lancôme vs Estee Lauder
        // pricing" for the Lancôme side -> "lancome pricing")
        for (const x of mine().filter((m) => m.side)) {
          const cleaned = wordsForSide(x.words, sides, x.side, ownName);
          if (cleaned && cleaned !== plain(x.words)) {
            searches[searches.indexOf(x)] = { ...x, words: cleaned };
            notes.push(`${id}: other sides' names taken out of the "${x.side}" search`);
          }
        }
      } else {
        // Sides named by the AI (the question names no 2 places / companies /
        // dates): two names for the same thing are ONE side ("UAE retail" and
        // "UAE retail market"). Fewer than 2 real sides = nothing to compare:
        // the part is summarised instead (said in the notes), sides are never
        // invented from the "information needed".
        const named = uniq(mine().filter((s) => s.side).map((s) => s.side));
        for (const a of named) {
          for (const b of named) {
            if (a === b || !mine().some((x) => x.side === b)) continue;
            const pa = plain(a);
            const pb = plain(b);
            if (pa.length <= pb.length && (` ${pb} `).includes(` ${pa} `)) {
              for (const x of mine().filter((m) => m.side === b)) searches[searches.indexOf(x)] = { ...x, side: a };
              notes.push(`${id}: the sides "${a}" and "${b}" are the same thing, so they are one side`);
            }
          }
        }
        for (const label of uniq(mine().filter((x) => x.side).map((x) => x.side))) {
          const same_ = mine().filter((x) => x.side === label);
          if (same_.length > 1) searches = replaceIn(searches, same_, mergeSearches(same_));
        }
        const left = uniq(mine().filter((x) => x.side).map((x) => x.side));
        if (left.length < 2) {
          for (const x of mine().filter((m) => m.side)) searches[searches.indexOf(x)] = { ...x, side: null };
        }
      }
    }

    if (mine().length === 0) {
      searches.push({ for: [id], words: wordsFromNeeds(part), side: null, added_by_code: true });
      notes.push(`${id}: no search from the AI, one search made from its information needed (added by code)`);
    }
    // at most a few searches per part: the extra ones (only for this part,
    // no side) are joined into the last kept one, so nothing asked for is lost
    const free = mine().filter((s) => !s.side && s.for.length === 1);
    const room = Math.max(1, MAX_SEARCHES_PER_PART - mine().filter((s) => s.side || s.for.length > 1).length);
    if (free.length > room) {
      const join = free.slice(room - 1);
      searches = replaceIn(searches, join, mergeSearches(join));
      notes.push(`${id}: ${join.length} searches joined into one (at most ${MAX_SEARCHES_PER_PART} searches for one part)`);
    }
  }
  return searches;
}

/**
 * The search job with its filters. Filters come from Step 5 only.
 */
// ── Which companies / places does a search name? ─────────────────────────
// A company is named by its name as matched ("Estée Lauder"), as the user
// typed it ("estee", "lancme"), or by its first word; the client's own
// company also by "our company" / "client".
function companyKeys(c, ownName) {
  const keys = [(c.matched && c.matched.name) || c.name, c.name].filter(Boolean).map(plain);
  const first = keys.map((k) => k.split(' ').find((w) => w !== 'the')).filter((w) => w && w.length >= 3);
  return { filter: (c.matched && c.matched.name) || c.name, keys: uniq([...keys, ...first]), own: Boolean(ownName && keys.includes(plain(ownName))) };
}
function companiesNamedIn(words, understood) {
  const own = understood.client && understood.client.company_name;
  const w = ` ${plain(words)} `;
  return (understood.companies || []).map((c) => companyKeys(c, own))
    .filter((k) => k.keys.some((x) => w.includes(` ${x} `)) || (k.own && OWN_SIDE_WORDS.test(w)))
    .map((k) => k.filter);
}
function placesNamedIn(words, understood) {
  const places = understood.places || [];
  const tokens = plain(words).split(' ').filter(Boolean);
  const raw = String(words || '').split(/[^A-Za-z]+/).filter(Boolean);
  const found = new Set();
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const phrase = tokens.slice(i, i + n).join(' ');
      if (n === 1 && phrase.length <= 3 && !(raw[i] && /^[A-Z]+$/.test(raw[i]))) continue;   // "UK" yes, "in" no
      const std = standardPlace(phrase);
      for (const p of places) if (std && same(std, p)) found.add(p);
    }
  }
  return places.filter((p) => found.has(p));
}

// Goals that are about the named companies themselves.
const COMPANY_GOALS = ['fact_lookup', 'company_profile', 'competitor_analysis', 'framework', 'list'];
// Does the search name another subject of the question (a product, topic
// or industry from Step 5)? All its main words must be there.
function namesOtherSubject(words, understood) {
  const w = ` ${plain(words)} `;
  const subjects = [...(understood.products || []), ...(understood.topics || []), ...(understood.industries || [])];
  return subjects.some((s) => {
    const main = plain(s).split(' ').filter((x) => x.length >= 4);
    return main.length > 0 && main.every((x) => w.includes(` ${x} `));
  });
}

// The dates a search uses. Step 5 dates, but a search can only find news
// up to today: "next year" (all in the future) -> the last 12 months up to
// today; "this year" -> from 1 January up to today.
const FUTURE_LOOKBACK_MONTHS = 12;
function searchDates(from, to, today) {
  if (!from && !to) return { from: null, to: null, future: false };
  if (!today) return { from, to, future: false };
  if (from && from > today) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - FUTURE_LOOKBACK_MONTHS);
    return { from: d.toISOString().slice(0, 10), to: today, future: true };
  }
  return { from, to: to && to > today ? today : to, future: false };
}
// "today" as YYYY-MM-DD text (Step 5 may give a date object)
const todayOf = (understood) => {
  const t = understood.today;
  if (t instanceof Date && !Number.isNaN(t.getTime())) return t.toISOString().slice(0, 10);
  if (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
};

/**
 * One search -> one search job, with the filters from Step 5:
 *   - a search that names some of the Step 5 companies looks only at those
 *     ("Lancme launches" -> Lancôme). A search that names none looks at all
 *     of them, EXCEPT when other searches name companies and the part also
 *     needs something that is not about them ("Korean beauty brands in
 *     India" next to "Shiseido and YSL launches"): then it is about that
 *     other thing, and has no company filter.
 *   - a search that names some of the Step 5 places looks only there; one
 *     that names none looks in all of them (places are the whole scope).
 *   - a fixed side narrows its own search to that side.
 */
function searchTask(search, plan, understood, question, allSearches = [search]) {
  const parts = plan.requirements.filter((r) => search.for.includes(r.requirement_id));
  const allList = parts.length > 0 && parts.every((r) => r.goal === 'list');
  const named = modulesNamed(question, understood);
  const exactRead = allList && (named.length > 0 || asksOnlyForLatest(question, understood));

  const time = understood.time;
  const own = understood.client && understood.client.company_name;
  let companies = (understood.companies || []).map((c) => (c.matched && c.matched.name) || c.name);
  let filterWhy = null;
  if (companies.length && !search.side) {
    const named = companiesNamedIn(search.words, understood);
    if (named.length) {
      if (named.length < companies.length) filterWhy = `companies: only ${named.join(', ')} (named in the search)`;
      companies = named;
    } else {
      const othersName = allSearches.some((x) => x !== search && !x.side && companiesNamedIn(x.words, understood).length);
      const needNotAboutThem = parts.some((r) => (r.information_needed || []).some((n) => companiesNamedIn(n, understood).length === 0));
      // ...and the search really is about something else: it names another
      // subject of the question ("Korean beauty brands"), or the goal is not
      // about the companies themselves (trends, risks, strategy...).
      // "How many employees does Emirates NBD have?" -> "staff size" is still
      // about Emirates NBD.
      const otherSubject = namesOtherSubject(search.words, understood);
      const companyGoal = parts.every((r) => COMPANY_GOALS.includes(r.goal));
      if (othersName && needNotAboutThem && (otherSubject || !companyGoal)) {
        companies = [];
        filterWhy = 'companies: none (this search is about something else in the question, other searches cover the companies)';
      } else if (own && companies.some((c) => same(c, own))) {
        // the client's own company is a filter only for a search about it:
        // "Ramadan campaign ideas for our brand" -> competitor campaigns and
        // consumer signals are NOT news about our own company
        const allAboutOwn = parts.every((r) => (r.information_needed || []).length > 0 &&
          (r.information_needed || []).every((n) => companiesNamedIn(n, understood).some((c) => same(c, own))));
        if (!allAboutOwn) {
          companies = companies.filter((c) => !same(c, own));
          filterWhy = `companies: ${companies.length ? companies.join(', ') : 'none'} (the search is not about ${own} itself)`;
        }
      }
    }
  }
  if (companies.length === 0 && (understood.companies || []).length === 0 && understood.all_competitors) {
    companies = (understood.client && understood.client.competitors) || [];
  }
  let countries = [...(understood.places || [])];
  if (countries.length > 1 && !search.side) {
    const named = placesNamedIn(search.words, understood);
    if (named.length && named.length < countries.length) {
      countries = named;
      filterWhy = [filterWhy, `places: only ${named.join(', ')} (named in the search)`].filter(Boolean).join('; ');
    }
  }
  let dateFrom = time ? time.from : null;
  let dateTo = time ? time.to : null;

  // a fixed side narrows its own search to that side
  const sides = parts.some(comparesSides) ? codeSides(understood) : null;
  const side = sides && search.side ? sides.find((s) => s.label === search.side) : null;
  if (side && side.countries) countries = side.countries;
  if (side && side.companies) companies = side.companies;
  if (side && side.date_from) { dateFrom = side.date_from; dateTo = side.date_to; }
  if (side && side.companies && own && same(side.companies[0], own)) companies = [own];
  const dates = searchDates(dateFrom, dateTo, todayOf(understood));
  dateFrom = dates.from;
  dateTo = dates.to;

  const inputs = {};
  if (!exactRead) inputs.query = search.words;
  inputs.modules = exactRead ? (named.length ? named : [...MODULES]) : [...MODULES];
  if (dateFrom) inputs.date_from = dateFrom;
  if (dateTo) inputs.date_to = dateTo;
  if (companies.length) inputs.companies = companies.slice(0, 20);
  if (countries.length) inputs.countries = countries.slice(0, 20);
  if (exactRead) {
    const impact = impactAsked(question);
    if (impact) inputs.impact = impact;
    inputs.order = impact ? 'impact' : 'newest';
    inputs.max_items = RUN_LIMITS.search_max_signals;
  }
  inputs.label = cleanText(search.side || search.words, 80);
  return { capability: exactRead ? 'structured_search' : 'retrieve_data', inputs, filter_why: filterWhy, future: dates.future };
}

/**
 * The analysis jobs of one part, in the fixed order, each fed with the
 * right earlier results.
 *   E  = the part's own search results
 *   U  = the final results of the parts it waits for
 */
function analysisTasks(part, E, U, sideRefs, question, notes) {
  const ref = (t) => `${t}.output`;
  const tasks = [];               // [{ capability, inputs, refs }]
  const done = {};                // job id -> its ref
  const order = ANALYSIS_ORDER.filter((j) => (part.analysis || []).includes(j));
  const topic = cleanText((part.information_needed || [])[0] || GOAL_LABELS[part.goal], 200);
  const take = (list, max) => uniq(list.filter(Boolean)).slice(0, max);

  for (const job of order) {
    let inputs = null;
    if (job === 'extract_facts') {
      inputs = { evidence: take(E, 4), what_to_find: (part.information_needed || []).slice(0, 6) };
      if (inputs.what_to_find.length === 0) inputs.what_to_find = [GOAL_LABELS[part.goal]];
    } else if (job === 'cluster') {
      inputs = { evidence: take(E, 4) };
    } else if (job === 'identify_patterns') {
      inputs = { evidence: take(E, 4), topic };
    } else if (job === 'analyse_risks') {
      inputs = { evidence: take(E, 4), topic };
    } else if (job === 'compare') {
      if (!sideRefs || sideRefs.length < 2) {
        notes.push(`${part.requirement_id}: fewer than 2 sides found, so nothing to compare: summarised instead`);
        if (!order.includes('summarise')) order.push('summarise');
        continue;
      }
      inputs = { sides: sideRefs.slice(0, MAX_SIDES), dimensions: (part.information_needed || []).slice(0, 8) };
    } else if (job === 'identify_gaps') {
      inputs = { inputs: take([done.compare, done.identify_patterns, done.analyse_risks, ...U, ...E], 4) };
    } else if (job === 'discover_opportunities') {
      inputs = { inputs: take([done.identify_patterns, done.identify_gaps, done.compare, ...U, ...E], 4) };
    } else if (job === 'summarise') {
      inputs = { input: take([...Object.values(done), ...U, ...E], 6), focus: `${GOAL_LABELS[part.goal]}: ${topic}`.slice(0, 200) };
      const headings = part.goal === 'framework' ? headingsFor(question) : null;
      if (headings) inputs.headings = headings;
    }
    if (!inputs) continue;
    const idx = tasks.length;
    tasks.push({ capability: job, inputs });
    done[job] = `@${idx}`;   // a placeholder, given its real task id later
  }
  return tasks.map((t) => ({ ...t, placeholderRef: ref }));
}

/**
 * Puts the whole workflow together: searches first, then each part's
 * analysis, then the evidence check.
 */
function assemble(plan, understood, question, searches, notes) {
  const tasks = [];
  // The same job with the same inputs is made once and shared by every
  // part that needs it (two parts that both compare the same sides get ONE
  // compare job).
  const add = (task) => {
    const twin = tasks.find((t) => t.capability === task.capability && JSON.stringify(t.inputs) === JSON.stringify(task.inputs));
    if (twin) {
      twin.for_requirements = uniq([...twin.for_requirements, ...task.for_requirements]);
      return twin.task_id;
    }
    // two parts comparing the very same sides: ONE compare job, with the
    // points of both parts
    if (task.capability === 'compare') {
      const same_ = tasks.find((t) => t.capability === 'compare' && JSON.stringify(t.inputs.sides) === JSON.stringify(task.inputs.sides));
      if (same_) {
        const max = (getCapability('compare').inputs.dimensions || {}).max || 8;
        same_.inputs.dimensions = uniq([...(same_.inputs.dimensions || []), ...(task.inputs.dimensions || [])]).slice(0, max);
        same_.for_requirements = uniq([...same_.for_requirements, ...task.for_requirements]);
        return same_.task_id;
      }
    }
    const id = `T${tasks.length + 1}`;
    tasks.push({ task_id: id, ...task });
    return id;
  };

  // searches. Two searches that would fetch exactly the same thing (for
  // example two exact reads of the newest policy news) become ONE job.
  const byKey = new Map();
  let futureNoted = false;
  const searchIds = searches.map((s) => {
    const { capability, inputs, filter_why: filterWhy, future } = searchTask(s, plan, understood, question, searches);
    if (future && !futureNoted) {
      futureNoted = true;
      notes.push(`the question is about a future time (${understood.time.from} to ${understood.time.to}): searches look at the news of the last ${FUTURE_LOOKBACK_MONTHS} months up to today`);
    }
    const { label, query, ...rest } = inputs;
    const key = JSON.stringify([capability, capability === 'structured_search' ? null : plain(query), rest]);
    if (byKey.has(key)) {
      const id = byKey.get(key);
      const task = tasks.find((t) => t.task_id === id);
      task.for_requirements = uniq([...task.for_requirements, ...s.for]);
      notes.push(`${s.for.join(', ')}: search "${s.words}" fetches the same as ${id}, so ${id} is used (no job twice)`);
      return id;
    }
    if (filterWhy) notes.push(`${s.for.join(', ')}: search "${cleanText(s.words, 60)}": ${filterWhy}`);
    const id = add({
      capability,
      inputs,
      for_requirements: [...s.for],
      why: s.side ? `evidence for the side "${s.side}"` : `evidence for ${s.for.join(', ')}`,
      added_by_code: Boolean(s.added_by_code),
    });
    byKey.set(key, id);
    return id;
  });

  // each part's analysis
  const finals = {};
  for (const part of plan.requirements) {
    const id = part.requirement_id;
    const E = searches.map((s, i) => (s.for.includes(id) ? `${searchIds[i]}.output` : null)).filter(Boolean);
    const U = (part.depends_on || []).map((d) => finals[d]).filter(Boolean).flat();
    const sideRefs = comparesSides(part)
      ? searches.map((s, i) => (s.for.includes(id) && s.side ? { label: s.side, ref: `${searchIds[i]}.output` } : null)).filter(Boolean)
      : null;
    const made = analysisTasks(part, E, U, sideRefs, question, notes);
    const local = [];             // placeholder index -> real task id
    for (const t of made) {
      const inputs = JSON.parse(JSON.stringify(t.inputs, (k, v) => {
        if (typeof v === 'string' && v.startsWith('@')) return `${local[Number(v.slice(1))]}.output`;
        return v;
      }));
      local.push(add({ capability: t.capability, inputs, for_requirements: [id], why: `${GOAL_LABELS[part.goal]} (${id})` }));
    }
    finals[id] = local.length ? [`${local[local.length - 1]}.output`] : E;
  }

  // the evidence check, once, at the end
  const findings = uniq(plan.requirements.flatMap((r) => finals[r.requirement_id] || [])).slice(0, 8);
  if (findings.length) {
    add({ capability: 'validate_evidence', inputs: { findings }, for_requirements: plan.requirements.map((r) => r.requirement_id), why: 'check every finding has real evidence' });
  }

  // "waits for" = every earlier task whose result a task uses
  for (const t of tasks) {
    const refs = JSON.stringify(t.inputs).match(/T\d+\.output/g) || [];
    t.depends_on = uniq(refs.map((r) => r.replace('.output', ''))).filter((x) => x !== t.task_id);
  }
  return { tasks, finals };
}

const countOf = (tasks) => ({
  tasks: tasks.length,
  searches: tasks.filter((t) => ['retrieve_data', 'structured_search'].includes(t.capability)).length,
  ai_jobs: tasks.reduce((n, t) => n + aiCost(t.capability), 0),
});

/**
 * Builds the workflow and keeps the limits. When a limit is passed, the
 * code does this, step by step, until the workflow fits (each one recorded):
 *   1. joins a part's own searches into one (nothing asked for is lost)
 *   2. takes out helper jobs (facts / group / summary) that are not a key job
 *   3. takes out other supporting analysis of the extra goals (never a key job)
 *   4. leaves out whole extra goals, optional ones first, last first
 *      (the answer must say so)
 * Optional parts and the last parts go first. The main goal is never taken out.
 *
 * @param aiBudget  AI calls the jobs may still use for this question
 */
function finishWorkflow(plan, understood, question, aiSearches, aiBudget, removed, aiSideNames = null) {
  const notes = [];
  // the sides of any comparison are chosen once, for every part of the build
  understood = { ...understood, compare_sides: codeSides(understood, aiSideNames) };
  let working = { ...plan, requirements: plan.requirements.map((r) => ({ ...r, analysis: [...(r.analysis || [])] })) };
  let searches = completeSearches(aiSearches, working, understood, notes);

  const build = () => assemble(working, understood, question, searches, [...notes]);
  let built = build();
  const over = () => {
    const c = countOf(built.tasks);
    return c.tasks > RUN_LIMITS.max_tasks || c.searches > RUN_LIMITS.max_search_tasks || c.ai_jobs > aiBudget;
  };

  const byPriority = () => [...working.requirements]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.priority === b.r.priority ? b.i - a.i : (a.r.priority === 'optional' ? -1 : 1)))
    .map((x) => x.r);
  const mainId = working.requirements[0] && working.requirements[0].requirement_id;
  let guard = 0;

  // 1. a part's own searches are joined into one (nothing asked for is lost)
  while (over() && guard++ < 40) {
    let done = false;
    for (const r of byPriority()) {
      const own = searches.filter((x) => !x.side && x.for.length === 1 && x.for[0] === r.requirement_id);
      if (own.length > 1) {
        searches = replaceIn(searches, own, mergeSearches(own));
        removed.push({ what: 'search', value: own.map((x) => x.words).join(' + '), why: `over the limits: ${own.length} searches of ${r.requirement_id} joined into one` });
        done = true;
        break;
      }
    }
    if (!done) break;
    built = build();
  }
  // 1b. still too many searches: join searches (also ones shared by several
  //     parts), the ones with the fewest parts first. Every part keeps a search.
  while (countOf(built.tasks).searches > RUN_LIMITS.max_search_tasks && guard++ < 80) {
    const free = searches.filter((x) => !x.side);
    if (free.length < 2) break;
    const ordered = [...free].sort((a, b) => a.for.length - b.for.length);
    const pair = [ordered[0], ordered[1]];
    searches = replaceIn(searches, pair, mergeSearches(pair));
    removed.push({ what: 'search', value: pair.map((x) => x.words).join(' + '), why: `over the limits: more than ${RUN_LIMITS.max_search_tasks} searches, two joined into one` });
    built = build();
  }
  // 2. helper jobs (facts / group / summary) that are not a key job
  // 3. then other supporting analysis of the extra goals (never a key job, never the main goal)
  for (const level of ['helper', 'supporting']) {
    while (over() && guard++ < 120) {
      let cut = false;
      for (const r of byPriority()) {
        if (level === 'supporting' && r.requirement_id === mainId) continue;
        const job = [...r.analysis].reverse().find((j) => GOAL_KEY_JOB[r.goal] !== j &&
          (level === 'helper' ? HELPER_JOBS.includes(j) : !HELPER_JOBS.includes(j)));
        if (job) {
          r.analysis = r.analysis.filter((j) => j !== job);
          removed.push({ what: 'analysis', value: `${job} (${r.requirement_id})`, why: `over the limits (jobs / searches / AI calls): ${level} job taken out` });
          cut = true;
          break;
        }
      }
      if (!cut) break;
      built = build();
    }
  }
  // 4. whole extra goals: optional ones first, the main goal never
  while (over() && guard++ < 160) {
    const extra = [...working.requirements].reverse().filter((r) => r.requirement_id !== mainId);
    const drop = extra.find((r) => r.priority === 'optional') || extra[0];
    if (!drop) break;
    working = {
      ...working,
      requirements: working.requirements
        .filter((r) => r !== drop)
        .map((r) => ({ ...r, depends_on: (r.depends_on || []).filter((d) => d !== drop.requirement_id) })),
    };
    searches = searches
      .map((x) => ({ ...x, for: x.for.filter((f) => f !== drop.requirement_id) }))
      .filter((x) => x.for.length > 0);
    removed.push({ what: 'goal', value: `${drop.goal} (${drop.requirement_id})`, why: 'over the limits (jobs / searches / AI calls): this goal is left out, the answer must say so' });
    built = build();
  }

  const finalNotes = [...notes];
  assemble(working, understood, question, searches, finalNotes);   // + the notes of the final build
  const counts = countOf(built.tasks);
  const overLimits = [];
  if (counts.tasks > RUN_LIMITS.max_tasks) overLimits.push(`${counts.tasks} jobs (limit ${RUN_LIMITS.max_tasks})`);
  if (counts.searches > RUN_LIMITS.max_search_tasks) overLimits.push(`${counts.searches} searches (limit ${RUN_LIMITS.max_search_tasks})`);
  if (counts.ai_jobs > aiBudget) overLimits.push(`${counts.ai_jobs} AI jobs (only ${aiBudget} AI calls left)`);

  return {
    tasks: built.tasks,
    final_outputs: built.finals,
    goals_left_out: removed.filter((x) => x.what === 'goal').map((x) => x.value),
    counts,
    over_limits: overLimits,
    notes: uniq(finalNotes),
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Step 7 main
// ═════════════════════════════════════════════════════════════════════════
/**
 * @param cleaned     what Step 2 returned (needs preprocessed_query)
 * @param understood  what Step 5 returned
 * @param plan        what Step 6 returned
 * @param options     { aiCallsSoFar } — AI calls Steps 3, 5 and 6 already used
 * @returns {
 *   status: 'built', workflow_id,
 *   tasks: [{ task_id, capability, inputs, depends_on, for_requirements, why, added_by_code? }],
 *   final_outputs: { IR1: ['T5.output'] },   the result of each part
 *   goals_left_out, counts: { tasks, searches, ai_jobs }, ai_budget, over_limits,
 *   notes, removed_by_check, attempts, ai_problems, built_by_code
 * }
 * @throws ChatError 503 only if the AI could not be reached at all
 */
async function buildWorkflow(cleaned, understood, plan, options = {}) {
  const question = cleaned.preprocessed_query;
  const prompt = await requirePrompt(WORKFLOW_PROMPT_ID);
  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: buildMessage(question, understood, plan) },
  ];

  let best = null;
  let bestSideNames = null;
  let removed = [];
  let attempts = 0;
  let aiReplied = false;
  let lastProblem = '';
  const aiProblems = [];
  let conversation = messages;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    let reply = null;
    try {
      reply = await callLLM(conversation, { temperature: 0, max_tokens: 900, timeout: 45000, maxRetries: 2 });
    } catch (err) {
      lastProblem = `AI call failed: ${err.message}`;
      console.log(`[DynamicRAG] buildWorkflow attempt ${attempts}: ${lastProblem}`);
      continue;
    }
    aiReplied = true;
    const checked = checkAiSearches(reply, plan, understood);
    if (checked.searches) {
      best = checked.searches;
      removed = checked.removed;
      bestSideNames = checked.side_names;
    }
    if (checked.searches && !checked.problem) break;
    const problem = checked.problem;
    // the whole reply (up to 800 letters) is kept, so a broken reply can be
    // seen in the report and in Phoenix, not only its last words
    lastProblem = `attempt ${attempts}: ${problem} (reply ${String(reply).length} characters: ${JSON.stringify(String(reply).slice(0, 800))})`;
    aiProblems.push(lastProblem);
    conversation = [
      ...messages,
      { role: 'assistant', content: String(reply).slice(0, 4000) },
      { role: 'user', content: `That reply cannot be used as it is because ${problem}. Reply again with ONLY the JSON object.` },
    ];
  }
  if (!best && !aiReplied) {
    console.error(`[DynamicRAG] buildWorkflow gave up after ${attempts} attempts. ${lastProblem}`);
    throw new ChatError(503, 'AI_UNAVAILABLE', 'I could not process your question right now. Please try again in a moment.');
  }
  const builtByCode = !best;
  if (builtByCode) console.log(`[DynamicRAG] buildWorkflow: no usable searches from the AI, built by code. ${lastProblem}`);

  const aiBudget = Math.max(0, RUN_LIMITS.max_ai_calls_per_question - (Number(options.aiCallsSoFar) || 0) - attempts);
  const finished = finishWorkflow(plan, understood, question, best, aiBudget, removed, bestSideNames);
  return {
    status: 'built',
    workflow_id: `wf_${Date.now().toString(36)}`,
    ...finished,
    ai_budget: aiBudget,
    removed_by_check: removed,
    attempts,
    ai_problems: aiProblems,
    built_by_code: builtByCode,
  };
}

module.exports = {
  buildWorkflow,
  // parts, exported for the test file
  ANALYSIS_ORDER,
  modulesNamed,
  impactAsked,
  headingsFor,
  onlyLatestWords,
  asksOnlyForLatest,
  codeSides,
  sideChoices,
  sameSide,
  sideNamedIn,
  wordsForSide,
  tidyJoins,
  companiesNamedIn,
  placesNamedIn,
  searchDates,
  buildMessage,
  checkAiSearches,
  completeSearches,
  searchTask,
  finishWorkflow,
  countOf,
};
