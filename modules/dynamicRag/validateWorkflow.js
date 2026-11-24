/**
 * modules/dynamicRag/validateWorkflow.js
 *
 * STEP 8 of the manager's doc — "Plan validation".
 * Plain code only, NO AI.
 *
 * Job: check the list of jobs from Step 7 ONE more time, before anything
 * real runs (searches, AI jobs). A plan that breaks a rule never reaches
 * Step 9. Nothing is fixed or guessed here: Step 7 already fixed what it
 * could. Step 8 only says yes or no, and says exactly why.
 *
 *   1. Every job is a real job from the job list (capabilityRegistry.js),
 *      with the inputs it must have, of the right kind and size, and no
 *      inputs it does not know.
 *   2. Every job only uses results of EARLIER jobs (no loops), and waits
 *      only for jobs whose results it uses.
 *   3. The limits are kept: jobs, searches, AI jobs (the AI calls still
 *      left for this question), sides of a comparison.
 *   4. Filters come from Step 5 only: dates (never past today), places,
 *      companies, modules.
 *   5. Every goal that was not left out has a search and its key job, and
 *      the main goal was not left out.
 *   6. The evidence check runs once, at the end. No job is there twice.
 *
 * The result:
 *   status: 'approved'  -> Step 9 may run it
 *           'rejected'  -> nothing runs; the user gets PLAN_FAILED_MESSAGE
 *   problems  every broken rule, in plain words (for logs, Phoenix, tests)
 *   batches   the order to run: jobs in one batch can run at the same time
 *             (at most RUN_LIMITS.max_parallel_tasks), each batch only
 *             after the batches before it
 *   not_ready jobs whose real code (Step 9) is not written yet
 *             (refused only when REQUIRE_READY_JOBS is on in chatConfig.js)
 */

const {
  getCapability, RUN_LIMITS, MODULES, GOAL_KEY_JOB, SEARCH_JOBS, FRAMEWORKS,
} = require('./capabilityRegistry');
const { REQUIRE_READY_JOBS } = require('./chatConfig');
const { searchDates } = require('./buildWorkflow');
const { standardPlace } = require('../placeNames');
const { preprocessText } = require('./preprocessQuery');   // only to spot date words

const REF = /^T\d+\.output$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const lower = (x) => String(x || '').toLowerCase();
const plain = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

// "today" as YYYY-MM-DD text (Step 5 gives text; a date object also works)
function todayText(understood) {
  const t = understood && understood.today;
  if (t instanceof Date && !Number.isNaN(t.getTime())) return t.toISOString().slice(0, 10);
  if (typeof t === 'string' && DATE.test(t.slice(0, 10))) return t.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

// All "T3.output" refs anywhere in a job's inputs -> ["T3", ...]
function refsOf(inputs) {
  return [...new Set((JSON.stringify(inputs || {}).match(/T\d+\.output/g) || []).map((r) => r.replace('.output', '')))];
}

// ── 1. One job: real job, right inputs ───────────────────────────────────
function checkInputs(task, problems, notReady) {
  const cap = getCapability(task.capability);
  if (!cap) {
    problems.push(`${task.task_id}: "${task.capability}" is not a job in the job list`);
    return null;
  }
  if (!cap.offered_to_planner) problems.push(`${task.task_id}: job "${cap.id}" may not be planned`);
  if (!cap.available && !notReady.includes(cap.id)) notReady.push(cap.id);
  const inputs = task.inputs && typeof task.inputs === 'object' && !Array.isArray(task.inputs) ? task.inputs : null;
  if (!inputs) {
    problems.push(`${task.task_id}: has no inputs`);
    return cap;
  }

  for (const [name, spec] of Object.entries(cap.inputs)) {
    const v = inputs[name];
    const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (spec.required) problems.push(`${task.task_id}: required input "${name}" is missing`);
      continue;
    }
    const bad = (why) => problems.push(`${task.task_id}: input "${name}" ${why}`);
    switch (spec.type) {
      case 'text':
        if (typeof v !== 'string') bad('must be text');
        else if (spec.max_chars && v.length > spec.max_chars) bad(`is ${v.length} letters long (max ${spec.max_chars})`);
        else if (spec.allowed && !spec.allowed.includes(v)) bad(`"${v}" is not one of ${spec.allowed.join(', ')}`);
        break;
      case 'array_of_text':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) bad('must be a list of texts');
        else if (spec.allowed && v.some((x) => !spec.allowed.includes(x))) bad(`may only hold ${spec.allowed.join(', ')}`);
        break;
      case 'date':
        if (typeof v !== 'string' || !DATE.test(v)) bad(`"${v}" is not a date (YYYY-MM-DD)`);
        break;
      case 'modules':
        if (!Array.isArray(v) || v.some((m) => !MODULES.includes(m))) bad(`may only hold ${MODULES.join(', ')}`);
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isInteger(v)) bad('must be a whole number');
        else if ((spec.min != null && v < spec.min) || (spec.max != null && v > spec.max)) bad(`${v} is outside ${spec.min}..${spec.max}`);
        break;
      case 'ref':
        if (typeof v !== 'string' || !REF.test(v)) bad(`"${v}" is not the result of a job (Tn.output)`);
        break;
      case 'array_of_refs':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !REF.test(x))) bad('must be a list of job results (Tn.output)');
        break;
      case 'sides':
        if (!Array.isArray(v) || v.some((s) => !s || typeof s.label !== 'string' || !s.label.trim() || !REF.test(String(s.ref)))) {
          bad('must be a list of { label, ref }');
        }
        break;
      default:
        break;
    }
    if (Array.isArray(v) && spec.max && v.length > spec.max) bad(`has ${v.length} items (max ${spec.max})`);
    if (Array.isArray(v) && spec.min && v.length < spec.min) bad(`has ${v.length} items (min ${spec.min})`);
  }
  for (const name of Object.keys(inputs)) {
    if (!(name in cap.inputs)) problems.push(`${task.task_id}: "${name}" is not an input of ${cap.id}`);
  }
  return cap;
}

