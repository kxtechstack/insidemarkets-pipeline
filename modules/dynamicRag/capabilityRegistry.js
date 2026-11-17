/**
 * modules/dynamicRag/capabilityRegistry.js
 *
 * THE JOB LIST ("capability registry") of the Decision Intelligence chat.
 * Govind's checklist, Step 7 + "Next development deliverable".
 * Full spec in plain words: project doc claude/capabilityRegistrySpec.md
 *
 * What it is: the fixed list of jobs our chat knows how to do. Like a
 * toolbox. The AI planner (Steps 6 and 7) may only plan with jobs from
 * this list. Step 8 checks every plan against it. Step 9 runs the jobs.
 *
 * This file is ONLY the list (names, what each job does, what goes in,
 * what comes out, limits). It does not search, call the AI or answer.
 * The real code of each job is written in Step 9. Until then every job
 * has  available: false , and Step 8 will refuse a plan that uses it.
 *
 * Layer 1 = client data only (Policy, Market Dynamics, Forward Outlook,
 * Competitive Intelligence). Layer 2 adds SEC and custom data as new
 * data_access values / new jobs. Nothing here is about one client.
 *
 * Never an input from the planner: client id, user id, today's date.
 * Node.js adds these from the logged-in request, so the AI can never
 * point a job at another client's data.
 */

// ── The 4 client-data modules a job may read (Layer 1) ──────────────────
const MODULES = ['policy', 'market', 'outlook', 'competitor'];

// ── Kinds of input a job may get ────────────────────────────────────────
//   text           one short text           ("skincare launches")
//   array_of_text  a list of short texts    (["price", "launches"])
//   date           YYYY-MM-DD
//   modules        some of: policy, market, outlook, competitor
//   number         a whole number
//   ref            the result of an earlier task, written "T1.output"
//   array_of_refs  several earlier results  (["T1.output", "T2.output"])
//   sides          2 to 4 of { label, ref }  (only for compare)
const INPUT_TYPES = ['text', 'array_of_text', 'date', 'modules', 'number', 'ref', 'array_of_refs', 'sides'];

// ── What a job gives back (the shared "contract" shapes) ────────────────
const OUTPUT_SHAPES = {
  EvidenceSet: 'A list of signals the user can open in a tab. Each item: source id, module, title, short text, date, link, countries, companies, impact, its card or trend.',
  FindingList: 'A list of findings. Each finding: text, kind (fact / interpretation / hypothesis) and the source ids it is based on.',
  GroupList: 'Groups of related items. Each group: name and the source ids in it.',
  ComparisonTable: 'Rows of points compared side by side. An empty cell means no evidence was found (never a guess).',
  PatternList: 'Patterns over time. Each: name, description, first and last date seen, number of sources, trend or one-off event, source ids.',
  EvidenceCheck: 'Is the evidence enough: sufficient / partial / insufficient, what is supported, what is weak, limitations, findings removed.',
};

// ── Which data a job may read ───────────────────────────────────────────
// Layer 1: only client_data. Layer 2 will add 'sec_data' and 'custom_data'.
const DATA_ACCESS = ['client_data'];

// ═════════════════════════════════════════════════════════════════════════
// THE JOBS
//   id                  the only name the planner may use
//   title, description  plain words (shown to the planner and to people)
//   offered_to_planner  false = the planner is not shown this job at all
//   available           true only after the job's code is written and tested (Step 9)
//   uses_ai             'no' / 'sometimes' / 'yes'  (cost control)
//   inputs              { name: { type, required, ...limits, note } }
//   output              one of OUTPUT_SHAPES
//   needs_earlier_tasks true = works on another task's result, cannot be first
//   limits              max_items_in (evidence given to it), timeout_ms, retries
//   on_error            'fail_task' = tasks waiting for it are blocked,
//                       the answer says what could not be found
// ═════════════════════════════════════════════════════════════════════════
const AI_LIMITS = { max_items_in: 25, timeout_ms: 45000, retries: 1 };
const CODE_LIMITS = { max_items_in: null, timeout_ms: 20000, retries: 1 };

