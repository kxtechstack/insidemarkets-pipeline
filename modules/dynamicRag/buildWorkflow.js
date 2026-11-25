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
const { getCapability, RUN_LIMITS, MODULES, GOAL_KEY_JOB, FRAMEWORKS } = require('./capabilityRegistry');
const { parseJsonLoose, withoutDateWords, withoutMetaNeeds } = require('./planTasks');
const { standardPlace, placeFromAdjective, PLACES } = require('../placeNames');
const { looksEnglish } = require('./preprocessQuery');

const MAX_ATTEMPTS = 2;               // ask the AI at most twice
const MAX_SEARCHES_PER_PART = 3;
const MAX_WORDS_CHARS = 150;           // search words
const MAX_JOINED_CHARS = 300;          // joined search words (the search job takes up to 300)
const MAX_SIDE_CHARS = 80;
const MAX_SIDES = 4;                   // compare takes 2 to 4 sides
const MAX_SUBJECTS_ADDED = 2;           // subjects added to a search that lost them

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
// Words added to the end of a search (the subject, a place not in our list)
// must still fit the search job's limit (300 letters). "How do we win younger
// shoppers in Saudi Arabia?": 6 searches were joined up to 299 letters, then
// the subject was added -> 310, refused by Step 8. The added words win: the
// last whole points of the search make room (listed in the notes), never
// half a word.
function addWords(words, extra, max = MAX_JOINED_CHARS) {
  const tail = String(extra || '').trim();
  let parts = String(words || '').split(/\s*,\s*/).filter(Boolean);
  const dropped = [];
  const join = () => `${parts.join(', ')} ${tail}`.trim();
  while (parts.length > 1 && join().length > max) dropped.unshift(parts.pop());
  let text = join();
  if (text.length > max) {
    // one point alone is too long: cut it at a space before the added words
    const room = Math.max(0, max - tail.length - 1);
    const cut = cutWords(parts[0] || '', room);
    if (cut.cut) dropped.unshift(cut.cut);
    text = `${cut.text} ${tail}`.trim();
  }
  return { text, dropped };
}

// Search words kept under a length limit WITHOUT cutting a word or a point in
// half: whole comma parts are kept while they fit ("regulation in United
// Arab E" was a cut name, then searched for the other side as "arab e").
// One part that is too long alone is cut at a space, with no small word left
// hanging at the end. Returns the words kept and the words left out.
function cutWords(v, max) {
  const t = cleanText(v, 100000);
  if (t.length <= max) return { text: t, cut: '' };
  let out = '';
  for (const part of t.split(/\s*,\s*/).filter(Boolean)) {
    const next = out ? `${out}, ${part}` : part;
    if (next.length > max) break;
    out = next;
  }
  if (!out) {
    out = t.slice(0, max);
    const space = out.lastIndexOf(' ');
    if (space > 0) out = out.slice(0, space);
    out = out.replace(/(\s+\S{1,3})+$/, '').trim() || out;
  }
  return { text: out, cut: t.slice(out.length).replace(/^[\s,]+/, '') };
}
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

// Fixed headings for SWOT / PESTLE / Five Forces. Every framework the
// question names is kept, in the order it is named ("a SWOT and a PESTLE"
// was SWOT only: PESTLE was lost without a word). With two or more, each
// heading says its framework ("SWOT: Strengths"). Frameworks that do not fit
// the heading limit are listed in `left_out` (said in the notes).
const MAX_HEADINGS = 12;
function frameworksNamed(question) {
  const q = String(question || '');
  return FRAMEWORKS.map((f) => ({ f, at: q.search(f.match) })).filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at).map((x) => x.f);
}
function frameworkHeadings(question) {
  const named = frameworksNamed(question);
  if (!named.length) return { headings: null, left_out: [] };
  if (named.length === 1) return { headings: [...named[0].headings], left_out: [] };
  const headings = [];
  const left = [];
  for (const f of named) {
    if (headings.length + f.headings.length > MAX_HEADINGS) { left.push(f.name); continue; }
    headings.push(...f.headings.map((h) => `${f.name}: ${h}`));
  }
  return { headings, left_out: left };
}
function headingsFor(question) {
  return frameworkHeadings(question).headings;
}

// Words that say "the newest things", not WHAT to look for.
const LATEST_WORDS = new Set([
  'latest', 'newest', 'new', 'recent', 'news', 'update', 'updates', 'alert', 'alerts', 'signal', 'signals',
  'highlight', 'highlights', 'change', 'changes', 'move', 'moves', 'announcement', 'announcements', 'activity',
  'activities', 'development', 'developments', 'event', 'events', 'item', 'items', 'important', 'critical',
  'high', 'impact', 'what', 'happened', 'all', 'any', 'the', 'of', 'in', 'for', 'about', 'and', 'our', 'my',
  'client', 'business', 'company', 'market', 'industry', 'policy', 'policies', 'competitor', 'competitors',
  'regulatory', 'regulation', 'regulations', 'rules', 'dynamics',
  'give', 'me', 'show', 'list', 'which', 'are', 'is', 'was', 'were', 'there', 'from', 'last', 'this', 'to', 'get',
  'tell', 'please', 'summarise', 'summarize', 'summary', 'brief', 'briefing', 'today', 'we', 'us', 'i', 'my',
  'sector', 'happening', 'going', 'on', 'did', 'do', 'anything', 'everything', 'know', 'should', 'team', 'big',
  'announce', 'announced', 'changed', 'moved', 'happen', 'new', 'whats', 'has', 'have', 'been',
  'recently', 'lately', 'currently', 'now', 'so', 'far', 'at', 'by', 'with',
]);
// ignore: words that are filters, not topics (the client industry, places, company names)
// The module names ("policy alerts", "forward outlook", "rivals") say WHERE
// to look, so they are not a topic either.
// (Names are taken out WHOLE: "beauty" stays a topic even though the
// client is called "Lumière Beauty Group".)
const topicWordsOf = (text, ignore = []) => {
  let t = ` ${plain(text)} `;
  const names = uniq(ignore.map(plain).filter(Boolean)).sort((a, b) => b.length - a.length);
  for (const n of names) t = t.split(` ${n} `).join(' ');
  for (const [, re] of MODULE_WORDS) t = t.replace(new RegExp(re.source, 'gi'), ' ');
  return t.split(/\s+/).filter((w) => w.length >= 2 && !LATEST_WORDS.has(w) && !JOIN_WORDS.has(w));
};

// The topic words of a LIST question: what is left of the user's own words
// once dates, places, company names, the client industry, the module names
// and the "newest items" words are taken out.
// "Show all policy signals about packaging"          -> packaging
// "news from last week about fragrance"              -> fragrance
// "Give me all high impact signals from last month"  -> (none)
// Other industries the question names ("fragrance", "retail") ARE topics:
// only the client's own industry is the whole data already.
function listTopicWords(question, understood) {
  const text = withoutDateWords([String(question || '')], [])[0] || '';
  const places = understood.places || [];
  const ignore = [
    ...places, ...places.flatMap((p) => PLACES[p] || []),     // "UAE" = United Arab Emirates
    ...(understood.companies || []).flatMap((c) => [c.name, c.matched && c.matched.name]),
    (understood.client && understood.client.industry) || '',
    (understood.client && understood.client.company_name) || '',
  ].filter(Boolean);
  // a place word ("indian", "korean") is the place, a filter too
  return topicWordsOf(text, ignore).filter((w) => !places.some((p) => w.length >= 4 && same(placeFromAdjective(w) || '', p)));
}

// Is the QUESTION only asking for "the newest items" (no real topic)?
// Decided from the user's own words, not the AI's.
// "Give me all high impact signals from last month" -> yes
// "List all funding rounds in our industry this quarter" -> no (funding rounds)
function asksOnlyForLatest(question, understood) {
  return listTopicWords(question, understood).length === 0;
}

// The sides of a comparison that the code can name for sure, with the
// filters each side gets. null = the code cannot tell (a comparison of
// topics, "online vs offline": the AI names those sides).
function codeSides(understood, aiSideNames = null) {
  if (understood.compare_sides !== undefined) return understood.compare_sides;   // already chosen
  const own = understood.client && understood.client.company_name;
  const ranges = (understood.time && understood.time.ranges) || [];
  // Two or more KINDS of sides can fit (2+ places and 2+ companies, or 2+
  // places and "that company vs us"): the question decides what is
  // compared, never a fixed order. First the words next to
  // "compare / vs / versus" the user typed, then the side names the AI
  // wrote (one of the choices it was shown), then the first choice.
  // ("compare Lancôme and Estée Lauder in UAE and Saudi" -> the companies,
  //  "compare the Saudi and UAE markets for Lancôme" -> the places)
  // (also "Q1 2025 versus Q1 2026 competitor activity" -> the two dates,
  //  not "us vs competitors" just because competitors are named)
  const options = sideOptions(understood);
  if (options.length > 1) return chooseSides(options, aiSideNames, understood.question_text, own);
  if (options.length === 1) return options[0].sides;
  return null;
}