// ── 4. Filters only from Step 5 ──────────────────────────────────────────
function checkFilters(task, understood, today, problems) {
  const i = task.inputs || {};
  const t5 = understood.time || null;
  const ranges = (t5 && t5.ranges) || [];

  // a question that names a time: every search keeps that time, except
  // "today" meaning "now" ("who owns Huda Beauty today?"), which Step 7
  // searches without a date limit
  const onlyToday = ranges.length === 1 && /^today$/i.test(String(ranges[0].text || '').trim());
  const searches = task.capability === 'retrieve_data' || task.capability === 'structured_search';
  if (searches && t5 && (t5.from || t5.to) && !i.date_from && !i.date_to && !onlyToday) {
    problems.push(`${task.task_id}: has no dates, but the question names a time`);
  }
  // dates are filters (date_from / date_to), never search words: news text
  // does not say "October December", so they only blur the search
  if (task.capability === 'retrieve_data' && i.query && preprocessText(i.query).time_expressions.length) {
    problems.push(`${task.task_id}: date words in the search "${i.query}"`);
  }
  if (i.date_from || i.date_to) {
    if (!t5) {
      problems.push(`${task.task_id}: has dates, but the question has none`);
    } else {
      const allowed = [t5, ...ranges].map((r) => searchDates(r.from, r.to, today));
      if (!allowed.some((r) => r.from === (i.date_from || null) && r.to === (i.date_to || null))) {
        problems.push(`${task.task_id}: dates ${i.date_from || '…'} to ${i.date_to || '…'} are not the Step 5 dates`);
      }
    }
    if (i.date_from && i.date_to && i.date_from > i.date_to) problems.push(`${task.task_id}: dates are the wrong way round`);
    if (i.date_to && i.date_to > today) problems.push(`${task.task_id}: searches news after today (${i.date_to})`);
  }

  const places = (understood.places || []).map(lower);
  for (const c of i.countries || []) {
    if (!places.includes(lower(c)) && !places.includes(lower(standardPlace(c)))) {
      problems.push(`${task.task_id}: place "${c}" is not from Step 5`);
    }
  }
  const client = understood.client || {};
  const okCompanies = [
    ...(understood.companies || []).flatMap((c) => [c.name, c.matched && c.matched.name]),
    client.company_name, ...(client.competitors || []),
  ].filter(Boolean).map(plain);
  for (const c of i.companies || []) {
    if (!okCompanies.includes(plain(c))) problems.push(`${task.task_id}: company "${c}" is not from Step 5 or the client list`);
  }
}

