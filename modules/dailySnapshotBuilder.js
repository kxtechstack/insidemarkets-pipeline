/**
 * modules/dailySnapshotBuilder.js
 * =================================
 * Builds the unified daily snapshot card for one client + one module.
 * Writes to public.daily_module_snapshots.
 *
 * Called from pipelineRunner.js at the end of every run, for each of
 * the 3 modules (Market Dynamics, Policy & Risk, Forward Outlook).
 *
 * Design:
 *   - ONE row per (client, module, snapshot_date) — UPSERT on rerun
 *   - "rows" JSONB = array of dimension objects (5-15 per module)
 *   - Deterministic status/icon/color/delta computed in code
 *   - ONE LLM call per module per day for body + so_what only
 *   - All dates computed in IST (not UTC) to match the user's day
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('./llmClient');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Module UUIDs — keep in sync with the rest of the codebase
const POLICY_MODULE_ID           = '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960';
const MARKET_DYNAMICS_MODULE_ID  = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const FORWARD_OUTLOOK_MODULE_ID  = '2eb989fd-0ea0-4320-b73a-f7eb8b970473';

const MODULE_TITLES = {
  [POLICY_MODULE_ID]:          'Policy & Risk Monitor',
  [MARKET_DYNAMICS_MODULE_ID]: 'Market Dynamics',
  [FORWARD_OUTLOOK_MODULE_ID]: 'Forward Outlook',
};

// Which physical table holds signals for each module
const SIGNAL_TABLE_BY_MODULE = {
  [POLICY_MODULE_ID]:          'policy_signals',
  [MARKET_DYNAMICS_MODULE_ID]: 'market_dynamics_signals',
  [FORWARD_OUTLOOK_MODULE_ID]: 'trend_signals',
};

// LLMs occasionally drop spaces at word boundaries in otherwise-correct
// strings (e.g. "activitythis"). This collapses any run of whitespace
// into a single space and trims edges — cheap insurance, no behavior change.
const normalizeText = (s) => (s || '').replace(/\s+/g, ' ').trim();

// IST offset — India is UTC+5:30, no DST
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── Date helpers (IST) ────────────────────────────────────────────────

/**
 * Given a reference date, returns:
 *   - istDate       : Date object representing IST-midnight of that day
 *   - snapshotDate  : 'YYYY-MM-DD' string for the snapshot_date column
 *   - windowEnd     : IST midnight of reference day (end of 7-day window)
 *   - windowStart   : IST midnight 7 days before reference day
 */
function getIstWindow(reference = new Date()) {
  const shifted = new Date(reference.getTime() + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();

  const istMidnight = new Date(Date.UTC(y, m, d, 0, 0, 0));
  const snapshotDate = istMidnight.toISOString().slice(0, 10);

  const windowEndUtc = new Date(istMidnight.getTime() - IST_OFFSET_MS);
  const windowStartUtc = new Date(windowEndUtc.getTime() - 7 * 24 * 60 * 60 * 1000);

  return {
    snapshotDate,
    windowEndIso: windowEndUtc.toISOString(),
    windowStartIso: windowStartUtc.toISOString(),
    // For storing the window bounds as dates in the DB
    windowStartDate: windowStartUtc.toISOString().slice(0, 10),
    windowEndDate: windowEndUtc.toISOString().slice(0, 10),
  };
}

// ── Data loaders ──────────────────────────────────────────────────────

/**
 * Returns the client's enabled submodules for a module, in a stable
 * order (by submodule_name). Each entry:
 *   { submodule_id, submodule_name }
 */
async function getEnabledSubmodules(clientId, moduleId) {
  const { data, error } = await supabase
    .schema('admin')
    .from('client_signals')
    .select(`
      is_enabled,
      signals!inner (
        submodule_id,
        module_id,
        submodules!inner ( id, submodule_name )
      )
    `)
    .eq('client_id', clientId)
    .eq('is_enabled', true)
    .eq('signals.module_id', moduleId);

  if (error) {
    console.error(`[Snapshot] Failed to load submodules for ${clientId}/${moduleId}:`, error.message);
    return [];
  }

  // Dedupe by submodule_id, keep first submodule_name seen
  const byId = new Map();
  for (const row of data || []) {
    const sub = row.signals?.submodules;
    if (!sub) continue;
    if (!byId.has(sub.id)) {
      byId.set(sub.id, { submodule_id: sub.id, submodule_name: sub.submodule_name });
    }
  }

  return [...byId.values()].sort((a, b) =>
    a.submodule_name.localeCompare(b.submodule_name)
  );
}

/**
 * Pull signals for the given submodule + window. Returns array of
 * { signal_title, summary, organization, country, impact_level, created_at }
 * sorted newest first.
 */
async function getSignalsForWindow(signalTable, clientId, submoduleId, windowStartIso, windowEndIso) {
  const columns = signalTable === 'trend_signals'
    ? 'signal_title, summary, organization, sector, horizon_estimate, created_at'
    : signalTable === 'market_dynamics_signals'
      ? 'signal_title, summary, organization, country, category, created_at'
      : 'signal_title, summary, impact_level, country, category, created_at';

  const { data, error } = await supabase
    .from(signalTable)
    .select(columns)
    .eq('client_id', clientId)
    .eq('submodule_id', submoduleId)
    .gte('created_at', windowStartIso)
    .lt('created_at', windowEndIso)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error(`[Snapshot] Signal query failed (${signalTable}):`, error.message);
    return [];
  }
  return data || [];
}