// The places / companies / dates of the chosen kind that did not fit in
// the comparison (more than MAX_SIDES were named).
function sidesLeftOut(understood, sides) {
  if (!sides || sides.length < MAX_SIDES) return [];
  const labels = sides.map((x) => x.label);
  let all = [];
  if (sides[0].countries) all = understood.places || [];
  else if (sides[0].date_from) all = ((understood.time && understood.time.ranges) || []).map((r) => r.text);
  else if (sides[0].companies && sides[0].label !== 'Competitors') {
    all = companyNames(understood);
    // the competitors compared with each other: the rest of the list
    if (!all.length && understood.all_competitors) all = (understood.client && understood.client.competitors) || [];
  }
  return uniq(all).filter((x) => !labels.includes(x));
}

const companyNames = (understood) => (understood.companies || []).map((c) => (c.matched && c.matched.name) || c.name);

// Every kind of sides the question could compare, in the fixed order used
// only to break a tie: companies, "that company vs us", places, "us vs
// competitors", dates.
// Does the user put OUR business in the question as a thing of its own
// ("how do WE compare", "where are WE losing", "our pricing", the client's
// name)? "my competitors" / "our rivals" only says whose competitors they
// are: our business is not a side then. Step 5 also marks a question about
// "competitors" as about our business, so that flag alone is no proof.
// (No question text known: Step 5's flag decides.)
const RIVAL_WORD = /\b(competit\w*|rivals?)\b/i;
function ownNamedInQuestion(understood) {
  const q = String(understood.question_text || '');
  if (!q) return Boolean(understood.about_own_business);
  const own = plain(understood.client && understood.client.company_name);
  const t = q.replace(/\b(?:our|my)\s+(?:[\p{L}'-]+\s+)?(?:competit\w*|rivals?)\b/giu, ' ');
  if (/\b(we|our|ours|my|myself|ourselves)\b/i.test(t) || /\bus\b/.test(t)) return true;
  return Boolean(own && ` ${plain(t)} `.includes(` ${own} `));
}

function sideOptions(understood) {
  const places = understood.places || [];
  const companies = companyNames(understood);
  const own = understood.client && understood.client.company_name;
  const ownTyped = Boolean(understood.about_own_business) && ownNamedInQuestion(understood);
  const options = [];
  if (companies.length >= 2) {
    options.push({ kind: 'companies', sides: companies.slice(0, MAX_SIDES).map((c) => ({ label: c, companies: [c] })) });
  } else if (companies.length === 1 && ownTyped && own && !same(companies[0], own)) {
    options.push({ kind: 'company_vs_own', sides: [{ label: companies[0], companies: [companies[0]] }, { label: own, companies: [own] }] });
  }
  if (places.length >= 2) {
    options.push({ kind: 'places', sides: places.slice(0, MAX_SIDES).map((p) => ({ label: p, countries: [p] })) });
  }
  const rivals = (understood.client && understood.client.competitors) || [];
  const onlyOwn = companies.length === 0 || (companies.length === 1 && own && same(companies[0], own));
  if (understood.all_competitors && rivals.length && onlyOwn) {
    if (ownTyped && own) {
      // "How do we stand against our competitors?": own company vs the competitor list
      options.push({ kind: 'own_vs_competitors', sides: [{ label: own, companies: [own] }, { label: 'Competitors', companies: rivals.slice(0, 20) }] });
    } else if (rivals.length >= 2) {
      // "Which competitor is opening the most stores?": the competitors are
      // compared with each other (our own business is not in the question)
      options.push({ kind: 'competitors', sides: rivals.slice(0, MAX_SIDES).map((c) => ({ label: c, companies: [c] })) });
    }
  }
  // two or more different dates the user named ("2025 and 2025" is one date)
  const ranges = [];
  for (const r of (understood.time && understood.time.ranges) || []) {
    if (!ranges.some((x) => x.from === r.from && x.to === r.to)) ranges.push(r);
  }
  if (ranges.length >= 2) {
    options.push({ kind: 'dates', sides: ranges.slice(0, MAX_SIDES).map((r) => ({ label: r.text, date_from: r.from, date_to: r.to })) });
  }
  return options;
}

// Which of several kinds of sides does the question compare?
function chooseSides(options, aiSideNames, question, own) {
  const score = (names) => options.map((o) => names.filter((n) => o.sides.some((x) => sameSide(n, x.label, own))).length);
  const pick = (scores) => {
    const top = Math.max(...scores);
    const winners = scores.filter((x) => x === top).length;
    return top > 0 && winners === 1 ? options[scores.indexOf(top)].sides : null;
  };
  // the USER's words next to "compare / vs / versus" decide first; the AI's
  // side names only break a tie (19 Nov: for "Q1 2025 versus Q1 2026
  // competitor activity" the AI named the dates AND the 4 competitors, and
  // 4 names beat 2: the dates the user put next to "versus" must win)
  const near = compareWords(question);
  const byWords = near ? pick(options.map((o) => o.sides.filter((x) => namedInText(near, x.label, own)).length)) : null;
  if (byWords) return byWords;
  const byAi = pick(score((aiSideNames || []).filter(Boolean)));
  return byAi || options[0].sides;
}

// The things a question compares are the words right next to "compare /
// vs / versus / compared to / against / than", up to a scope word ("in",
// "for", "across"...), which starts WHERE or FOR WHOM:
//   "compare Lancome and Dior | in UAE and Saudi"        -> the companies
//   "compare the Saudi and UAE markets | for Lancome"    -> the places
//   "how do we compare to Lancome | in Singapore"        -> us vs Lancome
//   "Singapore vs Korea | for our brand"                 -> the places
// The words before count only when the compare word sits between the two
// things (vs, versus, against, than, compare(d) to / with).
// No compare word: the whole question.
const COMPARE_WORD = /\b(compared?\s+(?:to|with)|comparing\s+(?:to|with)|compare[ds]?|comparing|comparison(?:\s+(?:of|between))?|vs\.?|versus|against|than|between)\b/i;
const SCOPE_WORD = /^(in|across|for|within|among|over|during|on|at|from|by|into|inside|of)$/i;
function compareWords(question) {
  const q = String(question || '');
  if (!q) return '';
  const m = q.match(COMPARE_WORD);
  if (!m) return q;
  const between = /^(vs\.?|versus|against|than)$/i.test(m[0]) || /\s(to|with)$/i.test(m[0]);
  const afterWords = q.slice(m.index + m[0].length).split(/\s+/).filter(Boolean);
  const after = [];
  for (const word of afterWords) {
    if (after.length && (SCOPE_WORD.test(word) || /[?.!;:]$/.test(after[after.length - 1]))) break;
    after.push(word);
    if (after.length >= 8) break;
  }
  if (!between) return after.join(' ');
  const beforeText = q.slice(0, m.index).split(/[?.!;:]/).pop();
  const beforeWords = beforeText.split(/\s+/).filter(Boolean);
  const before = [];
  for (let i = beforeWords.length - 1; i >= 0 && before.length < 4; i--) {
    if (SCOPE_WORD.test(beforeWords[i])) break;
    before.unshift(beforeWords[i]);
  }
  return `${before.join(' ')} ${after.join(' ')}`.trim();
}

// Is this side named in the text? Its name, a short place name ("UAE",
// "saudi"), a place word ("korean"), or "our / we" for the client.
function namedInText(text, label, own) {
  const t = ` ${plain(text)} `;
  const name = plain(label);
  if (t.includes(` ${name} `)) return true;
  if (own && plain(own) === name && OWN_SIDE_WORDS.test(t)) return true;
  for (const alias of (PLACES[label] || []).map(plain)) if (alias.length >= 2 && t.includes(` ${alias} `)) return true;
  for (const word of t.trim().split(' ')) {
    if (word.length >= 4 && placeFromAdjective(word) && same(placeFromAdjective(word), label)) return true;
  }
  const first = name.split(' ')[0];
  return first.length >= 4 && first !== 'the' && t.includes(` ${first} `);
}

// When more than one kind of sides fits, the AI is shown every choice;
// otherwise the fixed sides (or none).
function sideChoices(understood) {
  const options = sideOptions(understood);
  return options.length > 1 ? options.map((o) => o.sides.map((x) => x.label)) : null;
}

// Is this side the same as that one? ("UAE" = "United Arab Emirates")
// lower case, no accents, no punctuation: "Estée Lauder" -> "estee lauder"
const plain = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
const OWN_SIDE_WORDS = /\b(our|we|us|my|client|own company|our company|our brand)\b/;

// A side the AI named, boiled down: plain words, one-or-many ignored
// ("competitors" = "competitor"). The client's own company in any form
// ("our", "we", "client", its name from the database) is OWN_CORE.
const OWN_CORE = '(own company)';
const singular = (w) => (w.length > 4 && /ies$/.test(w) ? `${w.slice(0, -3)}y` : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);
function sideCore(name, ownName) {
  const p = plain(name);
  if (!p) return '';
  if (ownName) {
    const own = plain(ownName);
    const ownFirst = own.split(' ')[0];
    if (p === own || OWN_SIDE_WORDS.test(p) || (ownFirst.length >= 4 && p.split(' ').includes(ownFirst))) return OWN_CORE;
  }
  return p.split(' ').map(singular).filter((w) => w && !JOIN_WORDS.has(w)).join(' ');
}

// Is an AI-named side really asked about? The words that make it
// different from the other sides must be in the USER'S question (the AI's
// own plan is no proof). "UAE retail market" vs "UAE retail landscape" in
// "Compare UAE and UAE retail": "market" / "landscape" were never typed,
// so they are not real sides. The own company counts when the user wrote
// "our / we / us" or the company's name.
// A word that is also in the OTHER sides' search words is the shared
// topic, not what separates the sides ("market" in "predict_market_share"
// is typed, but the "our" side searches "our market share" too).
function sideInQuestion(side, otherSides, question, ownName, otherWords = '') {
  const q = ` ${plain(question).split(' ').map(singular).join(' ')} `;
  const core = sideCore(side, ownName);
  if (core === OWN_CORE) {
    const own = ownName ? plain(ownName) : '';
    return OWN_SIDE_WORDS.test(plain(question)) || (own && q.includes(` ${own.split(' ').map(singular).join(' ')} `));
  }
  const others = new Set(otherSides.flatMap((o) => sideCore(o, ownName).split(' ')));
  const own = core.split(' ').filter((w) => w.length >= 2 && !others.has(w));
  const shared = ` ${plain(otherWords).split(' ').map(singular).join(' ')} `;
  return own.length > 0 && own.every((w) => q.includes(` ${w} `) && !shared.includes(` ${w} `));
}

// The sides of a comparison read from its searches: a search that names a
// word the user typed which no other search of that part has ("GCC
// skincare market growth" vs "GCC makeup market growth" for "which is
// growing faster, skincare or makeup") is about that thing. Searches that
// name both, or neither, are not a side. Fewer than 2 = no sides.
function sidesFromSearches(searches, question, ownName, understood = null) {
  // our own business ("us", "our", the client's name) is never a side found
  // this way: "us vs a competitor / the competitors" is decided from the
  // names (sideOptions), and "rules vs us" is not a comparison
  const ownWords = new Set(plain(ownName || '').split(' ').filter(Boolean));
  const ownWord = (w) => ownWords.has(w) || sideCore(w, ownName) === OWN_CORE;
  // the places and companies of the question are its SCOPE (they are
  // filters), never what this comparison is between: "Qatar" sits in
  // almost every search of "city stores versus online in Qatar"
  const scope = new Set();
  for (const name of [...((understood && understood.places) || []), ...(understood ? companyNames(understood) : [])]) {
    for (const n of [name, ...(PLACES[name] || [])]) for (const w of plain(n).split(' ')) if (w.length >= 2 && w !== 'the') scope.add(singular(w));
  }
  const scopeWord = (w) => scope.has(w) || ((understood && understood.places) || []).some((p) => w.length >= 4 && same(placeFromAdjective(w) || '', p));
  const norm = (t) => plain(t).split(' ').map(singular)
    .filter((w) => w.length >= 2 && !JOIN_WORDS.has(w) && !ownWord(w) && !scopeWord(w));
  const typed = new Set(norm(question));
  let sets = searches.map((x) => new Set(norm(x.words).filter((w) => typed.has(w))));
  // words every search that names something has are the shared topic
  // ("stores" in "city stores" and "online stores"); a search that names
  // nothing the user typed does not decide what is shared
  const named = sets.filter((set) => set.size > 0);
  const common = [...(named[0] || [])].filter((w) => named.length > 1 && named.every((set) => set.has(w)));
  sets = sets.map((set) => new Set([...set].filter((w) => !common.includes(w))));
  // a search that holds another search's words and more names both things: shared, not a side
  const contains = (a, b) => b.size > 0 && a.size > b.size && [...b].every((w) => a.has(w));
  const candidates = searches.map((x, i) => ({ search: x, set: sets[i] }))
    .filter((c, i) => c.set.size > 0 && !sets.some((other, j) => j !== i && contains(c.set, other)));
  // searches about the same thing are ONE side ("city store sales" and
  // "city store market share"): searches that share a word go together
  const groups = [];
  for (const c of candidates) {
    const touching = groups.filter((g) => [...c.set].some((w) => g.words.has(w)));
    const group = { members: [c], words: new Set(c.set) };
    for (const g of touching) {
      group.members.push(...g.members);
      for (const w of g.words) group.words.add(w);
      groups.splice(groups.indexOf(g), 1);
    }
    groups.push(group);
  }
  if (groups.length < 2 || groups.length > MAX_SIDES) return [];
  const found = [];
  for (const g of groups) {
    // the label in the user's own words and order ("men's grooming", "city store")
    const first = g.members.map((m) => m.search).sort((a, b) => searches.indexOf(a) - searches.indexOf(b))[0];
    const tokens = String(first.words).split(/[\s,]+/)
      .filter((t) => plain(t).split(' ').map(singular).some((w) => g.words.has(w)));
    const label = uniq(tokens.map((t) => t.toLowerCase())).join(' ');
    if (!label) return [];
    for (const m of g.members) found.push({ search: m.search, label });
  }
  const labels = uniq(found.map((f) => f.label));
  if (labels.length < 2) return [];
  const wordsOf = (label) => found.filter((f) => f.label === label).map((f) => f.search.words).join(' ');
  return labels.every((label) => sideInQuestion(label, labels.filter((l) => l !== label), question, ownName,
    labels.filter((l) => l !== label).map(wordsOf).join(' '))) ? found : [];
}

// When the reading above finds no sides but the question itself sets two
// words against each other ("Compare online and stores in Kuwait": the
// searches were "online store market performance" and "store market
// performance", so "store" looked like the shared topic and the part was
// summarised): a search with the first word is that side, a search with
// only the second word is the other side. "online store" (the first word
// right before the second) is the first side; a search naming both apart
// ("skincare makeup GCC") names both and is shared.
function sidesFromPair(searches, question, ownName, understood = null) {
  const scope = new Set();
  for (const name of [...((understood && understood.places) || []), ...(understood ? companyNames(understood) : [])]) {
    for (const n of [name, ...(PLACES[name] || [])]) for (const w of plain(n).split(' ')) if (w.length >= 2) scope.add(singular(w));
  }
  const ownWords = new Set(plain(ownName || '').split(' ').filter(Boolean));
  const usable = (w) => w.length >= 2 && !JOIN_WORDS.has(w) && !AGAINST_WORDS.has(w) && !scope.has(w) && !ownWords.has(w) && sideCore(w, ownName) !== OWN_CORE;
  const typedTokens = plain(question).split(' ');
  const typed = uniq(typedTokens.map(singular).filter(usable));
  for (let i = 0; i < typed.length; i++) {
    for (let j = 0; j < typed.length; j++) {
      const [a, b] = [typed[i], typed[j]];
      if (a === b || !setAgainst([a], b, question)) continue;
      const words = (x) => plain(x.words).split(' ').map(singular);
      const sideOf = (x) => {
        const w = words(x);
        const hasA = w.includes(a);
        const hasB = w.includes(b);
        if (hasA && hasB) return w.some((v, k) => v === a && w[k + 1] === b) ? a : null;   // "online store" = a; both apart = shared
        return hasA ? a : (hasB ? b : null);
      };
      const found = searches.map((x) => ({ search: x, side: sideOf(x) })).filter((f) => f.side);
      if (!found.some((f) => f.side === a) || !found.some((f) => f.side === b)) continue;
      // the label as the user typed it ("stores", not "store")
      const label = (w) => typedTokens.find((t) => singular(t) === w) || w;
      return found.map((f) => ({ search: f.search, label: label(f.side) }));
    }
  }
  return [];
}

// Does the question set these words against the other side's words with
// "and" / "or" / "vs" ("Compare online and stores", "stores versus online")?
// Plain grammar words only, a few words apart.
const AGAINST_WORDS = new Set(['and', 'or', 'vs', 'versus', 'against', 'than']);
function setAgainst(extraIn, core, question) {
  const t = plain(question).split(' ').map(singular);
  // only the words that make the two sides DIFFERENT count: in "Compare
  // UAE and UAE retail" the AI's sides "UAE market" and "UAE retail" share
  // "uae", and "uae ... and ... uae" is not one side set against the other
  // (21 Nov: they were compared)
  const allCore = core.split(' ').filter(Boolean);
  const extra = extraIn.filter((w) => w && !allCore.includes(w));
  const coreWords = allCore.filter((w) => !extraIn.includes(w));
  const at = (list) => t.map((w, i) => (list.includes(w) ? i : -1)).filter((i) => i >= 0);
  for (const i of at(extra)) {
    for (const j of at(coreWords)) {
      if (Math.abs(i - j) < 2 || Math.abs(i - j) > 4) continue;
      const between = t.slice(Math.min(i, j) + 1, Math.max(i, j));
      if (between.some((w) => AGAINST_WORDS.has(w)) && !between.some((w) => extra.includes(w) || coreWords.includes(w))) return true;
    }
  }
  return false;
}

// The searches of an AI reply read one by one, when the reply as a whole
// is not valid JSON. Each search starts at '{"for"'; it ends where the next
// one starts. A search that still cannot be read is tried once more
// without one of its brackets (a stray "]" or "}" in the middle, the
// commonest slip of the small model). Only objects with words are kept.
function searchItemsFrom(text) {
  const t = String(text || '');
  const starts = [];
  const re = /\{\s*"for"\s*:/g;
  let m;
  while ((m = re.exec(t))) starts.push(m.index);
  const isSearch = (x) => x && typeof x === 'object' && !Array.isArray(x) && x.words;
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const piece = t.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : t.length).trim().replace(/[\s,]+$/, '');
    // the end of the whole list ("]}") or text after it belongs to no search
    const close = piece.lastIndexOf('}');
    const tries = close > 0 ? [piece.slice(0, close + 1), piece] : [piece];
    let got = null;
    for (const x of tries) {
      const whole = parseJsonLoose(x);
      if (isSearch(whole)) { got = whole; break; }
      // one stray bracket inside the search
      for (let i = 1; i < x.length - 1 && !got; i++) {
        if (x[i] !== ']' && x[i] !== '}') continue;
        const cand = parseJsonLoose(x.slice(0, i) + x.slice(i + 1));
        if (isSearch(cand)) got = cand;
      }
      if (got) break;
    }
    if (got) out.push(got);
  }
  return out;
}

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
// Each comma part is done on its own, so the joining words left hanging
// are tidied in every part ("differences between uae and qatar" for the UAE
// side -> "differences between uae"), and the commas stay, so a part that
// comes twice is still seen as the same part when searches are joined.
function wordsForSide(words, sides, label, ownName) {
  return uniq(String(words || '').split(',').map((p) => partForSide(p, sides, label, ownName)).filter(Boolean)).join(', ');
}
function partForSide(words, sides, label, ownName) {
  let w = ` ${plain(words)} `;
  for (const s of sides) {
    if (s.label === label) continue;
    const other = plain(s.label);
    // a place side is also written in short ("UAE", "Saudi"); longest
    // first, so "saudi arabia" goes whole, not "saudi" leaving "arabia".
    // One or many is the same thing ("competitor" for the "Competitors" side).
    const oneOrMany = other.split(' ').map(singular).join(' ');
    const names = uniq([other, oneOrMany, ...(PLACES[s.label] || []).map(plain)]).filter(Boolean).sort((a, b) => b.length - a.length);
    // the name goes with the "and / or / vs" that pairs it with another
    // name: "estee lauder and lancome refill packaging" for the Estée Lauder
    // side -> "estee lauder refill packaging" (was "estee lauder and refill
    // packaging"); the word before is taken first, else the word after
    for (const n of names) {
      w = w.replace(new RegExp(`(?<= )(?:and|or|vs|versus) ${n}(?= )`, 'g'), ' ')
        .replace(new RegExp(`(?<= )${n} (?:and|or|vs|versus)(?= )`, 'g'), ' ')
        .split(` ${n} `).join(' ');
      w = ` ${w.trim().split(/\s+/).join(' ')} `;
    }
    // the competitor list side: every way of saying "competitors"
    if (s.label === 'Competitors') w = ` ${w.trim().split(/\s+/).filter((t) => !RIVAL_WORD.test(t)).join(' ')} `;
    const first = other.split(' ')[0];
    if (first.length >= 4 && first !== 'the') w = w.split(` ${first} `).join(' ');
    // a place side written as a place word ("malaysian" for Malaysia)
    if (PLACES[s.label]) {
      w = ` ${w.trim().split(/\s+/).filter((t) => !(t.length >= 4 && same(placeFromAdjective(t) || '', s.label))).join(' ')} `;
    }
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

// The words "our / we / us / my / client" say WHOSE news it is, and the
// filter already says that: news articles never contain them, so they only
// blur the search. "client industry" / "our sector" is the client's real
// industry from the database ("Cosmetics industry"). "client" stays when
// the user typed it ("client retention"). "US" (the country) stays.
function withoutOwnWords(words, understood) {
  const industry = understood && understood.client && understood.client.industry;
  const typedClient = /\bclients?\b/i.test(String((understood && understood.question_text) || ''));
  const ownWord = typedClient ? '(?:our|my)' : "(?:client'?s?|our|my)";
  let w = ` ${String(words || '')} `;
  if (industry) w = w.replace(new RegExp(`\\b(?:the\\s+)?${ownWord}\\s+(industry|sector)\\b`, 'gi'), (m, noun) => ` ${industry} ${noun} `);
  w = w.replace(/\b(?:our|ours|we|my|ourselves)\b/gi, ' ').replace(/\bus\b/g, ' ');
  if (!typedClient) w = w.replace(/\bclient(?:'s|s|s')?(?=[\s,.;:]|$)/gi, ' ');
  // tidy: no loose joining words left at the start or end of a comma part
  const tidy = w.split(',').map((part) => {
    const t = part.trim().split(/\s+/).filter(Boolean);
    while (t.length && JOIN_WORDS.has(t[0].toLowerCase())) t.shift();
    while (t.length && JOIN_WORDS.has(t[t.length - 1].toLowerCase())) t.pop();
    return t.join(' ');
  }).filter(Boolean).join(', ');
  return tidy || String(words || '');
}

// Is this one of our standard places (the names the news is stored under)?
const placeKnown = (name) => Object.prototype.hasOwnProperty.call(PLACES, name);

// The words a search sends. One search fetches news about ONE thing, so
// comparison words mean nothing there ("estee lauder vs market activity"
// once the other side is taken out): vs / versus / compared to / compared
// with are taken out, a phrase repeated right after itself is kept once
// ("uae retail market vs uae retail market"), a comma part whose words all
// sit in another part is dropped ("UAE retail market UAE retail" next to
// "UAE retail market trends"), and loose joining words are tidied.
function cleanSearchWords(words) {
  const parts = String(words || '').split(',').map((part) => {
    let w = ` ${part.trim()} `.replace(/\s(vs\.?|versus|compared (?:to|with))(?=\s)/gi, ' ');
    const tokens = w.split(/\s+/).filter(Boolean);
    for (let n = Math.min(6, Math.floor(tokens.length / 2)); n >= 1; n--) {
      for (let i = 0; i + 2 * n <= tokens.length; i++) {
        const a = tokens.slice(i, i + n).map(plain).join(' ');
        const b = tokens.slice(i + n, i + 2 * n).map(plain).join(' ');
        if (a === b) { tokens.splice(i + n, n); i -= 1; }
      }
    }
    return tidyJoins(tokens.join(' '));
  }).filter(Boolean);
  const cleaned = parts;
  // a comma part whose words are all in another part is not needed
  const wordsIn = (t) => uniq(plain(t).split(' ').filter((w) => w && !JOIN_WORDS.has(w)));
  const kept = [];
  cleaned.forEach((part, i) => {
    const mineW = wordsIn(part);
    const inside = cleaned.some((other, j) => j !== i && (wordsIn(other).length > mineW.length || (j < i && wordsIn(other).length === mineW.length)) &&
      mineW.every((w) => wordsIn(other).includes(w)));
    if (!inside) kept.push(part);
  });
  return kept.join(', ') || String(words || '').trim();
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
      const sets = sideChoices(understood);
      lines.push(`  SIDES (choose ONE of these ${sets.length} sets, the one the question compares, one search per side, the side name in "side"): ${sets.map((x) => x.join(' | ')).join('  OR  ')}`);
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
function checkAiSearches(replyText, plan, understoodIn) {
  const understood = withoutLeftOut(understoodIn);
  const removed = [];
  const text = String(replyText || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1) return { searches: null, problem: 'there is no JSON object in it', removed };
  let p = parseJsonLoose(text.slice(start, end + 1)) || parseJsonLoose(text.slice(start).trim());
  if (!p || typeof p !== 'object' || !Array.isArray(p.searches)) {
    // The whole reply is not one JSON object, but its searches may still
    // be readable one by one (21 Nov): one search with a stray bracket
    // ("side": "entry barriers"], ...), a reply cut short, or the list
    // written three times ({...} {...} {...}). Every whole search is kept;
    // nothing is guessed.
    const items = searchItemsFrom(text);
    if (items.length) {
      removed.push({ what: 'AI reply', value: `${text.length} characters`, why: `not one clean JSON object; read search by search, ${items.length} searches kept` });
      p = { searches: items };
    }
  }
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
    const cutRaw = cutWords(raw.words || raw.query, MAX_WORDS_CHARS);
    const wordsRaw = cutRaw.text;
    if (cutRaw.cut && forList.length) {
      removed.push({ what: 'search words', value: cutRaw.cut, why: `over ${MAX_WORDS_CHARS} characters (whole points kept: "${wordsRaw.slice(0, 60)}")` });
    }
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
      // one or many: "competitors" is asked about when the plan says "competitor market share"
      const askedFor = (x) => [x, singular(x), `${x}s`].some((f) => asked.includes(` ${f} `));
      if (!sideWords.length || !sideWords.every(askedFor)) {
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
  return cutWords(text || GOAL_LABELS[part.goal] || part.goal, MAX_WORDS_CHARS).text;
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
  const leftOut = sidesLeftOut(understood, sides);

  for (const part of plan.requirements) {
    const id = part.requirement_id;
    const mine = () => searches.filter((s) => s.for.includes(id));

    if (comparesSides(part)) {
      // nothing is dropped silently: past the limit, the rest is recorded
      if (leftOut.length) {
        notes.push(`${id}: at most ${MAX_SIDES} sides can be compared, so ${sides.map((x) => x.label).join(', ')} are compared; left out of the comparison: ${leftOut.join(', ')}`);
      }
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
        // The names of the sides LEFT OUT (past the 4-side limit) are taken
        // out of every side's words too: they are not compared, so the
        // Estée Lauder search never carries "nykaa", and the Saudi search
        // never carries "demand levels in bahrain".
        const nameSides = [...sides, ...leftOut.map((label) => ({ label }))];
        // (a search shared with other parts is given out too, when every
        // part it serves compares the same sides)
        const comparing = (f) => {
          const r = plan.requirements.find((x) => x.requirement_id === f);
          return Boolean(r && comparesSides(r));
        };
        const sideless = mine().filter((s) => !s.side && s.for.every(comparing));
        // A search with no side that ALSO serves a part that does not
        // compare ("halal beauty market activity" for the comparison and
        // for the trends of "Indonesia compared to Malaysia for halal
        // beauty") gives its words to every side too, and stays as it is
        // for the other part. Before (21 Nov) it was left out of the
        // comparison: only "regulation" was compared.
        const shared = mine().filter((s) => !s.side && !s.for.every(comparing));
        const sideWords = (label) => {
          const fromSideless = [...sideless, ...shared].map((s) => wordsForSide(s.words, nameSides, label, ownName)).filter(Boolean);
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
          const words = extra || (other && wordsForSide(other.words, nameSides, side.label, ownName)) || wordsFromNeeds(part);
          searches.push({ for: [id], words, side: side.label, added_by_code: true });
          notes.push(`${id}: search for the side "${side.label}" added by code`);
        }
        for (const s of sideless) {
          searches.splice(searches.indexOf(s), 1);
          notes.push(`${id}: search "${s.words}" had no side: its words were given to each side's search`);
        }
        for (const s of shared) {
          const at = searches.indexOf(s);
          if (at < 0) continue;
          searches[at] = { ...s, for: s.for.filter((f) => f !== id) };
          notes.push(`${id}: search "${s.words}" had no side: its words were given to each side's search (it stays a search of ${searches[at].for.join(', ')})`);
        }
        // a side's search never names another side ("Lancôme vs Estee Lauder
        // pricing" for the Lancôme side -> "lancome pricing")
        for (const x of mine().filter((m) => m.side)) {
          const cleaned = wordsForSide(x.words, nameSides, x.side, ownName);
          if (cleaned && cleaned !== wordsForSide(x.words, [], x.side, ownName)) {
            searches[searches.indexOf(x)] = { ...x, words: cleaned };
            notes.push(`${id}: other sides' names taken out of the "${x.side}" search`);
          }
        }
        // a DATE side's search does not carry its own date either: the dates
        // are its filter ("Compare April and May": "monthly sales data May"
        // kept "May" while "April" was taken out of the April search)
        if (sides[0] && sides[0].date_from) {
          const KEEP = '\u0000keep';
          for (const x of mine().filter((m) => m.side)) {
            const cleaned = wordsForSide(x.words, [{ label: KEEP }, ...nameSides], KEEP, ownName);
            if (cleaned && cleaned !== wordsForSide(x.words, [], x.side, ownName)) {
              searches[searches.indexOf(x)] = { ...x, words: cleaned };
              notes.push(`${id}: the date "${x.side}" taken out of its own search (the dates are its filter)`);
            }
          }
        }
      } else {
        // Sides named by the AI (the question names no 2 places / companies /
        // dates): two names for the same thing are ONE side ("UAE retail" and
        // "UAE retail market"). Fewer than 2 real sides = nothing to compare:
        // the part is summarised instead (said in the notes), sides are never
        // invented from the "information needed".
        // The client's own company written another way ("our", "we",
        // "client", "Lumiere") is one side, under the company's name.
        const ownName = understood.client && understood.client.company_name;
        for (const x of mine().filter((m) => m.side && sideCore(m.side, ownName) === OWN_CORE && m.side !== ownName)) {
          searches[searches.indexOf(x)] = { ...x, side: ownName };
        }
        const question = understood.question_text || '';
        const proven = new Set();   // sides the question itself sets against each other
        const named = uniq(mine().filter((s) => s.side).map((s) => s.side));
        // two AI sides the question itself sets against each other ("Which
        // is growing faster, skincare or makeup") are sides, even when one
        // side's search also names the other (that name is taken out later)
        for (const a of named) {
          for (const b of named) {
            if (a === b) continue;
            const pa = sideCore(a, ownName);
            const pb = sideCore(b, ownName);
            if (!pa || !pb || pa === OWN_CORE || pb === OWN_CORE || pa === pb) continue;
            if ((` ${pa} `).includes(` ${pb} `) || (` ${pb} `).includes(` ${pa} `)) continue;
            if (setAgainst(pa.split(' '), pb, question)) { proven.add(a); proven.add(b); }
          }
        }
        for (const a of named) {
          for (const b of named) {
            if (a === b || !mine().some((x) => x.side === b) || !mine().some((x) => x.side === a)) continue;
            // compared without general words and plurals: "UAE retail market"
            // and "UAE retail landscape" are both "uae retail"
            const pa = sideCore(a, ownName);
            const pb = sideCore(b, ownName);
            if (pa.length <= pb.length && (` ${pb} `).includes(` ${pa} `)) {
              // ...unless the extra words are what the user compares WITH the
              // shorter side: "Compare online and stores" -> the AI's sides
              // "online stores" and "stores" are "online" and "stores"
              const extra = pb.split(' ').filter((x) => x && !pa.split(' ').includes(x));
              if (pa !== OWN_CORE && pb !== OWN_CORE && extra.length && setAgainst(extra, pa, question)) {
                const label = extra.join(' ');
                for (const x of mine().filter((m) => m.side === b)) searches[searches.indexOf(x)] = { ...x, side: label };
                proven.add(label);
                proven.add(a);
                notes.push(`${id}: the sides "${b}" and "${a}" differ by "${label}", which the question compares with "${a}": the sides are "${label}" and "${a}"`);
                continue;
              }
              for (const x of mine().filter((m) => m.side === b)) searches[searches.indexOf(x)] = { ...x, side: a };
              notes.push(`${id}: the sides "${a}" and "${b}" are the same thing, so they are one side`);
            }
          }
        }
        for (const label of uniq(mine().filter((x) => x.side).map((x) => x.side))) {
          const same_ = mine().filter((x) => x.side === label);
          if (same_.length > 1) searches = replaceIn(searches, same_, mergeSearches(same_));
        }
        // the words that make each side different must be in the user's
        // question; a side the user never asked about is not a side
        const kept = uniq(mine().filter((x) => x.side).map((x) => x.side));
        for (const label of kept) {
          if (proven.has(label)) continue;
          const otherWords = mine().filter((m) => m.side && m.side !== label).map((m) => m.words).join(' ');
          if (sideInQuestion(label, kept.filter((o) => o !== label), question, ownName, otherWords)) continue;
          for (const x of mine().filter((m) => m.side === label)) searches[searches.indexOf(x)] = { ...x, side: null };
          notes.push(`${id}: the side "${label}" is not something the question compares, so it is not a side`);
        }
        // The AI named no real sides, but its searches are one per thing the
        // user compares ("skincare or makeup": one search names skincare,
        // the other makeup): those words are the sides.
        if (uniq(mine().filter((x) => x.side).map((x) => x.side)).length < 2) {
          // a thing the user left out ("all competitors except Lancôme") is
          // never a side, even when a search names it
          const notLeftOut = (list) => list.filter((f) => !namesLeftOut(f.label, userLeftOut(understood)).length);
          let found = notLeftOut(sidesFromSearches(mine(), question, ownName, understood));
          if (found.length < 2) found = notLeftOut(sidesFromPair(mine(), question, ownName, understood));
          if (found.length >= 2) {
            for (const f of found) searches[searches.indexOf(f.search)] = { ...f.search, side: f.label };
            notes.push(`${id}: no sides from the AI; the searches name the things the question compares, so the sides are ${uniq(found.map((f) => f.label)).map((l) => `"${l}"`).join(' and ')} (found by code)`);
            // ONE search per side, as for the sides the AI names
            for (const label of uniq(found.map((f) => f.label))) {
              const same_ = mine().filter((x) => x.side === label);
              if (same_.length > 1) {
                searches = replaceIn(searches, same_, mergeSearches(same_));
                notes.push(`${id}: ${same_.length} searches for the side "${label}" joined into one (one search per side)`);
              }
            }
          }
        }
        const left = uniq(mine().filter((x) => x.side).map((x) => x.side));
        if (left.length < 2) {
          for (const x of mine().filter((m) => m.side)) searches[searches.indexOf(x)] = { ...x, side: null };
        } else {
          // A search with no side (only for comparing parts) is given to
          // EVERY side, without the other sides' words, as for the fixed
          // sides: "market share of luxury and mass fragrance" -> the luxury
          // search gets "market share of luxury fragrance". Otherwise compare
          // never uses it and it is fetched for nothing.
          const labelSides = left.map((label) => ({ label }));
          const sideless = mine().filter((s) => !s.side && s.for.every((f) => {
            const r = plan.requirements.find((x) => x.requirement_id === f);
            return r && comparesSides(r);
          }));
          for (const s of sideless) {
            for (const label of left) {
              const target = mine().find((x) => x.side === label);
              const extra = wordsForSide(s.words, labelSides, label, ownName);
              if (!target || !extra) continue;
              searches[searches.indexOf(target)] = { ...mergeSearches([target, { ...target, words: extra }]), side: label, for: uniq([...target.for, ...s.for]) };
            }
            searches.splice(searches.indexOf(s), 1);
            notes.push(`${id}: search "${s.words}" had no side: its words were given to each side's search`);
          }
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

  // A comparison is only fair when every side is searched for the SAME
  // points: "What are competitors doing about sustainability?" had Lancôme
  // searched for "initiatives", Shiseido for "campaigns" and YSL for "green
  // launches". Any point one side's search has (other side names taken
  // out) is added to the searches of the other sides. Nothing is removed.
  const ownNameForSides = understood.client && understood.client.company_name;
  // A side's search never names another side - whatever way the sides were
  // decided (fixed, named by the AI, or found by code). The AI can tag a
  // search naming both things with one side ("skincare makeup GCC" as the
  // makeup side); the fixed-sides path already cleaned this, the others
  // did not. One pass for every comparing part, after all sides are known.
  for (const part of plan.requirements) {
    if (!comparesSides(part)) continue;
    const id = part.requirement_id;
    const mine = searches.filter((x) => x.side && x.for.includes(id));
    const labels = uniq(mine.map((x) => x.side));
    if (labels.length < 2) continue;
    const labelSides = labels.map((label) => ({ label }));
    for (const x of mine) {
      const cleaned = wordsForSide(x.words, labelSides, x.side, ownNameForSides);
      if (cleaned && cleaned !== wordsForSide(x.words, [], x.side, ownNameForSides)) {
        searches[searches.indexOf(x)] = { ...x, words: cleaned };
        notes.push(`${id}: the "${x.side}" search named another side; that name was taken out ("${String(x.words).slice(0, 60)}")`);
      }
    }
  }
  for (const part of plan.requirements) {
    if (!comparesSides(part)) continue;
    const id = part.requirement_id;
    const mine = searches.filter((x) => x.side && x.for.includes(id));
    const labels = uniq(mine.map((x) => x.side));
    if (labels.length < 2 || labels.length !== mine.length) continue;
    const labelSides = labels.map((label) => ({ label }));
    const pointsOf = (x) => uniq(String(x.words).split(',')
      .map((p) => wordsForSide(p, labelSides, '\u0000', ownNameForSides))
      .filter((p) => p.split(' ').some((t) => t.length >= 3 && !JOIN_WORDS.has(t))));
    const all = uniq(mine.flatMap(pointsOf));
    const missingFor = (x) => { const have = pointsOf(x); return all.filter((p) => !have.includes(p)); };
    if (mine.every((x) => missingFor(x).length === 0)) continue;
    for (const x of mine) {
      let words = x.words;
      for (const p of missingFor(x)) if (`${words}, ${p}`.length <= MAX_JOINED_CHARS) words = `${words}, ${p}`;
      searches[searches.indexOf(x)] = { ...x, words };
    }
    notes.push(`${id}: every side is searched for the same points (${all.join('; ').slice(0, 160)})`);
  }

  // Every company the user named is searched for. For a goal that is not
  // about the company itself (market entry, campaigns, strategy, trends...)
  // only a search that names the company is filtered to it, the others look
  // at all the news ("India cosmetics regulation" is not Nykaa news). So
  // when no search names the company, its name is added to one search of
  // the part (the one about competitors if there is one, else the first),
  // and never lost.
  const ownName = understood.client && understood.client.company_name;
  for (const part of plan.requirements) {
    if (COMPANY_GOALS.includes(part.goal) || comparesSides(part)) continue;
    const id = part.requirement_id;
    const mineNow = () => searches.filter((s) => s.for.includes(id) && !s.side);
    if (!mineNow().length) continue;
    for (const c of understood.companies || []) {
      const mine = mineNow();
      const name = (c.matched && c.matched.name) || c.name;
      if (!name || (ownName && same(name, ownName))) continue;
      if (searches.some((s) => companiesNamedIn(s.words, understood).some((x) => same(x, name)))) continue;
      const target = mine.find((s) => RIVAL_WORD.test(s.words)) || mine[0];
      searches[searches.indexOf(target)] = { ...target, words: `${target.words} ${name}` };
      notes.push(`${id}: no search named ${name}, so "${name}" was added to the search "${target.words}" (the other searches look at all the news)`);
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

// What the question is about, as Step 5 found it: its products and topics
// (or its industry when it names neither). Only the words that say WHICH
// thing count: goal words ("risks", "trends", "market", "campaign") are
// our own goal names and say nothing about the subject, and places and
// companies are filters already.
const GOAL_WORDS = new Set(Object.keys(GOAL_KEY_JOB).flatMap((g) => g.split('_')).map((w) => singular(w)));
function questionSubjects(understood) {
  const named = [...(understood.places || []), ...companyNames(understood)]
    .flatMap((x) => plain(x).split(' ')).map(singular);
  const words = (text) => plain(text).split(' ').map(singular)
    .filter((w) => w.length >= 4 && !GOAL_WORDS.has(w) && !JOIN_WORDS.has(w) && !named.includes(w));
  // A question in another language keeps its own words in Step 5's
  // subjects ("mercado", "Risiken", "riskler"). Our news is in English and
  // the AI already wrote English searches, so nothing is added then.
  if (!questionInEnglish(understood)) return [];
  // A module's name is not a subject: it picks the module, and "market
  // dynamics" was added to every search of "Market dynamics signals about
  // men's grooming" as if it were the subject (20 Nov).
  // (only the module NAMES "market dynamics / market signals / outlook";
  // the policy and competitor words - regulation, rules, competitor - are
  // real subjects)
  const noModules = (t) => MODULE_WORDS.filter(([m]) => m === 'market' || m === 'outlook')
    .reduce((x, [, re]) => x.replace(new RegExp(re.source, 'gi'), ' '), String(t));
  // A framework's name is not a subject either: "Porter's 5 Forces" and
  // "PESTEL for cosmetics" were added to searches; the news never says them,
  // the summary headings do that job. What is left of the subject is used
  // ("PESTEL for cosmetics" -> "cosmetics").
  const FRAME = new Set([...FRAMEWORKS.flatMap((f) => [...f.words, ...plain(f.name).split(' ')]), 'analysis', 'framework', 's', '5']);
  const noFrameworks = (t) => {
    const kept = String(t).split(/\s+/).filter((tok) => !plain(tok).split(' ').filter(Boolean).every((w) => FRAME.has(w)));
    return tidyJoins(kept.join(' '));
  };
  const pick = (list) => (list || []).map((t) => {
    const text = noFrameworks(noModules(t)).replace(/\s+/g, ' ').trim();
    return { text, words: words(text) };
  }).filter((x) => x.words.length);
  const main = [...pick(understood.products), ...pick(understood.topics)];
  return main.length ? main : pick(understood.industries);
}
// Is the question written in English? Most of its words (leaving out the
// company and place names) must be common English words. Decided for the
// whole question, so a rare English word ("haircare") does not count
// against it.
function questionInEnglish(understood) {
  // the question as TYPED decides (Step 2's spelling fixes assume English, 3g)
  return looksEnglish(understood.question_typed || understood.question_text, [...(understood.places || []), ...companyNames(understood)]);
}

// Does the search still say what the question is about? ("market risks"
// for "reputation risks from influencer marketing" does not.)
function keepsSubject(words, subjects) {
  const have = new Set(plain(words).split(' ').map(singular));
  return subjects.some((x) => x.words.some((w) => have.has(w)));
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

// What Step 5 says the user left out, and which of those a text names.
const userLeftOut = (understood) => {
  const e = (understood && understood.excluded) || {};
  return { places: e.places || [], companies: e.companies || [] };
};
function namesLeftOut(text, ex) {
  const w = ` ${plain(text)} `;
  return [...ex.places, ...ex.companies].filter((n) => {
    const forms = [n, ...(ex.places.includes(n) ? placeShortNames(n) : [])];
    return forms.some((f) => plain(f).length >= 2 && w.includes(` ${plain(f)} `));
  });
}
// the short ways a place is written in search words ("uae", "ksa", "saudi")
function placeShortNames(place) {
  const out = [];
  for (const f of (PLACES && PLACES[place]) || []) if (String(f).length >= 2) out.push(String(f));
  return out;
}
// Step 5's result as Step 7 must see it: the client's competitor list
// without the companies the user left out (the same object when nothing is
// left out). Used by checkAiSearches AND finishWorkflow.
function withoutLeftOut(understood) {
  const ex = userLeftOut(understood);
  const list = (understood && understood.client && understood.client.competitors) || [];
  if (!ex.companies.length || !list.some((c) => ex.companies.some((x) => same(x, c)))) return understood;
  return { ...understood, client: { ...understood.client, competitors: list.filter((c) => !ex.companies.some((x) => same(x, c))) } };
}
const EXCLUDE_WORDS_RE = /\b(?:except\s+for|except|excluding|exclude[sd]?|other\s+than|apart\s+from|not\s+including|leaving\s+out|but\s+not|without)\b/gi;

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
  // a place we do not know ("Maroc", "Riyadh", "Atlantis") cannot be an
  // exact filter, so such a list question is searched by meaning instead
  const unknownPlaces = (understood.places || []).filter((x) => !placeKnown(x));
  // The exact read can only filter (module, dates, place, company, impact):
  // it has no search words. So it is used only when the question has no
  // topic at all ("high impact signals last month", "estée lauder news").
  // A list question WITH a topic ("policy signals about packaging") is
  // searched by meaning, kept to the module it names.
  const exactRead = allList && unknownPlaces.length === 0 && asksOnlyForLatest(question, understood);

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
      // (a side search counts too: "What is Estée Lauder doing, and how
      // should we react?" - the Estée Lauder side covers the company, so the
      // strategy search about the market is not Estée Lauder news)
      const othersName = allSearches.some((x) => x !== search && companiesNamedIn(x.words, understood).length);
      const needNotAboutThem = parts.some((r) => (r.information_needed || []).some((n) => companiesNamedIn(n, understood).length === 0));
      // ...and the search really is about something else: it names another
      // subject of the question ("Korean beauty brands"), or the goal is not
      // about the companies themselves (trends, risks, strategy...).
      // "How many employees does Emirates NBD have?" -> "staff size" is still
      // about Emirates NBD.
      const otherSubject = namesOtherSubject(search.words, understood);
      const companyGoal = parts.every((r) => COMPANY_GOALS.includes(r.goal));
      // an exact read has no search words, so it can never be "about
      // something else": it keeps the companies ("estée lauder news")
      if (exactRead) {
        // keep the filter
      } else if (othersName && (!companyGoal || (needNotAboutThem && otherSubject))) {
        // a goal about the market, not the company (market entry, campaigns,
        // strategy, trends, risks): only a search that names the company is
        // its news ("India cosmetics regulation" is not Nykaa news)
        companies = [];
        filterWhy = 'companies: none (this search is about something else in the question, other searches cover the companies)';
      } else if (own && companies.some((c) => same(c, own))) {
        // the client's own company is a filter only for a search about it:
        // "Ramadan campaign ideas for our brand" -> competitor campaigns and
        // consumer signals are NOT news about our own company
        const allAboutOwn = parts.every((r) => (r.information_needed || []).length > 0 &&
          (r.information_needed || []).every((n) => companiesNamedIn(n, understood).some((c) => same(c, own))));
        // ...but a SWOT or a profile of our company describes the company
        // itself: our company IS the subject, as for any other company
        // ("SWOT analysis of Lumière Beauty Group" -> "company strengths and
        // weaknesses" is Lumière news; the needs just say "Strengths").
        // A fact or a list about us is decided by its needs as before ("Is
        // Pakistan a good market for our fragrances?" is market news).
        const describesOwn = parts.every((r) => ['framework', 'company_profile'].includes(r.goal));
        if (!allAboutOwn && !describesOwn) {
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
  // A search filtered to some companies does not carry the name of another
  // company from the question (or our own): "competitor activity in
  // Lumière Beauty Group" filtered to the competitors -> the name is taken
  // out, the filter already says whose news it is.
  if (!(side && side.companies) && companies.length) {
    const others = uniq([...companyNames(understood), own].filter(Boolean))
      .filter((n) => !companies.some((c) => same(c, n)));
    const w = ` ${plain(search.words)} `;
    const hit = others.filter((n) => plain(n).length >= 3 && w.includes(` ${plain(n)} `));
    if (hit.length) {
      const KEEP = '\u0000keep';
      search = { ...search, words: wordsForSide(search.words, [{ label: KEEP }, ...hit.map((label) => ({ label }))], KEEP, null) };
      filterWhy = [filterWhy, `words: ${hit.join(', ')} taken out (this search is not filtered to ${hit.length > 1 ? 'them' : 'it'})`].filter(Boolean).join('; ');
    }
  }
  // Only places in our place list are filters: the news is stored under
  // those names ("Morocco"), so a filter on "Maroc" would find nothing. A
  // place we do not know stays in the search words instead (never dropped).
  const notFilters = countries.filter((x) => !placeKnown(x));
  if (notFilters.length) {
    countries = countries.filter(placeKnown);
    const have = new Set(plain(search.words).split(' '));
    const missing = notFilters.filter((x) => !plain(x).split(' ').filter((w) => w !== 'the').every((w) => have.has(w)));
    if (missing.length) {
      const added = addWords(search.words, missing.join(' '));
      search = { ...search, words: added.text };
      if (added.dropped.length) filterWhy = [filterWhy, `words: to fit ${MAX_JOINED_CHARS} letters, left out: ${added.dropped.join(', ')}`].filter(Boolean).join('; ');
    }
    filterWhy = [filterWhy, `places: ${notFilters.join(', ')} not in our place list, so searched by words, not used as a filter`].filter(Boolean).join('; ');
  }
  // "Who owns Huda Beauty today?", "what is the VAT rate today": "today"
  // means "now", not "news from today only". Only news / alert questions
  // (list) keep a today-only filter; any other goal gets no date limit.
  const ranges = (time && time.ranges) || [];
  const onlyToday = ranges.length === 1 && /^today$/i.test(String(ranges[0].text || '').trim())
    && dateFrom === todayOf(understood) && dateTo === dateFrom;
  if (onlyToday && !side && !allList) {
    dateFrom = null;
    dateTo = null;
    filterWhy = [filterWhy, 'dates: "today" here means "now", so no date limit (only news questions keep today\'s date)'].filter(Boolean).join('; ');
  }
  const dates = searchDates(dateFrom, dateTo, todayOf(understood));
  dateFrom = dates.from;
  dateTo = dates.to;

  // Every search keeps what the question is about. The AI often writes
  // only the goal's general needs ("competitor threats", "market risks")
  // and drops the subject; the subject is then added from Step 5. A side
  // search is about its side, so it is left alone.
  if (!exactRead && !side && !search.side) {
    const subjects = questionSubjects(understood);
    if (subjects.length && !keepsSubject(search.words, subjects)) {
      // the main subject is enough to keep the search on topic; adding every
      // subject of a long question makes a word soup (at most 2)
      const add = uniq(subjects.map((x) => x.text)).slice(0, MAX_SUBJECTS_ADDED);
      // a search that is only a piece of the subject ("men" for "men's
      // grooming") becomes the subject, not "men men's grooming"
      const subjectWords = new Set(plain(add.join(' ')).split(' ').map(singular));
      const piece = plain(search.words).split(' ').filter(Boolean).every((w) => subjectWords.has(singular(w)));
      // only the subject words the search does not have yet: "emerging
      // trends" added to "Saudi retail trends" gave "... trends emerging
      // trends", "launching in Turkey" to "Turkey cosmetics ..." repeated
      // Turkey, "Estée Lauder activity" repeated the company (21 Nov)
      const have = new Set(plain(search.words).split(' ').filter(Boolean).map(singular));
      const fresh = tidyJoins(add.join(' ').split(/\s+/).filter((tok) => {
        const ws = plain(tok).split(' ').filter((w) => w.length > 1);
        return ws.length > 0 && !ws.every((w) => have.has(singular(w)));
      }).join(' '));
      const addText = piece ? add.join(' ') : fresh;
      const added = piece ? { text: addText, dropped: [] } : addWords(search.words, addText);
      search = { ...search, words: added.text };
      filterWhy = [filterWhy, `words: the subject (${piece ? add.join(', ') : addText}) added, the search had lost it`].filter(Boolean).join('; ');
      if (added.dropped.length) filterWhy = [filterWhy, `words: to fit ${MAX_JOINED_CHARS} letters, left out: ${added.dropped.join(', ')}`].filter(Boolean).join('; ');
    }
  }
  // 26 Nov (playground): "Is the Gulf a good place for us to grow?" was
  // searched as "market demand signals unmet needs … growth" - no word said
  // WHICH business, so it found a fashion app and sovereign funds and still
  // answered "yes". When the question is about the client's own business
  // ("us", "we", "our") and names no industry, no product and no company,
  // a search that does not name the client's industry gets it
  // ("cosmetics"): the client's business IS the subject. A question that
  // names an industry ("EV market"), a product or a company, or that is not
  // about the client, keeps its words as they are.
  const clientIndustry = understood.client && understood.client.industry;
  const namesBusiness = (understood.industries || []).length || (understood.products || []).length || companyNames(understood).length;
  if (!exactRead && !side && !search.side && clientIndustry && understood.about_own_business && !namesBusiness && questionInEnglish(understood)) {
    const have = new Set(plain(search.words).split(' ').filter(Boolean).map(singular));
    const ind = plain(clientIndustry).split(' ').filter((w) => w.length > 1);
    if (ind.length && !ind.every((w) => have.has(singular(w)))) {
      const added = addWords(search.words, clientIndustry.toLowerCase());
      if (added.text !== search.words) {
        search = { ...search, words: added.text };
        filterWhy = [filterWhy, `words: the client's industry (${clientIndustry.toLowerCase()}) added, the question names no kind of business`].filter(Boolean).join('; ');
      }
    }
  }
  // A name the user left out never stays in the search words ("GCC trends
  // excluding Kuwait" would pull Kuwait news by meaning), nor in the filters.
  const ex = userLeftOut(understood);
  const leftNamed = namesLeftOut(search.words, ex);
  if (leftNamed.length) {
    const KEEP = '\u0000keep';
    let w = wordsForSide(search.words, [{ label: KEEP }, ...leftNamed.map((label) => ({ label }))], KEEP, null);
    for (const n of leftNamed) for (const f of placeShortNames(n)) w = w.replace(new RegExp(`(?<![\\p{L}\\p{N}])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
    w = tidyJoins(w.replace(EXCLUDE_WORDS_RE, ' ').replace(/\s+/g, ' ').trim());
    search = { ...search, words: w || search.words };
    filterWhy = [filterWhy, `words: ${leftNamed.join(', ')} taken out (the user left ${leftNamed.length > 1 ? 'them' : 'it'} out)`].filter(Boolean).join('; ');
  }
  countries = countries.filter((c) => !ex.places.some((x) => same(x, c)));
  // "Global" / "worldwide" means every country, not only the news tagged
  // "Global" (24 Nov, Sneha OK): a search that is not one side of a
  // comparison then has no country filter. (A "Global" side, "UAE vs
  // global", keeps the filter: that side IS the worldwide news.)
  if (!(side && side.countries) && countries.includes('Global')) {
    countries = [];
    filterWhy = [filterWhy, 'places: "Global" means every country, so no country filter'].filter(Boolean).join('; ');
  }
  companies = companies.filter((c) => !ex.companies.some((x) => same(x, c)));
  const inputs = {};
  if (!exactRead) inputs.query = cleanSearchWords(withoutOwnWords(search.words, understood));
  inputs.modules = (exactRead || allList) && named.length ? named : [...MODULES];
  if (dateFrom) inputs.date_from = dateFrom;
  if (dateTo) inputs.date_to = dateTo;
  if (companies.length) inputs.companies = companies.slice(0, 20);
  if (countries.length) inputs.countries = countries.slice(0, 20);
  if (ex.places.length) inputs.not_countries = ex.places.slice(0, 20);
  if (ex.companies.length) inputs.not_companies = ex.companies.slice(0, 20);
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
      // the part's own results and own searches come before the results of
      // the parts it waits for, so its own evidence is never cut off
      inputs = { inputs: take([done.compare, done.identify_patterns, done.analyse_risks, ...E, ...U], 4) };
    } else if (job === 'discover_opportunities') {
      inputs = { inputs: take([done.identify_patterns, done.identify_gaps, done.compare, ...E, ...U], 4) };
    } else if (job === 'summarise') {
      inputs = { input: take([...Object.values(done), ...E, ...U], 6), focus: `${GOAL_LABELS[part.goal]}: ${topic}`.slice(0, 200) };
      const fh = part.goal === 'framework' ? frameworkHeadings(question) : { headings: null, left_out: [] };
      if (fh.headings) inputs.headings = fh.headings;
      if (fh.left_out.length) notes.push(`${part.requirement_id}: at most ${MAX_HEADINGS} headings in one summary, so ${fh.left_out.join(', ')} is left out (the other frameworks are done)`);
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
    // The part's results = its last job AND every other job or search of
    // the part that no later job of the part uses ("extract facts" before a
    // "compare" that only takes the sides). Nothing is fetched or worked
    // out for nothing: it goes on to the evidence check and the answer.
    const refsOf = (taskId) => {
      const t = tasks.find((x) => x.task_id === taskId);
      return t ? (JSON.stringify(t.inputs).match(/T\d+/g) || []) : [];
    };
    const ids = uniq(local);
    const used = new Set(ids.flatMap(refsOf));
    const leaves = ids.filter((x) => !used.has(x));
    const last = local[local.length - 1];
    const unusedSearches = E.map((r) => r.replace('.output', '')).filter((x) => !used.has(x));
    finals[id] = local.length
      ? uniq([last, ...leaves.filter((x) => x !== last), ...unusedSearches]).map((x) => `${x}.output`)
      : E;
  }

  // the evidence check, once, at the end. Each part's main result first;
  // what does not fit (at most 8) is reported back as "overflow", so the
  // caller can take out a helper job instead of leaving a result unused.
  const MAX_FINDINGS = (getCapability('validate_evidence').inputs.findings || {}).max || 8;
  const allFindings = uniq([
    ...plan.requirements.map((r) => (finals[r.requirement_id] || [])[0]),
    ...plan.requirements.flatMap((r) => (finals[r.requirement_id] || []).slice(1)),
  ].filter(Boolean));
  const findings = allFindings.slice(0, MAX_FINDINGS);
  const overflow = allFindings.slice(MAX_FINDINGS).map((x) => x.replace('.output', ''));
  if (findings.length) {
    add({ capability: 'validate_evidence', inputs: { findings }, for_requirements: plan.requirements.map((r) => r.requirement_id), why: 'check every finding has real evidence' });
  }

  // "waits for" = every earlier task whose result a task uses
  for (const t of tasks) {
    const refs = JSON.stringify(t.inputs).match(/T\d+\.output/g) || [];
    t.depends_on = uniq(refs.map((r) => r.replace('.output', ''))).filter((x) => x !== t.task_id);
  }
  return { tasks, finals, overflow };
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
  // What the user LEFT OUT (Step 5, "except Kuwait") is never searched: the
  // client's competitor list loses it (all competitors except Lancôme), an
  // AI side naming it is not a side, and every search carries it so Step 9
  // drops that news (also inside a region: GCC minus Kuwait).
  const ex = userLeftOut(understood);
  if (ex.places.length || ex.companies.length) {
    const view = withoutLeftOut(understood);
    if (view !== understood) notes.push(`competitors: ${ex.companies.join(', ')} left out, as the user said`);
    understood = view;
    if (aiSideNames && aiSideNames.length) {
      const kept = aiSideNames.filter((n) => !namesLeftOut(n, ex).length);
      if (kept.length < aiSideNames.length) notes.push(`sides: ${aiSideNames.filter((n) => !kept.includes(n)).join(', ')} not a side (the user left it out)`);
      aiSideNames = kept;
    }
  }
  // the sides of any comparison are chosen once, for every part of the build
  if (!understood.question_text) understood = { ...understood, question_text: question };
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
  // 3b. more results than the evidence check can take: a helper job whose
  //     result nothing else uses is taken out (never a key job)
  while (built.overflow.length && guard++ < 140) {
    let cut = false;
    for (const tid of built.overflow) {
      const t = built.tasks.find((x) => x.task_id === tid);
      if (!t || !HELPER_JOBS.includes(t.capability)) continue;
      const r = working.requirements.find((x) => (t.for_requirements || []).includes(x.requirement_id) &&
        x.analysis.includes(t.capability) && GOAL_KEY_JOB[x.goal] !== t.capability);
      if (!r) continue;
      r.analysis = r.analysis.filter((j) => j !== t.capability);
      removed.push({ what: 'analysis', value: `${t.capability} (${r.requirement_id})`, why: 'its result would not fit in the evidence check (at most 8 results): helper job taken out' });
      cut = true;
      break;
    }
    if (!cut) {
      // no helper to take out: a part's own searches are joined into one
      // (nothing asked for is lost), the part with the most searches first
      const parts = [...working.requirements].sort((a, b) =>
        searches.filter((x) => !x.side && x.for.length === 1 && x.for[0] === b.requirement_id).length -
        searches.filter((x) => !x.side && x.for.length === 1 && x.for[0] === a.requirement_id).length);
      const r = parts[0];
      const own = r ? searches.filter((x) => !x.side && x.for.length === 1 && x.for[0] === r.requirement_id) : [];
      if (own.length < 2) break;
      searches = replaceIn(searches, own, mergeSearches(own));
      removed.push({ what: 'search', value: own.map((x) => x.words).join(' + '), why: `more results than the evidence check can take (at most 8): ${own.length} searches of ${r.requirement_id} joined into one` });
    }
    built = build();
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
    question_text: understood.question_text,   // the question the plan was built for (shown in reports / Phoenix)
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
  // the question is kept with Step 5's result, so the sides of a comparison
  // can be chosen by the words next to "compare / vs"
  understood = { ...understood, question_text: question };
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
  frameworkHeadings,
  listTopicWords,
  ownNamedInQuestion,
  withoutOwnWords,
  asksOnlyForLatest,
  codeSides,
  sideChoices,
  sideOptions,
  sideCore,
  sideInQuestion,
  sidesFromSearches,
  cleanSearchWords,
  placeKnown,
  compareWords,
  namedInText,
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