const CAPABILITIES = [
  {
    id: 'retrieve_data',
    title: 'Search client data',
    description: 'Search the client data by meaning (Policy, Market Dynamics, Forward Outlook, Competitive Intelligence) and return the matching signals. Only signals the user can see in the tabs.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'no',
    data_access: ['client_data'],
    inputs: {
      query: { type: 'text', required: true, max_chars: 300, note: 'what to look for, in plain words' },
      modules: { type: 'modules', required: false, note: 'default: all 4' },
      date_from: { type: 'date', required: false },
      date_to: { type: 'date', required: false },
      companies: { type: 'array_of_text', required: false, max: 10, note: 'company names from Step 5' },
      label: { type: 'text', required: false, max_chars: 80, note: 'name of this evidence set, e.g. "UAE retail"' },
    },
    output: 'EvidenceSet',
    needs_earlier_tasks: false,
    limits: CODE_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'structured_search',
    title: 'Read exact records',
    description: 'Read signals directly from the database, newest or highest impact first. For "latest", "list", "this week", "competitor moves" questions.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'no',
    data_access: ['client_data'],
    inputs: {
      modules: { type: 'modules', required: true },
      date_from: { type: 'date', required: false },
      date_to: { type: 'date', required: false },
      companies: { type: 'array_of_text', required: false, max: 10 },
      impact: { type: 'array_of_text', required: false, allowed: ['Critical', 'High', 'Medium', 'Low'] },
      sub_category: { type: 'text', required: false, max_chars: 100 },
      order: { type: 'text', required: false, allowed: ['newest', 'impact'], note: 'default: newest' },
      max_items: { type: 'number', required: false, min: 1, max: 20, note: 'default: 20' },
      label: { type: 'text', required: false, max_chars: 80 },
    },
    output: 'EvidenceSet',
    needs_earlier_tasks: false,
    limits: CODE_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'filter_data',
    title: 'Keep only what was asked',
    description: 'Keep only the countries, companies, dates and modules the user asked for. Same place written differently counts as the same (UAE = United Arab Emirates).',
    offered_to_planner: true,
    available: false,
    uses_ai: 'no',
    data_access: ['client_data'],
    inputs: {
      evidence: { type: 'ref', required: true },
      countries: { type: 'array_of_text', required: false, max: 10 },
      companies: { type: 'array_of_text', required: false, max: 10 },
      date_from: { type: 'date', required: false },
      date_to: { type: 'date', required: false },
      modules: { type: 'modules', required: false },
    },
    output: 'EvidenceSet',
    needs_earlier_tasks: true,
    limits: CODE_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'extract_facts',
    title: 'Pull out facts',
    description: 'Pull out exact facts from the evidence: numbers, amounts, dates, launches, deals. Every fact keeps its source.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'yes',
    data_access: ['client_data'],
    inputs: {
      evidence: { type: 'array_of_refs', required: true, min: 1, max: 4 },
      what_to_find: { type: 'array_of_text', required: true, min: 1, max: 6, note: 'e.g. ["funding amount", "launch date"]' },
    },
    output: 'FindingList',
    needs_earlier_tasks: true,
    limits: AI_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'summarise',
    title: 'Summarise',
    description: 'Write short points about the evidence or earlier findings, each with its sources.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'yes',
    data_access: ['client_data'],
    inputs: {
      input: { type: 'array_of_refs', required: true, min: 1, max: 6 },
      focus: { type: 'text', required: false, max_chars: 200, note: 'what the summary should be about' },
      headings: { type: 'array_of_text', required: false, max: 8, note: 'fixed headings, e.g. SWOT: Strengths, Weaknesses, Opportunities, Threats' },
    },
    output: 'FindingList',
    needs_earlier_tasks: true,
    limits: AI_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'compare',
    title: 'Compare',
    description: 'Compare 2 to 4 labelled evidence sets side by side, point by point. A point with no evidence stays empty.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'yes',
    data_access: ['client_data'],
    inputs: {
      sides: { type: 'sides', required: true, min: 2, max: 4, note: 'each side = { label, ref }' },
      dimensions: { type: 'array_of_text', required: false, max: 8, note: 'what to compare on' },
    },
    output: 'ComparisonTable',
    needs_earlier_tasks: true,
    limits: AI_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'cluster',
    title: 'Group related items',
    description: 'Group related items. Uses the groups that already exist first (Market Dynamics card, Forward Outlook trend, CI card); the AI only groups and names what is left.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'sometimes',
    data_access: ['client_data'],
    inputs: {
      evidence: { type: 'ref', required: true },
    },
    output: 'GroupList',
    needs_earlier_tasks: true,
    limits: AI_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'identify_patterns',
    title: 'Find trends over time',
    description: 'Find repeated signals and change over time. A trend needs 2 or more sources on different dates; otherwise it is a one-off event.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'yes',
    data_access: ['client_data'],
    inputs: {
      evidence: { type: 'array_of_refs', required: true, min: 1, max: 4 },
      topic: { type: 'text', required: false, max_chars: 200 },
    },
    output: 'PatternList',
    needs_earlier_tasks: true,
    limits: AI_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'identify_gaps',
    title: 'Find gaps',
    description: 'Find unmet needs and market gaps from earlier results. Always marked as interpretation, never as fact.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'yes',
    data_access: ['client_data'],
    inputs: {
      inputs: { type: 'array_of_refs', required: true, min: 1, max: 4, note: 'comparison, patterns or evidence' },
    },
    output: 'FindingList',
    needs_earlier_tasks: true,
    limits: AI_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'discover_opportunities',
    title: 'Find opportunities',
    description: 'Suggest business opportunities from patterns, gaps and comparisons. Each one shows its evidence chain and is marked as a hypothesis.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'yes',
    data_access: ['client_data'],
    inputs: {
      inputs: { type: 'array_of_refs', required: true, min: 1, max: 4, note: 'patterns, gaps or comparison' },
      focus: { type: 'text', required: false, max_chars: 200 },
    },
    output: 'FindingList',
    needs_earlier_tasks: true,
    limits: AI_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'analyse_risks',
    title: 'Find risks',
    description: 'Find and rank risks (mostly Policy & Risk and competitor moves). Keeps the impact level already stored on each signal.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'yes',
    data_access: ['client_data'],
    inputs: {
      evidence: { type: 'array_of_refs', required: true, min: 1, max: 4 },
      topic: { type: 'text', required: false, max_chars: 200 },
    },
    output: 'FindingList',
    needs_earlier_tasks: true,
    limits: AI_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'forecast',
    title: 'Number forecast',
    description: 'Number-based forecast from past numbers (Govind: a real forecast engine, not an AI prompt). Not offered in Layer 1: client data has no number history. Forecast questions use identify_patterns instead and the answer says "based on current trends, not a number forecast".',
    offered_to_planner: false,
    available: false,
    uses_ai: 'no',
    data_access: ['client_data'],
    inputs: {},
    output: 'FindingList',
    needs_earlier_tasks: true,
    limits: CODE_LIMITS,
    on_error: 'fail_task',
  },
  {
    id: 'validate_evidence',
    title: 'Check the evidence',
    description: 'Check that every finding has a real source, enough support and dates inside what the user asked; flag conflicts. Code first, AI only if needed.',
    offered_to_planner: true,
    available: false,
    uses_ai: 'sometimes',
    data_access: ['client_data'],
    inputs: {
      findings: { type: 'array_of_refs', required: true, min: 1, max: 8 },
    },
    output: 'EvidenceCheck',
    needs_earlier_tasks: true,
    limits: AI_LIMITS,
    on_error: 'fail_task',
  },
];