// ── Deterministic status computation ──────────────────────────────────

function statusFromDelta(delta, moduleId, signals) {
  // ---- FORWARD OUTLOOK: signal-driven posture mapping (approximated
  // here since trend posture lives on trend_clusters, not on the
  // individual signals we queried). We infer from counts + recency.
  if (moduleId === FORWARD_OUTLOOK_MODULE_ID) {
    if (delta >= 5) return { status: 'Act now',      icon: '↘', color: 'red'   };
    if (delta >= 3) return { status: 'Watch closely', icon: '–', color: 'amber' };
    if (delta >= 1) return { status: 'Monitor',      icon: '–', color: 'blue'  };
    if (delta === 0) return { status: 'No change',   icon: '–', color: 'gray'  };
    return                  { status: 'Trending down', icon: '↘', color: 'red'  };
  }

  // ---- POLICY & RISK: driven by impact_level of the new signals
  if (moduleId === POLICY_MODULE_ID) {
    const hasCritical = signals.some(s => (s.impact_level || '').toLowerCase() === 'critical');
    const highCount   = signals.filter(s => (s.impact_level || '').toLowerCase() === 'high').length;

    if (hasCritical)              return { status: 'Act now',        icon: '↘', color: 'red'   };
    if (highCount >= 1)           return { status: 'Needs review',   icon: '!', color: 'amber' };
    if (signals.length >= 3)      return { status: 'Watch closely',  icon: '–', color: 'amber' };
    if (signals.length === 0)     return { status: 'No change',      icon: '–', color: 'gray'  };
    return                        { status: 'Monitor',         icon: '–', color: 'blue'  };
  }

  // ---- MARKET DYNAMICS: pure count-delta based
  if (delta >= 1)  return { status: 'Trending up',   icon: '↗', color: 'green' };
  if (delta === 0) return { status: 'No change',     icon: '–', color: 'gray'  };
  return             { status: 'Trending down', icon: '↘', color: 'red'   };
}

// ── LLM: body + so_what ───────────────────────────────────────────────

async function getSnapshotPromptTemplate() {
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', 'daily_snapshot_v1')
    .eq('is_active', true)
    .single();
  if (error || !data) {
    throw new Error(`Could not load daily_snapshot_v1 prompt: ${error?.message}`);
  }
  return data.prompt_template;
}

function buildDimensionsBlock(dimensions) {
  // dimensions: [{ submodule_id, submodule_name, signals: [...] }]
  return dimensions.map((d, i) => {
    const sigLines = d.signals.length
      ? d.signals.slice(0, 5).map(s =>
          `  - ${s.signal_title}${s.organization ? ` (${s.organization})` : ''}: ${(s.summary || '').slice(0, 220)}`
        ).join('\n')
      : '  - (no signals in the window)';
    return `[${i + 1}] submodule_id="${d.submodule_id}" — ${d.submodule_name}\n${sigLines}`;
  }).join('\n\n');
}

async function generateBodyAndSoWhat(moduleTitle, industry, dimensions) {
  let template;
  try {
    template = await getSnapshotPromptTemplate();
  } catch (err) {
    console.warn(`[Snapshot] Prompt not found, falling back to signal summaries: ${err.message}`);
    return null;
  }

  const dimensionsBlock = buildDimensionsBlock(dimensions);
  const userPrompt = template
    .replace(/{module_title}/g, moduleTitle)
    .replace(/{industry}/g, industry || 'Unknown')
    .replace(/{dimensions_block}/g, dimensionsBlock);

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: 'You only respond with valid JSON, nothing else.' },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.3, max_tokens: 1400, timeout: 120000 }
    );
  } catch (err) {
    console.warn(`[Snapshot] LLM call failed: ${err.message}`);
    return null;
  }

  // Strip fences and parse
  let cleaned = (raw || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.rows)) return null;
    return parsed.rows;
  } catch (err) {
    console.warn(`[Snapshot] LLM JSON parse failed: ${err.message}`);
    return null;
  }
}

