/**
 * modules/dynamicRag/planTasks.js
 *
 * STEP 6 of the manager's doc — "Task planning".
 *
 * Job: turn what Step 5 understood (the user's goals, companies, places,
 * dates) into a WORK PLAN: for every goal, what information is needed and
 * what analysis must be done. Govind calls this plan the "Information
 * Requirement Specification" (IRS).
 *
 *   QUESTION  "Compare Saudi and UAE retail and find opportunities"
 *   PLAN      IR1  comparison     needs: market activity, demand, competitor moves   analysis: compare
 *             IR2  opportunities  needs: gaps, unmet needs, demand changes          analysis: identify_gaps,
 *                                 waits for IR1                                               discover_opportunities
 *
 * Who does what (manager's rule: the AI suggests, Node.js checks):
 *   AI   writes the plan (1 AI call), using the job list (capabilityRegistry.js)
 *        and Govind's information templates (in the prompt, prompts table).
 *   code checks the plan:
 *        - every user goal has at least one requirement. If one is missing,
 *          the AI is asked once more; if it is still missing, code adds it
 *          (marked added_by_code). A goal is never silently dropped.
 *        - places, companies, industry and dates are copied from Step 5 by
 *          code, never taken from the AI (the AI cannot add Bahrain).
 *        - analysis names must be analysis jobs from the job list, and needed
 *          for the goals the user asked (no "find opportunities" in a plain
 *          comparison); anything else is removed and listed in removed_by_check.
 *        - one requirement per goal: several requirements for the same goal
 *          are merged into one (no padding, no repeated searches).
 *        - each goal keeps its key job (a comparison must compare, a trends
 *          question must look for patterns): added by code if the AI left it out.
 *        - date words are taken out of "information needed" (dates come from
 *          Step 5, worked out by code).
 *        - "waits for" may only point to an EARLIER requirement (no loops).
 *        - at least one requirement is essential; at most 6 requirements.
 *        - validate_evidence is always added once at the end, by code.
 *
 * What Step 6 does NOT do: search anything, decide the order of the search
 * jobs (Step 7), check the full job graph (Step 8), or answer.
 * Nothing in this file is about one client.
 */

const { callLLM } = require('../llmClient');
const { requirePrompt } = require('../promptStore');
const { ChatError } = require('./chatError');
const { PLAN_PROMPT_ID } = require('./chatConfig');
const { preprocessText } = require('./preprocessQuery');   // only to spot date words
const { CAPABILITIES, GOAL_GUIDE, GOAL_KEY_JOB, SEARCH_JOBS } = require('./capabilityRegistry');

const MAX_ATTEMPTS = 2;          // ask the AI at most twice
const MAX_REQUIREMENTS = 6;
const MAX_NEEDS = 6;             // information_needed phrases per requirement
const MAX_SECTIONS = 8;
const MAX_ITEM_CHARS = 120;

// Analysis jobs the plan may name: every job offered to the planner, except
// the search jobs, filter_data (those are chosen in Step 7) and
// validate_evidence (code always adds it once, at the end).
const ANALYSIS_JOBS = CAPABILITIES
  .filter((c) => c.offered_to_planner)
  .map((c) => c.id)
  .filter((id) => !SEARCH_JOBS.includes(id) && id !== 'filter_data' && id !== 'validate_evidence');

// Jobs that fit any goal (pull facts, summarise, group). Every other analysis
// job is only allowed when one of the user's goals usually needs it.
const HELPER_JOBS = ['extract_facts', 'summarise', 'cluster'];

/** Analysis jobs allowed for this question: helpers + the jobs the user's goals use. */
function allowedJobsFor(goals) {
  const allowed = new Set(HELPER_JOBS.filter((j) => ANALYSIS_JOBS.includes(j)));
  for (const g of goals) for (const j of GOAL_GUIDE[g] || []) if (ANALYSIS_JOBS.includes(j)) allowed.add(j);
  return allowed;
}

