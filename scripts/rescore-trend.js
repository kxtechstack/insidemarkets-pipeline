#!/usr/bin/env node
/**
 * scripts/cleanup-duplicate-trends.js
 * =====================================
 * Removes duplicate members from Forward Outlook trends, caused by the
 * within-batch topic dedup bug that was fixed in modules/topicDedup.js.
 *
 * ── What counts as a duplicate ────────────────────────────────────────
 * Two trend members are considered duplicates if EITHER:
 *   1. They share the same source_article_url (same URL ingested twice)
 *   2. They share the same md5(summary)  (same story, different URL --
 *      the syndicated press-release pattern)
 *
 * Within each duplicate group, the member whose trend_signals.created_at
 * is OLDEST is kept. Everything else is deleted.
 *
 * ── What it does per affected trend ───────────────────────────────────
 *   1. Deletes the redundant trend_membership rows
 *   2. Deletes the now-orphaned trend_signals rows
 *   3. Recomputes dot_size, ring, confidence_score, posture on trend_clusters
 *   4. Resets periods_in_posture = 0 so posture can adjust on next scoring
 *   5. After all trends are processed, runs runWeeklyScoring once per
 *      affected (client_id, module_id, industry) so trend_snapshots gets
 *      a fresh, correct row that the dashboard will display
 *
 * ── Safety ────────────────────────────────────────────────────────────
 * - Dry-run by default. Nothing is deleted unless you pass --apply.
 * - Skips any trend_signals row whose source_article_url contains
 *   'example.com' (test/seed data).
 * - Does NOT touch policy_signals, market_dynamics_signals, or
 *   policy_articles_full. Only trend-side tables.
 * - Does NOT touch Qdrant. Orphan vectors in trend_matching are harmless;
 *   they'll never be matched because their article_id no longer exists in
 *   trend_membership.
 * - Prints a summary report at the end.
 *
 * ── Usage ─────────────────────────────────────────────────────────────
 *   Dry-run (safe, default):
 *     docker exec -it app-test-app-1 node scripts/cleanup-duplicate-trends.js
 *
 *   Apply changes:
 *     docker exec -it app-test-app-1 node scripts/cleanup-duplicate-trends.js --apply
 *
 *   Scope to one client:
 *     docker exec -it app-test-app-1 node scripts/cleanup-duplicate-trends.js --apply --client=<uuid>
 *
 *   Scope to one trend:
 *     docker exec -it app-test-app-1 node scripts/cleanup-duplicate-trends.js --apply --trend=<uuid>
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CLIENT_FILTER = (args.find(a => a.startsWith('--client=')) || '').split('=')[1] || null;
const TREND_FILTER = (args.find(a => a.startsWith('--trend=')) || '').split('=')[1] || null;

const { runWeeklyScoring } = require('../modules/trendClustering');

const md5 = (s) => crypto.createHash('md5').update(s || '').digest('hex');

// ── Fetch every trend member (excludes example.com test data) ────────────
async function loadAllMembers() {
  let query = supabase
    .from('trend_membership')
    .select(`
      id,
      trend_id,
      signal_id,
      joined_at,
      trend_signals!inner (
        id,
        client_id,
        module_id,
        industry,
        source_article_url,
        summary,
        created_at
      )
    `)
    .not('trend_signals.source_article_url', 'ilike', '%example.com%');

  if (TREND_FILTER) query = query.eq('trend_id', TREND_FILTER);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load trend_membership: ${error.message}`);
  return data || [];
}

// ── Group members of a single trend by duplicate key ─────────────────────
// Duplicate groups are formed by UNION of URL-equal and summary-equal.
// We use a simple union-find style grouping to handle that cleanly.
function groupDuplicates(members) {
  const byUrl = new Map();
  const byHash = new Map();
  const parent = new Map(); // signal_id -> representative signal_id

  const find = (id) => {
    if (parent.get(id) === id) return id;
    const root = find(parent.get(id));
    parent.set(id, root);
    return root;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const m of members) parent.set(m.signal_id, m.signal_id);

  for (const m of members) {
    const url = m.trend_signals?.source_article_url;
    if (url) {
      if (byUrl.has(url)) union(m.signal_id, byUrl.get(url));
      else byUrl.set(url, m.signal_id);
    }
  }
  for (const m of members) {
    const hash = md5(m.trend_signals?.summary);
    if (byHash.has(hash)) union(m.signal_id, byHash.get(hash));
    else byHash.set(hash, m.signal_id);
  }

  // Build groups: representative -> [members]
  const groups = new Map();
  for (const m of members) {
    const root = find(m.signal_id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(m);
  }
  return [...groups.values()];
}

// ── Analyze all trends and produce a plan ────────────────────────────────
async function buildPlan(members) {
  // Group members by trend_id
  const byTrend = new Map();
  for (const m of members) {
    if (!byTrend.has(m.trend_id)) byTrend.set(m.trend_id, []);
    byTrend.get(m.trend_id).push(m);
  }

  const plan = []; // [{ trendId, clientId, moduleId, industry, keep: [...], delete: [...] }]

  for (const [trendId, trendMembers] of byTrend) {
    if (CLIENT_FILTER && trendMembers[0].trend_signals.client_id !== CLIENT_FILTER) continue;

    const groups = groupDuplicates(trendMembers);

    const keep = [];
    const remove = [];

    for (const group of groups) {
      if (group.length === 1) {
        keep.push(group[0]);
        continue;
      }
      // Sort by trend_signals.created_at ascending -- oldest wins
      const sorted = [...group].sort((a, b) => {
        const ta = new Date(a.trend_signals.created_at).getTime();
        const tb = new Date(b.trend_signals.created_at).getTime();
        return ta - tb;
      });
      keep.push(sorted[0]);
      remove.push(...sorted.slice(1));
    }

    if (remove.length === 0) continue; // nothing to do for this trend

    plan.push({
      trendId,
      clientId: trendMembers[0].trend_signals.client_id,
      moduleId: trendMembers[0].trend_signals.module_id,
      industry: trendMembers[0].trend_signals.industry,
      keep,
      remove,
      totalMembers: trendMembers.length,
    });
  }

  return plan;
}

// ── Print the report ─────────────────────────────────────────────────────
function printPlan(plan) {
  console.log('');
  console.log('='.repeat(72));
  console.log(`DRY RUN — no changes made${APPLY ? '' : ' (pass --apply to commit)'}`);
  console.log('='.repeat(72));
  console.log('');

  if (plan.length === 0) {
    console.log('No trends with duplicates found. Nothing to do.');
    return;
  }

  let totalRemoved = 0;
  let totalKept = 0;

  for (const p of plan) {
    console.log(`Trend: ${p.trendId}`);
    console.log(`  client: ${p.clientId}  |  module: ${p.moduleId}  |  industry: ${p.industry}`);
    console.log(`  members: ${p.totalMembers}  |  keeping: ${p.keep.length}  |  removing: ${p.remove.length}`);
    for (const r of p.remove) {
      const url = r.trend_signals.source_article_url || '(no url)';
      const t = r.trend_signals.created_at;
      console.log(`    - REMOVE  ${r.signal_id}  ${t}  ${url}`);
    }
    console.log('');
    totalRemoved += p.remove.length;
    totalKept += p.keep.length;
  }

  console.log('='.repeat(72));
  console.log(`SUMMARY: ${plan.length} trends affected`);
  console.log(`         ${totalKept} memberships kept`);
  console.log(`         ${totalRemoved} memberships to delete`);
  console.log(`         ${totalRemoved} trend_signals to delete (same count)`);
  console.log('='.repeat(72));
  console.log('');
}

// ── Execute the plan ─────────────────────────────────────────────────────
async function applyPlan(plan) {
  console.log('');
  console.log('Applying changes...');
  console.log('');

  let membershipsDeleted = 0;
  let signalsDeleted = 0;
  const affected = new Set(); // "clientId|moduleId|industry"

  for (const p of plan) {
    console.log(`Trend ${p.trendId}: removing ${p.remove.length} duplicate members...`);

    const membershipIds = p.remove.map(r => r.id);
    const signalIds = p.remove.map(r => r.signal_id);

    // 1. Delete trend_membership rows
    const { error: tmErr } = await supabase
      .from('trend_membership')
      .delete()
      .in('id', membershipIds);
    if (tmErr) {
      console.error(`  [!] Failed to delete memberships: ${tmErr.message}`);
      continue;
    }
    membershipsDeleted += membershipIds.length;

    // 2. Verify none of the signals are still referenced
    const { data: stillRef, error: refErr } = await supabase
      .from('trend_membership')
      .select('id')
      .in('signal_id', signalIds);
    if (refErr) {
      console.error(`  [!] Verification query failed: ${refErr.message}`);
      continue;
    }
    if (stillRef && stillRef.length > 0) {
      console.error(`  [!] ${stillRef.length} signals still referenced elsewhere, skipping signal delete for this trend`);
      continue;
    }

    // 3. Delete trend_signals rows
    const { error: tsErr } = await supabase
      .from('trend_signals')
      .delete()
      .in('id', signalIds);
    if (tsErr) {
      console.error(`  [!] Failed to delete signals: ${tsErr.message}`);
      continue;
    }
    signalsDeleted += signalIds.length;

    // 4. Reset hysteresis so posture can adjust on next scoring
    await supabase
      .from('trend_clusters')
      .update({ periods_in_posture: 0, last_updated_at: new Date().toISOString() })
      .eq('id', p.trendId);

    affected.add(`${p.clientId}|${p.moduleId}|${p.industry}`);
    console.log(`  [ok] ${membershipIds.length} memberships + ${signalIds.length} signals removed`);
  }

  console.log('');
  console.log('='.repeat(72));
  console.log(`Deleted ${membershipsDeleted} memberships`);
  console.log(`Deleted ${signalsDeleted} signals`);
  console.log('='.repeat(72));
  console.log('');

  // 5. Run weekly scoring for each affected (client, module, industry)
  if (affected.size > 0) {
    console.log(`Re-scoring ${affected.size} client+module+industry combos...`);
    console.log('');
    for (const key of affected) {
      const [clientId, moduleId, industry] = key.split('|');
      console.log(`--- Scoring: client=${clientId} module=${moduleId} industry=${industry}`);
      try {
        await runWeeklyScoring(moduleId, clientId, industry);
      } catch (err) {
        console.error(`  [!] Scoring failed: ${err.message}`);
      }
      console.log('');
    }
  }

  console.log('Done.');
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log(`Mode: ${APPLY ? 'APPLY (changes will be made)' : 'DRY RUN (no changes)'}`);
    if (CLIENT_FILTER) console.log(`Client filter: ${CLIENT_FILTER}`);
    if (TREND_FILTER) console.log(`Trend filter: ${TREND_FILTER}`);
    console.log('');

    console.log('Loading trend members...');
    const members = await loadAllMembers();
    console.log(`Loaded ${members.length} memberships across ${new Set(members.map(m => m.trend_id)).size} trends.`);
    console.log('');

    console.log('Building cleanup plan...');
    const plan = await buildPlan(members);

    printPlan(plan);

    if (!APPLY) {
      console.log('DRY RUN — no changes made. Re-run with --apply to execute.');
      process.exit(0);
    }

    if (plan.length === 0) {
      console.log('Nothing to do.');
      process.exit(0);
    }

    await applyPlan(plan);
    process.exit(0);

  } catch (err) {
    console.error('[cleanup] Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();