// ── Main entry point ──────────────────────────────────────────────────

async function buildDailySnapshot(clientId, moduleId, industry) {
  try {
    const moduleTitle = MODULE_TITLES[moduleId];
    if (!moduleTitle) {
      return { success: false, error: `Unknown module_id: ${moduleId}` };
    }

    const signalTable = SIGNAL_TABLE_BY_MODULE[moduleId];
    const window = getIstWindow();

    // Previous-7-day window for the delta computation
    const prevWindowEndIso   = window.windowStartIso;
    const prevWindowStartIso = new Date(
      new Date(window.windowStartIso).getTime() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    // 1. Load enabled submodules
    const submodules = await getEnabledSubmodules(clientId, moduleId);
    if (submodules.length === 0) {
      console.log(`[Snapshot] No enabled submodules for ${clientId}/${moduleTitle}, skipping.`);
      return { success: true, rowCount: 0, skipped: true };
    }

    // 2. For each submodule, gather current-week + prev-week signals
    const dimensions = [];
    for (const sub of submodules) {
      const thisWeek = await getSignalsForWindow(
        signalTable, clientId, sub.submodule_id, window.windowStartIso, window.windowEndIso
      );
      const lastWeek = await getSignalsForWindow(
        signalTable, clientId, sub.submodule_id, prevWindowStartIso, prevWindowEndIso
      );

      const delta = thisWeek.length - lastWeek.length;
      const { status, icon, color } = statusFromDelta(delta, moduleId, thisWeek);

      dimensions.push({
        submodule_id: sub.submodule_id,
        submodule_name: sub.submodule_name,
        signals: thisWeek,
        delta,
        status,
        icon,
        color,
      });
    }

    // 3. One LLM call for body + so_what on all dimensions
    const llmRows = await generateBodyAndSoWhat(moduleTitle, industry, dimensions);
    const llmById = new Map((llmRows || []).map(r => [r.submodule_id, r]));

    // 4. Assemble final rows
    //
    // The LLM sometimes glues words ("activitythis") or rephrases the
    // fallback. We can't rely on prompt engineering to fix this reliably,
    // so we detect the pattern in code and override with our constant.
    const EMPTY_BODY = 'No significant activity this week.';
    const EMPTY_SIGNALS = /no\s*significant|no\s*notable|no\s*relevant|no\s*activity|activity\s*this\s*week|activitythis/i;

    const rows = dimensions.map(d => {
      const llm = llmById.get(d.submodule_id);
      const hasSignals = d.signals.length > 0;

      let body = '';
      let soWhat = null;

      if (hasSignals) {
        body = normalizeText(llm?.body) || normalizeText(d.signals[0]?.summary?.slice(0, 140)) || '';
        soWhat = llm?.so_what ? normalizeText(llm.so_what) : null;
      }

      // If body is empty, or looks like a fallback (glued or not), override.
      if (!body || EMPTY_SIGNALS.test(body)) {
        body = EMPTY_BODY;
        soWhat = null;
      }

      return {
        submodule_id: d.submodule_id,
        label: d.submodule_name,
        icon: d.icon,
        status: d.status,
        color: d.color,
        delta: d.delta,
        delta_label: d.delta === 0
          ? '0 vs last week'
          : `${d.delta > 0 ? '+' : ''}${d.delta} vs last week`,
        body,
        so_what: soWhat,
      };
    });

    // 5. Upsert
    const payload = {
      client_id: clientId,
      module_id: moduleId,
      snapshot_date: window.snapshotDate,
      window_start: window.windowStartDate,
      window_end: window.windowEndDate,
      module_title: moduleTitle,
      rows,
      generated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from('daily_module_snapshots')
      .upsert(payload, { onConflict: 'client_id,module_id,snapshot_date' });

    if (upsertErr) {
      console.error(`[Snapshot] Upsert failed: ${upsertErr.message}`);
      return { success: false, error: upsertErr.message };
    }

    console.log(`[Snapshot] Wrote ${rows.length} dimension rows for ${moduleTitle} (${clientId}) on ${window.snapshotDate}`);
    return { success: true, rowCount: rows.length, snapshotDate: window.snapshotDate };

  } catch (err) {
    console.error(`[Snapshot] Fatal error for ${clientId}/${moduleId}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { buildDailySnapshot };