// ── The run order: batches of jobs that can run at the same time ─────────
// The sides of a comparison:
//  - at least 2, each named once
//  - really different things: a side whose words all sit inside another
//    side ("UAE retail" and "UAE retail market") is the same thing
//  - a side's search never names another side ("Lancome pricing vs Dior"
//    for the Lancome side would also fetch Dior's news)
// A side that is not a place, a company, our business, "Competitors" or a
// date is a side the AI or the code named from WORDS ("online", "men's
// grooming"). The words that make it different from the other sides must
// be in the user's question: "UAE market" vs "UAE retail" for "Compare UAE
// and UAE retail" was compared although nobody typed "market" (21 Nov).
const SIDE_GLUE = new Set(['and', 'or', 'vs', 'versus', 'the', 'of', 'in', 'for', 'on', 'to', 'a', 'an', 's']);
const sideWords = (t) => plain(t).split(' ').filter((w) => w && !SIDE_GLUE.has(w))
  .map((w) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w));
function wordSidesNotAsked(sides, understood, question) {
  const u = understood || {};
  const fixed = new Set([
    ...(u.places || []), ...(u.places_not_in_list || []),
    ...(u.companies || []).flatMap((c) => [c && c.name, c && c.matched && c.matched.name]),
    ...((u.client && [u.client.company_name, ...(u.client.competitors || [])]) || []),
    ...((u.time && u.time.ranges) || []).map((r) => r && r.text),
    'competitors',
  ].filter(Boolean).map(plain));
  const typed = new Set(sideWords(question));
  if (typed.size === 0) return [];
  const out = [];
  for (const side of sides) {
    const label = plain(side && side.label);
    if (!label || fixed.has(label) || /\d/.test(label)) continue;
    const others = new Set(sides.filter((o) => o !== side).flatMap((o) => sideWords(o && o.label)));
    const own = sideWords(label).filter((w) => w.length >= 2 && !others.has(w));
    const missing = own.filter((w) => !typed.has(w));
    if (missing.length) out.push({ label: side.label, missing });
  }
  return out;
}

function checkSides(task, tasks, problems, understood = {}, question = '') {
  const sides = (task.inputs && task.inputs.sides) || [];
  for (const x of wordSidesNotAsked(sides, understood, question)) {
    problems.push(`${task.task_id}: the side "${x.label}" is not something the question compares ("${x.missing.join(' ')}" was never typed)`);
  }
  const labels = sides.map((x) => plain(x && x.label));
  if (labels.length < 2) problems.push(`${task.task_id}: compare needs at least 2 sides`);
  if (new Set(labels).size !== labels.length) problems.push(`${task.task_id}: two sides with the same name`);
  const words = (l) => l.split(' ').filter(Boolean);
  labels.forEach((a, i) => labels.forEach((b, j) => {
    if (i >= j || a === b || !a || !b) return;
    const [small, big] = words(a).length <= words(b).length ? [a, b] : [b, a];
    if (words(small).every((w) => words(big).includes(w))) {
      problems.push(`${task.task_id}: the sides "${sides[i].label}" and "${sides[j].label}" are the same thing`);
    }
  }));
  // one or many is the same word ("competitor" names the "Competitors" side)
  const oneOrMany = (t) => t.split(' ').filter(Boolean).map((w) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w)).join(' ');
  for (const side of sides) {
    const src = tasks.find((x) => x && `${x.task_id}.output` === (side && side.ref));
    if (!src || !src.inputs || !src.inputs.query) continue;
    const q = ` ${oneOrMany(plain(src.inputs.query))} `;
    for (const other of sides) {
      if (other === side) continue;
      const o = oneOrMany(plain(other && other.label));
      const named = (o.length >= 3 && q.includes(` ${o} `)) ||
        (plain(other && other.label) === 'competitors' && /\b(competit\w*|rivals?)\b/.test(q));
      if (named) problems.push(`${src.task_id}: the "${side.label}" search names the other side "${other.label}"`);
    }
    // nor a thing LEFT OUT of the comparison (past the 4-side limit, the
    // same kind as the sides): it is not compared, so its news must not be
    // pulled into a side ("nykaa" in the Estée Lauder search)
    if (sides.length >= 4) {
      const places = ((understood && understood.places) || []).map(plain);
      const companies = ((understood && understood.companies) || []).map((c) => plain((c && c.matched && c.matched.name) || (c && c.name)));
      const same = labels.every((l) => places.includes(l)) ? places : labels.every((l) => companies.includes(l)) ? companies : [];
      const raw = ` ${plain(src.inputs.query)} `;
      for (const n of same) {
        if (n.length >= 3 && !labels.includes(n) && raw.includes(` ${n} `)) {
          problems.push(`${src.task_id}: the "${side.label}" search names "${n}", which is left out of the comparison`);
        }
      }
    }
  }
}