// Plain names of the goals (for the sections of the answer and the fallback).
const GOAL_LABELS = {
  fact_lookup: 'Facts', list: 'Latest items', company_profile: 'Company profile', trends: 'Trends',
  comparison: 'Comparison', opportunities: 'Opportunities', competitor_analysis: 'Competitor analysis',
  market_entry: 'Market entry', feasibility: 'Feasibility', forecast: 'Outlook', risks: 'Risks',
  campaign_ideas: 'Campaign ideas', strategy: 'Strategy', framework: 'Framework analysis',
};

// ═════════════════════════════════════════════════════════════════════════
// 1. What the AI is given (data only — the instruction is in the prompts table)
// ═════════════════════════════════════════════════════════════════════════
const goalsOf = (understood) => [understood.primary_goal, ...(understood.secondary_goals || [])];
const names = (list) => (list || []).map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean);
const show = (list) => (list && list.length ? list.join(', ') : '-');

function buildMessage(question, understood) {
  const goals = goalsOf(understood);
  const t = understood.time;
  const dates = t ? `${t.ranges.map((r) => r.text).join(', ')} (${t.from} to ${t.to})` : '-';
  const jobs = CAPABILITIES.filter((c) => ANALYSIS_JOBS.includes(c.id)).map((c) => `- ${c.id}: ${c.description}`);
  const guide = goals.map((g) => `- ${g}: ${(GOAL_GUIDE[g] || []).filter((j) => ANALYSIS_JOBS.includes(j)).join(', ') || '(no analysis job needed)'}`);
  return [
    `QUESTION:\n"""\n${question}\n"""`,
    `GOALS (main goal first): ${goals.join(', ')}`,
    'WHAT WAS FOUND IN THE QUESTION:',
    `companies: ${show(names(understood.companies))}`,
    `places: ${show(understood.places)}`,
    `industries: ${show(understood.industries)}`,
    `products: ${show(understood.products)}`,
    `topics: ${show(understood.topics)}`,
    `metrics: ${show(understood.metrics)}`,
    `dates: ${dates}`,
    `about the client own business: ${understood.about_own_business ? 'yes' : 'no'} (client industry: ${(understood.client && understood.client.industry) || '-'})`,
    `about the client competitors in general: ${understood.all_competitors ? 'yes' : 'no'}`,
    `ANALYSIS JOBS (use only these ids):\n${jobs.join('\n')}`,
    `USUAL ANALYSIS PER GOAL (a guide, not a rule):\n${guide.join('\n')}`,
  ].join('\n');
}

// ═════════════════════════════════════════════════════════════════════════
// 2. Reading the AI's plan (no AI, no database — easy to test)
// ═════════════════════════════════════════════════════════════════════════
const cleanItem = (v) => String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS);

// removed / what: optional. Items past max are recorded there, never dropped silently.
function cleanList(value, max, removed = null, what = 'item') {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const item = cleanItem(v);
    if (!item || out.some((o) => o.toLowerCase() === item.toLowerCase())) continue;
    if (out.length >= max) {
      if (removed) removed.push({ what, value: item, why: `over the limit of ${max}` });
      continue;
    }
    out.push(item);
  }
  return out;
}

// Needs are search words, so they must be plain words: "market_position" -> "market position".
const plainNeed = (text) => String(text).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * JSON.parse that also accepts the small slips Llama makes at the end of a
 * long reply: a comma before } or ], or one or two closing brackets too many
 * ("...]]}" or "...]}}"). Nothing else is guessed.
 * @returns the parsed value, or undefined when it still cannot be read
 */