// ── Which jobs usually serve which Step 5 goal ──────────────────────────
// A GUIDE for the planner (Step 6/7), not a fixed workflow. Every Step 5
// goal must be in here (the test checks it).
const GOAL_GUIDE = {
  fact_lookup: ['retrieve_data', 'structured_search', 'extract_facts', 'validate_evidence'],
  list: ['structured_search', 'filter_data', 'validate_evidence'],
  company_profile: ['retrieve_data', 'cluster', 'summarise', 'validate_evidence'],
  trends: ['retrieve_data', 'identify_patterns', 'validate_evidence'],
  comparison: ['retrieve_data', 'filter_data', 'compare', 'validate_evidence'],
  opportunities: ['retrieve_data', 'identify_patterns', 'identify_gaps', 'discover_opportunities', 'validate_evidence'],
  competitor_analysis: ['structured_search', 'retrieve_data', 'cluster', 'summarise', 'compare', 'validate_evidence'],
  market_entry: ['retrieve_data', 'identify_patterns', 'analyse_risks', 'identify_gaps', 'discover_opportunities', 'summarise', 'validate_evidence'],
  feasibility: ['retrieve_data', 'identify_patterns', 'analyse_risks', 'identify_gaps', 'summarise', 'validate_evidence'],
  strategy: ['retrieve_data', 'identify_patterns', 'analyse_risks', 'identify_gaps', 'discover_opportunities', 'summarise', 'validate_evidence'],
  risks: ['retrieve_data', 'structured_search', 'analyse_risks', 'validate_evidence'],
  campaign_ideas: ['retrieve_data', 'identify_patterns', 'identify_gaps', 'discover_opportunities', 'validate_evidence'],
  forecast: ['retrieve_data', 'identify_patterns', 'validate_evidence'],
  framework: ['retrieve_data', 'cluster', 'summarise', 'validate_evidence'],
};

// ── The ONE analysis job each goal cannot do without ────────────────────
// Step 6 makes sure the plan has it (a comparison must compare, a trends
// question must look for patterns...). null = no analysis needed (a list is
// shown as it is found). Every key job must be in that goal's guide above.
const GOAL_KEY_JOB = {
  fact_lookup: 'extract_facts',
  list: null,
  company_profile: 'summarise',
  trends: 'identify_patterns',
  comparison: 'compare',
  opportunities: 'discover_opportunities',
  competitor_analysis: 'summarise',
  market_entry: 'discover_opportunities',
  feasibility: 'analyse_risks',
  strategy: 'discover_opportunities',
  risks: 'analyse_risks',
  campaign_ideas: 'discover_opportunities',
  forecast: 'identify_patterns',
  framework: 'summarise',
};