function runBatches(tasks) {
  const level = new Map();
  for (const t of tasks) {
    const deps = (t.depends_on || []).map((d) => level.get(d)).filter((x) => x != null);
    level.set(t.task_id, deps.length ? Math.max(...deps) + 1 : 0);
  }
  const batches = [];
  const maxLevel = Math.max(-1, ...level.values());
  for (let l = 0; l <= maxLevel; l++) {
    const ids = tasks.filter((t) => level.get(t.task_id) === l).map((t) => t.task_id);
    for (let k = 0; k < ids.length; k += RUN_LIMITS.max_parallel_tasks) {
      batches.push(ids.slice(k, k + RUN_LIMITS.max_parallel_tasks));
    }
  }
  return batches;
}

// ── Step 8 main ──────────────────────────────────────────────────────────
/**
 * @param {object} workflow    what Step 7 returned (tasks, ai_budget, goals_left_out, notes)
 * @param {object} understood  what Step 5 returned (time, places, companies, client, today)
 * @param {object} plan        what Step 6 returned (requirements)
 * @returns { status, problems, not_ready, batches, counts, checked_jobs }
 */
function validateWorkflow(workflow, understood, plan) {
  const problems = [];
  const notReady = [];
  const tasks = Array.isArray(workflow && workflow.tasks) ? workflow.tasks : [];
  const requirements = (plan && plan.requirements) || [];
  const reqIds = requirements.map((r) => r.requirement_id);
  const today = todayText(understood);

  if (tasks.length === 0) problems.push('the plan has no jobs');

  // ids: T1, T2, T3 ... in order, each once
  tasks.forEach((t, k) => {
    if (!t || t.task_id !== `T${k + 1}`) problems.push(`job ${k + 1} should be called T${k + 1}, it is "${t && t.task_id}"`);
  });
  const ids = tasks.map((t) => t && t.task_id);

  const seen = new Map();
  let searches = 0;
  let aiJobs = 0;
  tasks.forEach((t, k) => {
    if (!t) return;
    const cap = checkInputs(t, problems, notReady);

    // 2. only earlier results; wait only for what is used
    const refs = refsOf(t.inputs);
    for (const r of refs) {
      const at = ids.indexOf(r);
      if (at < 0) problems.push(`${t.task_id}: uses ${r}, which is not a job in the plan`);
      else if (at >= k) problems.push(`${t.task_id}: uses ${r}, which comes later (a loop)`);
    }
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    for (const d of deps) if (!refs.includes(d)) problems.push(`${t.task_id}: waits for ${d} but does not use its result`);
    for (const r of refs) if (!deps.includes(r)) problems.push(`${t.task_id}: uses ${r} but does not wait for it`);
    if (cap && cap.needs_earlier_tasks && refs.length === 0) problems.push(`${t.task_id}: ${cap.id} has no earlier result to work on`);
    if (cap && !cap.needs_earlier_tasks && refs.length) problems.push(`${t.task_id}: ${cap.id} must not use earlier results`);

    // which goal it serves
    const forReq = Array.isArray(t.for_requirements) ? t.for_requirements : [];
    if (forReq.length === 0) problems.push(`${t.task_id}: does not say which goal it is for`);
    for (const r of forReq) if (!reqIds.includes(r)) problems.push(`${t.task_id}: is for ${r}, which is not a part of the plan`);

    // a comparison: 2+ sides, each a different thing, and no side's search
    // pulls another side's news
    if (t.capability === 'compare') {
      const asked = [understood && understood.question_text, understood && understood.question_typed, workflow && workflow.question_text].filter(Boolean).join(' ');
      checkSides(t, tasks, problems, understood, asked);
    }

    // 4. filters from Step 5
    if (SEARCH_JOBS.includes(t.capability)) {
      searches += 1;
      checkFilters(t, understood, today, problems);
    }
    if (cap && cap.uses_ai !== 'no') aiJobs += 1;

    // 6. no job twice
    const key = `${t.capability}|${JSON.stringify(t.inputs)}`;
    if (seen.has(key)) problems.push(`${t.task_id}: is the same job as ${seen.get(key)}`);
    else seen.set(key, t.task_id);
  });

  // 2b. every result is used: each job but the last (the evidence check)
  // gives its result to a later job. A search nobody reads, or facts nobody
  // looks at, are fetched or worked out for nothing (and lost to the answer).
  const usedRefs = new Set(tasks.flatMap((t) => (t ? refsOf(t.inputs) : [])));
  tasks.forEach((t, k) => {
    if (t && k < tasks.length - 1 && !usedRefs.has(t.task_id)) problems.push(`${t.task_id}: its result is used by no later job`);
  });

  // 3. limits
  if (tasks.length > RUN_LIMITS.max_tasks) problems.push(`${tasks.length} jobs (limit ${RUN_LIMITS.max_tasks})`);
  if (searches > RUN_LIMITS.max_search_tasks) problems.push(`${searches} searches (limit ${RUN_LIMITS.max_search_tasks})`);
  const budget = Number.isInteger(workflow && workflow.ai_budget) ? workflow.ai_budget : RUN_LIMITS.max_ai_calls_per_question;
  if (aiJobs > budget) problems.push(`${aiJobs} AI jobs, but only ${budget} AI calls are left for this question`);

  // 6. the evidence check: once, last
  const checks = tasks.filter((t) => t && t.capability === 'validate_evidence');
  if (tasks.length && (checks.length !== 1 || tasks[tasks.length - 1].capability !== 'validate_evidence')) {
    problems.push('the evidence check must be there once, as the last job');
  }

  // 5. every goal: a search and its key job (unless left out, recorded)
  const leftOut = ((workflow && workflow.goals_left_out) || []).join(' ');
  const notes = (workflow && workflow.notes) || [];
  for (const r of requirements) {
    const id = r.requirement_id;
    if (leftOut.includes(`(${id})`)) continue;
    const mine = tasks.filter((t) => t && (t.for_requirements || []).includes(id));
    if (!mine.some((t) => SEARCH_JOBS.includes(t.capability))) problems.push(`${id} (${r.goal}): has no search`);
    const key = GOAL_KEY_JOB[r.goal];
    // a comparison with fewer than 2 sides is summarised instead (Step 7 says so in its notes)
    const summarisedInstead = notes.some((n) => String(n).startsWith(`${id}: fewer than 2 sides`));
    if (key && !mine.some((t) => t.capability === key) && !(summarisedInstead && mine.some((t) => t.capability === 'summarise'))) {
      problems.push(`${id} (${r.goal}): its key job ${key} is missing`);
    }
  }
  if (requirements[0] && leftOut.includes(`(${requirements[0].requirement_id})`)) problems.push('the main goal was left out');

  // 6. every framework the question names (SWOT, PESTLE, Five Forces) has
  // its headings in the framework summary, or is said to be left out
  const named = FRAMEWORKS.filter((f) => f.match.test(String((understood && understood.question_text) || (workflow && workflow.question_text) || '')));
  for (const r of requirements.filter((x) => x.goal === 'framework' && !leftOut.includes(`(${x.requirement_id})`))) {
    const sum = tasks.find((t) => t && t.capability === 'summarise' && (t.for_requirements || []).includes(r.requirement_id));
    if (!sum) continue;   // the key job is checked above
    const heads = ((sum.inputs && sum.inputs.headings) || []).join(' | ');
    for (const f of named) {
      if (f.headings.every((h) => heads.includes(h))) continue;
      if (notes.some((n) => String(n).startsWith(`${r.requirement_id}:`) && String(n).includes(f.name) && String(n).includes('left out'))) continue;
      problems.push(`${sum.task_id}: the question asks for a ${f.name}, but the summary has no ${f.name} headings`);
    }
  }

  if (REQUIRE_READY_JOBS && notReady.length) {
    problems.push(`these jobs cannot run yet (their code is not ready): ${notReady.join(', ')}`);
  }

  const status = problems.length ? 'rejected' : 'approved';
  return {
    status,
    problems,
    not_ready: notReady,
    batches: status === 'approved' ? runBatches(tasks) : [],
    counts: { tasks: tasks.length, searches, ai_jobs: aiJobs, ai_budget: budget },
    checked_jobs: tasks.length,
  };
}

module.exports = { validateWorkflow, runBatches, refsOf, checkSides };