function parseJsonLoose(text) {
  // also: a comma missing between two items ("} {" or "\"a\" \"b\"")
  const commas = (t) => t.replace(/}\s*{/g, '},{').replace(/"\s*\n\s*"/g, '",\n"');
  // an apostrophe written the wrong way inside a word: "men\'s" (not a JSON
  // escape) or "men"s" (a double quote) -> "men's"
  const apostrophes = (t) => t.replace(/\\'/g, "'").replace(/(\p{L})"(s|t|re|ll|ve|d)\b(?!\s*[:,}\]])/gu, "$1'$2");
  const fixed = apostrophes(String(text));
  const variants = fixed === text ? [text] : [text, fixed];
  const base = variants.flatMap((t) => [t, t.replace(/,\s*([}\]])/g, '$1'), commas(t), commas(t).replace(/,\s*([}\]])/g, '$1')]);
  const tries = [...base];
  // the closing brackets at the very end, e.g. "]]}" or "]}}": try taking out
  // one of them, then two of them
  for (const t of base) {
    const run = (t.match(/[}\]\s]+$/) || [''])[0];
    const head = t.slice(0, t.length - run.length);
    const brackets = run.replace(/\s/g, '');
    for (let i = 0; i < brackets.length; i++) {
      const one = brackets.slice(0, i) + brackets.slice(i + 1);
      tries.push(head + one);
      for (let j = 0; j < one.length; j++) tries.push(head + one.slice(0, j) + one.slice(j + 1));
    }
  }
  // a reply cut short or missing its last brackets: add the missing ones
  for (const t of base) tries.push(t + missingClosers(t));
  for (const t of tries) {
    try { return JSON.parse(t); } catch (err) { /* try the next one */ }
  }
  return undefined;
}

// The closing brackets a JSON text still needs ("{"a": [1" -> "]}"),
// ignoring brackets inside strings.
function missingClosers(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of String(text)) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if ((ch === '}' || ch === ']') && stack[stack.length - 1] === ch) stack.pop();
  }
  return (inString ? '"' : '') + stack.reverse().join('');
}

/**
 * Dates are worked out by code in Step 5, so date words in "information
 * needed" are taken out: "Shiseido sales last 6 months" -> "Shiseido sales".
 * A phrase that is only a date ("last 6 months data") is dropped.
 */
// Month names left behind when only part of a date was spotted ("between March
// and June 2025": "June 2025" is spotted, "March" is left). "May" is not here:
// it is also an ordinary word.
const MONTH_WORDS = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
// Little words that mean nothing once the date is gone.
const DATE_GLUE = /\b(?:between|within|until|till|from|since|during)\b/gi;

function withoutDateWords(items, removed) {
  const out = [];
  const keep = (text) => { if (!out.some((o) => o.toLowerCase() === text.toLowerCase())) out.push(text); };
  for (const item of items) {
    const p = preprocessText(item, [], [], { fixWords: false });   // find dates only, never change names
    if (p.time_expressions.length === 0) { keep(item); continue; }
    let rest = p.preprocessed_query;
    for (const t of p.time_expressions) rest = rest.split(t.text).join(' ');
    rest = rest
      .replace(/(^|\s)'s\b/gi, ' ')            // "today's highlights" -> "highlights"
      .replace(MONTH_WORDS, ' ')
      .replace(DATE_GLUE, ' ')
      .replace(/\s+/g, ' ').trim();
    // drop little words left hanging at either end: "trends over the" -> "trends"
    const EDGE = /^(?:in|of|for|over|during|the|from|to|since|and|by|at|on|about|vs|versus|compared to|than|,|-)\s+|\s+(?:in|of|for|over|during|the|from|to|since|and|by|at|on|about|vs|versus|compared to|than|,|-)$/i;
    while (EDGE.test(rest)) rest = rest.replace(EDGE, '').trim();
    // "news from about fragrance" -> "news about fragrance": the middle words left alone are fine,
    // but two little words in a row are not.
    rest = rest.replace(/\b(from|of|in|for|to)\s+(about|of|in|for|to)\b/gi, '$2');
    const left = rest.replace(/\b(data|figures|period|information|info)\b/gi, '').replace(/[\s,.;-]+/g, ' ').trim();
    if (left.length >= 3) {
      keep(rest);
      removed.push({ what: 'information_needed', value: item, why: `date words taken out (dates come from Step 5), kept "${rest}"` });
    } else {
      removed.push({ what: 'information_needed', value: item, why: 'only a date (dates come from Step 5)' });
    }
  }
  return out;
}

// A need made only of words like "dates", "source", "impact", "latest items"
// is not something to search for: every answer already shows the dates and
// sources of its evidence. Such needs are removed (and recorded).
const META_WORDS = new Set([
  'date', 'dates', 'time', 'timeline', 'timelines', 'period', 'periods', 'data', 'figure', 'figures',
  'information', 'info', 'source', 'sources', 'reference', 'references', 'citation', 'citations',
  'detail', 'details', 'exact', 'fact', 'facts', 'impact', 'impacts', 'item', 'items', 'latest', 'recent',
  'current', 'reliability', 'of', 'the', 'a', 'an', 'and', 'or', 'for', 'about', 'on', 'in', 'to', 'its', 'their',
  'all', 'any', 'each', 'this', 'that', 'these', 'those', 'with',
]);
const isOnlyMetaWords = (text) => {
  const words = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => META_WORDS.has(w));
};
function withoutMetaNeeds(items, removed) {
  return items.filter((item) => {
    if (!isOnlyMetaWords(item)) return true;
    removed.push({ what: 'information_needed', value: item, why: 'not something to search for (dates and sources come with every answer)' });
    return false;
  });
}

