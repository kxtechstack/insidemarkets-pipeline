/**
 * scripts/dedup-backfill.js
 * ==========================
 * One-off backfill: finds existing duplicate signals (same client + module +
 * submodule + lowercased signal_title within the dedup window) and marks all
 * but the earliest as is_duplicate = true, superseded_by = <earliest id>.
 *
 * Non-destructive: keeps all rows. Read paths filter is_duplicate = false,
 * so marked rows vanish from the UI but remain queryable for audit.
 *
 * Also recomputes market_insights.signal_count for MD cards that had
 * duplicate members, so card counts reflect distinct stories.
 *
 * Usage:
 *   node scripts/dedup-backfill.js --dry-run     (default)
 *   node scripts/dedup-backfill.js --apply
 *
 * Note: each signal table has a slightly different schema. The column
 * selection is defined per-table below so this script works uniformly.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const WINDOW_DAYS = Number(process.env.SIGNAL_DEDUP_WINDOW_DAYS) || 90;
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

// Per-table column list. Only the columns that actually exist on each table.
// Everything the backfill needs to compute a duplicate group + supersede link.
const TABLE_SCHEMAS = {
  trend_signals: {
    columns: 'id, client_id, module_id, submodule_id, signal_title, created_at, is_duplicate',
    insightColumn: null,
  },
  policy_signals: {
    columns: 'id, client_id, module_id, submodule_id, signal_title, created_at, is_duplicate',
    insightColumn: null,
  },
  market_dynamics_signals: {
    columns: 'id, client_id, module_id, submodule_id, signal_title, created_at, is_duplicate, insight_id',
    insightColumn: 'insight_id',
  },
};

async function backfillTable(table) {
  const schema = TABLE_SCHEMAS[table];
  if (!schema) {
    console.log(`\n=== ${table} ===`);
    console.log(`No schema defined for table — skipping.`);
    return { scanned: 0, groups: 0, marked: 0, affectedInsights: new Set() };
  }

  console.log(`\n=== ${table} ===`);
  const cutoffIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from(table)
    .select(schema.columns)
    .eq('is_duplicate', false)
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(`Failed to fetch rows from ${table}: ${error.message}`);
    return { scanned: 0, groups: 0, marked: 0, affectedInsights: new Set() };
  }

  console.log(`Scanned ${rows.length} non-duplicate rows in window.`);

  // Group by (client_id, module_id, submodule_id, lower(signal_title))
  const groups = new Map();
  for (const row of rows) {
    const key = [
      row.client_id,
      row.module_id,
      row.submodule_id,
      (row.signal_title || '').toLowerCase().trim(),
    ].join('||');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let dupesMarked = 0;
  let groupsAffected = 0;
  const affectedInsights = new Set();

  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;
    groupsAffected++;

    // Earliest row is the "canonical" one; the rest are duplicates.
    const [keeper, ...dupes] = group;

    console.log(`  [${group.length}] "${keeper.signal_title}"`);
    console.log(`     keep:   ${keeper.id} (${keeper.created_at})`);

    for (const dupe of dupes) {
      console.log(`     mark:   ${dupe.id} (${dupe.created_at})`);
      if (!DRY_RUN) {
        const { error: updErr } = await supabase
          .from(table)
          .update({ is_duplicate: true, superseded_by: keeper.id })
          .eq('id', dupe.id);
        if (updErr) {
          console.error(`     FAILED to update ${dupe.id}: ${updErr.message}`);
          continue;
        }
      }
      dupesMarked++;
      // Track MD insights so we can recompute their signal_count afterwards
      if (schema.insightColumn) {
        const insightId = dupe[schema.insightColumn];
        if (insightId) affectedInsights.add(insightId);
      }
    }
  }

  console.log(`\n${table} summary: ${groupsAffected} duplicate groups, ${dupesMarked} rows ${DRY_RUN ? 'would be' : ''} marked.`);
  return { scanned: rows.length, groups: groupsAffected, marked: dupesMarked, affectedInsights };
}

async function recomputeInsightSignalCounts(affectedInsightIds) {
  if (affectedInsightIds.size === 0) {
    console.log(`\nNo MD cards need signal_count recompute.`);
    return;
  }

  console.log(`\nRecomputing signal_count for ${affectedInsightIds.size} market_insights card(s)...`);

  for (const insightId of affectedInsightIds) {
    const { count, error: countErr } = await supabase
      .from('market_dynamics_signals')
      .select('id', { count: 'exact', head: true })
      .eq('insight_id', insightId)
      .eq('is_duplicate', false);

    if (countErr) {
      console.error(`  [${insightId}] count failed: ${countErr.message}`);
      continue;
    }

    console.log(`  [${insightId}] new signal_count = ${count}`);

    if (!DRY_RUN) {
      const { error: updErr } = await supabase
        .from('market_insights')
        .update({ signal_count: count })
        .eq('id', insightId);
      if (updErr) {
        console.error(`  [${insightId}] update failed: ${updErr.message}`);
      }
    }
  }
}

(async () => {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY (writing)'}`);
  console.log(`Window: last ${WINDOW_DAYS} days`);

  let totalMarked = 0;
  const allAffectedInsights = new Set();

  for (const table of Object.keys(TABLE_SCHEMAS)) {
    const res = await backfillTable(table);
    totalMarked += res.marked;
    if (res.affectedInsights) {
      for (const id of res.affectedInsights) allAffectedInsights.add(id);
    }
  }

  await recomputeInsightSignalCounts(allAffectedInsights);

  console.log(`\n========================================`);
  console.log(`Total rows ${DRY_RUN ? 'that would be' : ''} marked as duplicate: ${totalMarked}`);
  if (DRY_RUN) {
    console.log(`Re-run with --apply to write the changes.`);
  }
})();