// ── Run rules (used by Step 8 to check a plan and Step 9 to run it) ─────
const RUN_LIMITS = {
  max_tasks: 12,                 // tasks in one plan
  max_search_tasks: 6,           // retrieve_data + structured_search together
  max_parallel_tasks: 3,         // running at the same time
  max_ai_calls_per_question: 15, // all steps together (account limit: 50 per minute)
  search_pieces: 40,             // Qdrant text pieces read per search (Sneha OK 17 Nov)
  search_max_signals: 20,        // signals given back per search   (Sneha OK 17 Nov)
  max_items_to_ai: 25,           // evidence items given to one AI job
};
const SEARCH_JOBS = ['retrieve_data', 'structured_search'];

// ═════════════════════════════════════════════════════════════════════════
// Small helpers (no database, no AI)
// ═════════════════════════════════════════════════════════════════════════
const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** The job with this id, or null if there is no such job. */
function getCapability(id) {
  return byId.get(String(id || '')) || null;
}

/**
 * The jobs the planner may see, in a short form for the planner's
 * instruction (the instruction text itself lives in the prompts table).
 */
function capabilitiesForPlanner() {
  return CAPABILITIES.filter((c) => c.offered_to_planner).map((c) => ({
    id: c.id,
    description: c.description,
    inputs: Object.fromEntries(Object.entries(c.inputs).map(([name, spec]) => [
      name,
      `${spec.type}${spec.required ? ', required' : ''}${spec.note ? ` (${spec.note})` : ''}`,
    ])),
    output: c.output,
    needs_earlier_tasks: c.needs_earlier_tasks,
  }));
}

/**
 * Checks the list itself is complete and consistent (run by the test file).
 * @returns array of problems, empty when all is fine
 */
function checkRegistry() {
  const problems = [];
  const seen = new Set();
  for (const c of CAPABILITIES) {
    if (seen.has(c.id)) problems.push(`job "${c.id}" is listed twice`);
    seen.add(c.id);
    if (!c.title || !c.description) problems.push(`job "${c.id}" has no title or description`);
    if (!OUTPUT_SHAPES[c.output]) problems.push(`job "${c.id}" gives back an unknown shape "${c.output}"`);
    if (!['no', 'sometimes', 'yes'].includes(c.uses_ai)) problems.push(`job "${c.id}" has a wrong uses_ai value`);
    for (const d of c.data_access) if (!DATA_ACCESS.includes(d)) problems.push(`job "${c.id}" reads unknown data "${d}"`);
    for (const [name, spec] of Object.entries(c.inputs)) {
      if (!INPUT_TYPES.includes(spec.type)) problems.push(`job "${c.id}" input "${name}" has unknown type "${spec.type}"`);
      if (['client_id', 'clientid', 'user_id', 'userid', 'today'].includes(name.toLowerCase())) {
        problems.push(`job "${c.id}" lets the planner give "${name}" (must come from the logged-in request)`);
      }
    }
    const takesRef = Object.values(c.inputs).some((s) => ['ref', 'array_of_refs', 'sides'].includes(s.type));
    if (c.needs_earlier_tasks !== takesRef && c.id !== 'forecast') {
      problems.push(`job "${c.id}": needs_earlier_tasks does not match its inputs`);
    }
  }
  for (const [goal, jobs] of Object.entries(GOAL_GUIDE)) {
    for (const j of jobs) {
      const cap = byId.get(j);
      if (!cap) problems.push(`goal "${goal}" uses unknown job "${j}"`);
      else if (!cap.offered_to_planner) problems.push(`goal "${goal}" uses job "${j}" that the planner may not use`);
    }
  }
  for (const goal of Object.keys(GOAL_GUIDE)) {
    if (!(goal in GOAL_KEY_JOB)) problems.push(`goal "${goal}" has no key job (use null if it needs none)`);
    const key = GOAL_KEY_JOB[goal];
    if (key && !GOAL_GUIDE[goal].includes(key)) problems.push(`goal "${goal}": key job "${key}" is not in its guide`);
  }
  return problems;
}

module.exports = {
  CAPABILITIES,
  GOAL_GUIDE,
  GOAL_KEY_JOB,
  RUN_LIMITS,
  SEARCH_JOBS,
  MODULES,
  INPUT_TYPES,
  OUTPUT_SHAPES,
  DATA_ACCESS,
  getCapability,
  capabilitiesForPlanner,
  checkRegistry,
};