/**
 * Reads the AI reply and checks every part of it against the user's goals
 * and the job list. Never uses anything the AI made up.
 *
 * @param replyText  the AI's raw reply
 * @param goals      the user's goals from Step 5 (main goal first)
 * @returns { plan, problem, removed }
 *   plan     { requirements, output_sections } or null if the reply cannot be used
 *   problem  why it cannot be used, in words the AI can act on when asked again
 *   removed  what the check took out of the AI's plan, and why
 */
function checkAiPlan(replyText, goals) {
  const removed = [];
  const text = String(replyText || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { plan: null, problem: 'there is no JSON object in it', removed };

  const p = parseJsonLoose(text.slice(start, end + 1));
  if (p === undefined) return { plan: null, problem: 'the JSON is broken', removed };
  if (!p || typeof p !== 'object' || Array.isArray(p) || !Array.isArray(p.requirements)) {
    return { plan: null, problem: 'it has no "requirements" list', removed };
  }

  // The code gives the ids (IR1, IR2...) itself, in order. The AI's own ids
  // are only used to find what "depends_on" points to.
  const requirements = [];
  const aiIdToOurs = new Map();
  const allowed = allowedJobsFor(goals);
  for (const raw of p.requirements) {
    if (!raw || typeof raw !== 'object') continue;
    const goal = String(raw.goal || '').trim().toLowerCase();
    if (!goals.includes(goal)) {
      removed.push({ what: 'requirement', value: goal || '(no goal)', why: 'its goal is not one of the user goals' });
      continue;
    }
    const needs = withoutMetaNeeds(withoutDateWords(
      cleanList((Array.isArray(raw.information_needed) ? raw.information_needed : []).map((n) => (typeof n === 'string' ? plainNeed(n) : n)),
        MAX_NEEDS, removed, 'information_needed'),
      removed), removed);
    if (needs.length === 0) {
      removed.push({ what: 'requirement', value: goal, why: 'it says no information is needed' });
      continue;
    }
    const analysis = [];
    for (const a of Array.isArray(raw.analysis) ? raw.analysis : []) {
      const job = String(a || '').trim().toLowerCase();
      if (job === 'validate_evidence') continue;            // code adds it once, at the end
      if (!ANALYSIS_JOBS.includes(job)) {
        removed.push({ what: 'analysis', value: job, why: 'not an analysis job in the job list' });
        continue;
      }
      if (!allowed.has(job)) {
        removed.push({ what: 'analysis', value: job, why: 'not needed for the goals the user asked' });
        continue;
      }
      if (!analysis.includes(job)) analysis.push(job);
    }
    const id = `IR${requirements.length + 1}`;
    if (raw.id !== undefined) aiIdToOurs.set(String(raw.id).trim().toUpperCase(), id);
    requirements.push({
      requirement_id: id,
      goal,
      information_needed: needs,
      analysis,
      priority: String(raw.priority || '').trim().toLowerCase() === 'optional' ? 'optional' : 'essential',
      depends_on_ai: Array.isArray(raw.depends_on) ? raw.depends_on : [],
    });
  }
  if (requirements.length === 0) {
    return { plan: null, problem: 'none of its requirements is for one of the GOALS', removed };
  }

  // "waits for" may only point to an EARLIER requirement: no loops possible.
  requirements.forEach((r, i) => {
    const deps = [];
    for (const d of r.depends_on_ai) {
      const ours = aiIdToOurs.get(String(d || '').trim().toUpperCase());
      const pos = ours ? Number(ours.slice(2)) - 1 : -1;
      if (pos >= 0 && pos < i) {
        if (!deps.includes(ours)) deps.push(ours);
      } else {
        removed.push({ what: 'depends_on', value: `${r.requirement_id} -> ${d}`, why: 'it does not point to an earlier requirement' });
      }
    }
    r.depends_on = deps;
    delete r.depends_on_ai;
  });

  const merged = mergeSameGoal(requirements, removed);
  return {
    plan: { requirements: merged, output_sections: cleanList(p.output_sections, MAX_SECTIONS, removed, 'output_section') },
    problem: null,
    removed,
  };
}

/**
 * One requirement per goal: requirements for the same goal are merged into
 * the first one (needs and analysis joined, "waits for" kept). Then at most
 * MAX_REQUIREMENTS are kept and the ids are given again in order.
 */
function mergeSameGoal(requirements, removed) {
  const byGoal = new Map();     // goal -> merged requirement
  const idTo = new Map();       // old id -> merged requirement
  const order = [];
  for (const r of requirements) {
    const into = byGoal.get(r.goal);
    if (!into) {
      const copy = { ...r, information_needed: [...r.information_needed], analysis: [...r.analysis], depends_on: [...r.depends_on] };
      byGoal.set(r.goal, copy);
      idTo.set(r.requirement_id, copy);
      order.push(copy);
      continue;
    }
    for (const n of r.information_needed) {
      if (into.information_needed.some((x) => x.toLowerCase() === n.toLowerCase())) continue;
      if (into.information_needed.length < MAX_NEEDS) into.information_needed.push(n);
      else removed.push({ what: 'information_needed', value: n, why: `over the limit of ${MAX_NEEDS} when merging ${r.requirement_id} into ${into.requirement_id}` });
    }
    for (const a of r.analysis) if (!into.analysis.includes(a)) into.analysis.push(a);
    for (const d of r.depends_on) if (!into.depends_on.includes(d)) into.depends_on.push(d);
    if (r.priority === 'essential') into.priority = 'essential';
    idTo.set(r.requirement_id, into);
    removed.push({ what: 'requirement', value: `${r.requirement_id} (${r.goal})`, why: `same goal as ${into.requirement_id}: merged into it` });
  }
  const kept = order.slice(0, MAX_REQUIREMENTS);
  for (const r of order.slice(MAX_REQUIREMENTS)) {
    removed.push({ what: 'requirement', value: r.goal, why: `more than ${MAX_REQUIREMENTS} requirements` });
  }
  // New ids in order; "waits for" points to the merged requirement, only an earlier one.
  const newId = new Map(kept.map((r, i) => [r, `IR${i + 1}`]));
  return kept.map((r, i) => {
    const deps = [];
    for (const d of r.depends_on) {
      const target = idTo.get(d);
      const pos = target ? kept.indexOf(target) : -1;
      if (pos >= 0 && pos < i) {
        const id = newId.get(target);
        if (!deps.includes(id)) deps.push(id);
      }
    }
    return { ...r, requirement_id: newId.get(r), depends_on: deps };
  });
}

/** The user's goals that have no requirement in the plan. */
const missingGoals = (plan, goals) => goals.filter((g) => !plan.requirements.some((r) => r.goal === g));

// ═════════════════════════════════════════════════════════════════════════
// 3. Finishing the plan in code (no AI — easy to test)
// ═════════════════════════════════════════════════════════════════════════
/**
 * Adds what only code may decide: missing goals, places, companies,
 * industry, dates, priorities, the final evidence check, answer sections.
 *
 * @param plan        what checkAiPlan() returned (plan part)
 * @param understood  what Step 5 returned
 * @returns the finished plan (the IRS)
 */
function finishPlan(plan, understood) {
  const goals = goalsOf(understood);
  const notes = [];
  const requirements = plan.requirements.map((r) => ({ ...r }));

  // A goal the AI left out is added from the job guide, marked as added by code.
  for (const g of missingGoals({ requirements }, goals)) {
    if (requirements.length >= MAX_REQUIREMENTS) {
      notes.push(`goal "${g}" could not be added: already ${MAX_REQUIREMENTS} requirements`);
      continue;
    }
    const subject = [...names(understood.companies), ...(understood.places || []), ...(understood.products || []),
      ...(understood.topics || []), ...(understood.industries || [])].slice(0, 3).join(', ');
    requirements.push({
      requirement_id: `IR${requirements.length + 1}`,
      goal: g,
      information_needed: [`evidence for ${GOAL_LABELS[g].toLowerCase()}${subject ? ` about ${subject}` : ''}`],
      analysis: (GOAL_GUIDE[g] || []).filter((j) => ANALYSIS_JOBS.includes(j)),
      priority: g === goals[0] ? 'essential' : 'optional',
      depends_on: [],
      added_by_code: true,
    });
    notes.push(`goal "${g}" was missing from the AI plan: added by code`);
  }

  // A requirement with no analysis gets the usual analysis for its goal
  // (a "list" goal needs none: it is shown as it is found).
  for (const r of requirements) {
    if (r.analysis.length === 0) {
      const usual = (GOAL_GUIDE[r.goal] || []).filter((j) => ANALYSIS_JOBS.includes(j));
      if (usual.length) {
        r.analysis = usual;
        notes.push(`${r.requirement_id}: no analysis given, the usual analysis for "${r.goal}" was added`);
      }
    }
  }

  // Each goal keeps its key job (a comparison must compare...).
  for (const r of requirements) {
    const key = GOAL_KEY_JOB[r.goal];
    if (key && !r.analysis.includes(key)) {
      r.analysis = [...r.analysis, key];
      notes.push(`${r.requirement_id}: key job "${key}" for "${r.goal}" was missing, added by code`);
    }
  }

  // The main goal is always essential.
  for (const r of requirements) {
    if (r.goal === goals[0] && r.priority !== 'essential') {
      r.priority = 'essential';
      notes.push(`${r.requirement_id}: main goal, set to essential`);
    }
  }

  // Places, companies, industry and dates come from Step 5 — never from the AI.
  const industries = (understood.industries && understood.industries.length)
    ? understood.industries
    : (understood.client && understood.client.industry ? [understood.client.industry] : []);
  const scope = {
    geography: [...(understood.places || [])],
    companies: (understood.companies || []).map((c) => ({
      name: c.name,
      id: c.matched ? c.matched.id || null : null,
      type: c.matched ? c.matched.type : 'not_listed',
    })),
    industry: industries,
    industry_from: (understood.industries && understood.industries.length) ? 'question' : 'client profile',
    products: [...(understood.products || [])],
    // from/to = the whole span. ranges = each date the user named, kept apart
    // ("compare 2023 with 2025" is two years, not 2023 to 2025).
    time_scope: understood.time ? {
      from: understood.time.from,
      to: understood.time.to,
      text: understood.time.ranges.map((x) => x.text).join(', '),
      ranges: understood.time.ranges.map((x) => ({ text: x.text, from: x.from, to: x.to })),
    } : null,
    about_own_business: Boolean(understood.about_own_business),
    all_competitors: Boolean(understood.all_competitors),
    places_not_in_list: [...(understood.places_not_in_list || [])],
  };
  const finished = requirements.map((r) => ({ ...r, ...scope }));

  // All analysis in the plan, in first-used order, plus the final evidence check.
  const analysisRequired = [];
  for (const r of finished) for (const a of r.analysis) if (!analysisRequired.includes(a)) analysisRequired.push(a);
  analysisRequired.push('validate_evidence');

  // Sections of the final answer: the AI's, or one per goal.
  const sections = plan.output_sections && plan.output_sections.length
    ? plan.output_sections
    : goals.map((g) => GOAL_LABELS[g]);

  return {
    objectives: goals,
    requirements: finished,
    analysis_required: analysisRequired,
    output_sections: sections,
    notes,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Step 6 main
// ═════════════════════════════════════════════════════════════════════════
/**
 * @param cleaned     what Step 2 returned (needs preprocessed_query)
 * @param understood  what Step 5 returned (status 'understood')
 * @returns {
 *   status: 'planned',
 *   plan_id,
 *   objectives          the user's goals, main goal first
 *   requirements        [{ requirement_id, goal, information_needed, analysis, priority,
 *                          depends_on, geography, companies, industry, industry_from,
 *                          products, time_scope, about_own_business, added_by_code? }]
 *   analysis_required   every analysis job in the plan + validate_evidence
 *   output_sections     sections of the final answer
 *   removed_by_check    what code took out of the AI plan, and why
 *   notes               what code added or changed, and why
 *   attempts            AI calls used
 *   ai_problems         why each unusable AI reply could not be used (to find the cause)
 *   built_by_code       true when the AI never gave a usable plan and code built it
 *                       from the job guide (one requirement per goal). The chat goes on.
 * }
 * @throws ChatError 503 only if the AI could not be reached at all
 */
async function planTasks(cleaned, understood) {
  const question = cleaned.preprocessed_query;
  const goals = goalsOf(understood);
  const prompt = await requirePrompt(PLAN_PROMPT_ID);

  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: buildMessage(question, understood) },
  ];

  // Ask the AI. If the plan cannot be used, or misses a goal, ask once more
  // and say exactly what was wrong. If a goal is still missing after that,
  // code adds it (finishPlan).
  let best = null;           // the best usable plan so far
  let removed = [];
  let attempts = 0;
  let lastProblem = '';
  let aiReplied = false;
  const aiProblems = [];
  let conversation = messages;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    let reply = null;
    try {
      // 1500 tokens: plans for 4-5 goals are long; a cut-off reply is broken JSON.
      reply = await callLLM(conversation, { temperature: 0, max_tokens: 1500, timeout: 45000, maxRetries: 2 });
    } catch (err) {
      lastProblem = `AI call failed: ${err.message}`;
      console.log(`[DynamicRAG] planTasks attempt ${attempts}: ${lastProblem}`);
      continue;
    }
    aiReplied = true;
    const checked = checkAiPlan(reply, goals);
    let problem = checked.problem;
    if (checked.plan) {
      best = checked.plan;
      removed = checked.removed;
      const missing = missingGoals(checked.plan, goals);
      if (missing.length === 0) break;
      problem = `it has no requirement for the goal(s) ${missing.join(', ')}. Every goal in GOALS needs at least one requirement`;
    }
    lastProblem = `${problem}. Reply was: ${String(reply).slice(0, 300)}`;
    aiProblems.push(`attempt ${attempts}: ${problem} (reply ${String(reply).length} characters, ends with: ${JSON.stringify(String(reply).slice(-60))})`);
    console.log(`[DynamicRAG] planTasks attempt ${attempts}: ${lastProblem}`);
    conversation = [
      ...messages,
      { role: 'assistant', content: String(reply) },
      { role: 'user', content: `That plan cannot be used as it is because ${problem}. Reply again with ONLY the JSON object.` },
    ];
  }

  if (!best && !aiReplied) {
    console.error(`[DynamicRAG] planTasks gave up after ${attempts} attempts. ${lastProblem}`);
    throw new ChatError(503, 'AI_UNAVAILABLE', 'I could not process your question right now. Please try again in a moment.');
  }
  // The AI answered, but never with a usable plan: code builds the plan from
  // the job guide (finishPlan adds every goal). The question still gets answered.
  const builtByCode = !best;
  if (builtByCode) {
    console.log(`[DynamicRAG] planTasks: no usable AI plan after ${attempts} attempts, plan built by code. ${lastProblem}`);
    best = { requirements: [], output_sections: [] };
  }

  const finished = finishPlan(best, understood);
  return {
    status: 'planned',
    plan_id: `plan_${Date.now().toString(36)}`,
    ...finished,
    removed_by_check: removed,
    attempts,
    ai_problems: aiProblems,
    built_by_code: builtByCode,
  };
}

module.exports = {
  planTasks,
  // parts, exported for the test file
  ANALYSIS_JOBS,
  allowedJobsFor,
  parseJsonLoose,
  buildMessage,
  withoutDateWords,
  withoutMetaNeeds,
  mergeSameGoal,
  checkAiPlan,
  missingGoals,
  finishPlan,
};
