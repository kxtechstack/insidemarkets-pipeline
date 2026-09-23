#!/usr/bin/env node
/**
 * scripts/rescore-trend.js
 * ==========================
 * Cleans up duplicate members in Forward Outlook trends (caused by the
 * within-batch topic dedup bug that was fixed in modules/topicDedup.js),
 * then re-runs weekly scoring to refresh snapshots.
 *
 * ── What counts as a duplicate ────────────────────────────────────────
 * Two members of the same trend are duplicates if EITHER:
 *   1. They share the same source_article_url (URL ingested twice)
 *   2. They share the same md5(summary)  (syndicated press-release pattern)
 *
 * Within each group, the member with the OLDEST trend_signals.created_at
 * is kept. Everything else is deleted.
 *
 * ── Safety ────────────────────────────────────────────────────────────
 * - Dry-run by default. Pass --apply to actually delete.
 * - Skips example.com test data.
 * - Does NOT touch policy_signals, market_dynamics_signals, or Qdrant.
 *
 * ── Usage ─────────────────────────────────────────────────────────────
 *   Dry run:   docker exec -it app-test-app-1 node scripts/rescore-trend.js
 *   Apply:     docker exec -it app-test-app-1 node scripts/rescore-trend.js --apply
 *   Filter:    ... --apply --client=<uuid>   or   --apply --trend=<uuid>
 *
 *   No-args mode (used earlier for single-client re-scoring):
 *     node scripts/rescore-trend.js <moduleId> <clientId> <industry>
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CLIENT_FILTER = (args.find(a => a.startsWith('--client=')) || '').split('=')[1] || null;
const TREND_FILTER  = (args.find(a => a.startsWith('--trend='))  || '').split('=')[1] || null;

// ── Legacy mode: rescore-trend.js <moduleId> <clientId> <industry> ───────
// (Kept so the earlier workflow still works.)
if (!APPLY && !CLIENT_FILTER && !TREND_FILTER && args.length === 3 && !args[0].startsWith('--')) {
  const [moduleId, clientId, industry] = args;
  const { runWeeklyScoring } = require('../modules/trendClustering');
  (async () => {
    console.log('[Rescore] Running weekly scoring for:');
    console.log('  moduleId:', moduleId);
    console.log('  clientId:', clientId);
    console.log('  industry:', industry);
    console.log('');
    await runWeeklyScoring(moduleId, clientId, industry);
    console.log('\n[Rescore] Done.');
    process.exit(0);
  })().catch(err => {
    console.error('[Rescore] Failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
  return;
}

const { runWeeklyScoring } = require('../modules/trendClustering');
const md5 = (s) => crypto.createHash('md5').update(s || '').digest('hex');

// ── Load memberships (no embedded join -- does it in JS) ─────────────────
async function loadAllMembers() {
  // 1. All memberships (optionally filtered by trend)
  let mq = supabase.from('trend_membership').select('id, trend_id, signal_id, joined_at');
  if (TREND_FILTER) mq = mq.eq('trend_id', TREND_FILTER);
  const { data: memberships, error: mErr } = await mq;
  if (mErr) throw new Error(`Failed to load trend_membership: ${mErr.message}`);
  if (!memberships || memberships.length === 0) return [];

  // 2. All distinct signal_ids, batched (Supabase has a URL length limit)
  const signalIds = [...new Set(memberships.map(m => m.signal_id).filter(Boolean))];
  const signalsById = new Map();
  const BATCH = 200;
  for (let i = 0; i < signalIds.length; i += BATCH) {
    const slice = signalIds.slice(i, i + BATCH);
    let sq = supabase
      .from('trend_signals')
      .select('id, client_id, module_id, industry, source_article_url, summary, created_at')
      .in('id', slice);
    const { data: signals, error: sErr } = await sq;
    if (sErr) throw new Error(`Failed to load trend_signals: ${sErr.message}`);
    for (const s of signals || []) signalsById.set(s.id, s);
  }

  // 3. Join in JS. Drop any whose signal row is missing or is test data.
  const joined = [];
  for (const m of memberships) {
    const s = signalsById.get(m.signal_id);
    if (!s) continue; // orphaned membership -- skip
    if (s.source_article_url && s.source_article_url.includes('example.com')) continue;
    if (CLIENT_FILTER && s.client_id !== CLIENT_FILTER) continue;
    joined.push({ ...m, trend_signals: s });
  }
  return joined;
}

// ── Group members of a trend into duplicate clusters (union-find) ────────
function groupDuplicates(members) {
  const parent = new Map();
  const find = (id) => {
    if (parent.get(id) === id) return id;
    const r = find(parent.get(id));
    parent.set(id, r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const m of members) parent.set(m.signal_id, m.signal_id);

  const byUrl = new Map();
  const byHash = new Map();
  for (const m of members) {
    const url = m.trend_signals.source_article_url;
    if (url) {
      if (byUrl.has(url)) union(m.signal_id, byUrl.get(url));
      else byUrl.set(url, m.signal_id);
    }
  }
  for (const m of members) {
    const h = md5(m.trend_signals.summary);
    if (byHash.has(h)) union(m.signal_id, byHash.get(h));
    else byHash.set(h, m.signal_id);
  }

  const groups = new Map();
  for (const m of members) {
    const r = find(m.signal_id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(m);
  }
  return [...groups.values()];
}

// ── Build the plan ───────────────────────────────────────────────────────
async function buildPlan(members) {
  const byTrend = new Map();
  for (const m of members) {
    if (!byTrend.has(m.trend_id)) byTrend.set(m.trend_id, []);
    byTrend.get(m.trend_id).push(m);
  }

  const plan = [];
  for (const [trendId, trendMembers] of byTrend) {
    const groups = groupDuplicates(trendMembers);
    const keep = [], remove = [];
    for (const group of groups) {
      if (group.length === 1) { keep.push(group[0]); continue; }
      const sorted = [...group].sort((a, b) =>
        new Date(a.trend_signals.created_at).getTime() -
        new Date(b.trend_signals.created_at).getTime()
      );
      keep.push(sorted[0]);
      remove.push(...sorted.slice(1));
    }
    if (remove.length === 0) continue;

    plan.push({
      trendId,
      clientId: trendMembers[0].trend_signals.client_id,
      moduleId: trendMembers[0].trend_signals.module_id,
      industry: trendMembers[0].trend_signals.industry,
      keep, remove,
      totalMembers: trendMembers.length,
    });
  }
  return plan;
}

// ── Report ───────────────────────────────────────────────────────────────
function printPlan(plan) {
  console.log('');
  console.log('='.repeat(72));
  console.log(`MODE: ${APPLY ? 'APPLY (will delete)' : 'DRY RUN (no changes)'}`);
  console.log('='.repeat(72));
  console.log('');

  if (plan.length === 0) {
    console.log('No trends with duplicates found.');
    return;
  }

  let totalRemoved = 0, totalKept = 0;
  for (const p of plan) {
    console.log(`Trend: ${p.trendId}`);
    console.log(`  client=${p.clientId}  module=${p.moduleId}  industry=${p.industry}`);
    console.log(`  members=${p.totalMembers}  keep=${p.keep.length}  remove=${p.remove.length}`);
    for (const r of p.remove) {
      console.log(`    REMOVE ${r.signal_id}  ${r.trend_signals.created_at}  ${r.trend_signals.source_article_url || '(no url)'}`);
    }
    console.log('');
    totalRemoved += p.remove.length;
    totalKept += p.keep.length;
  }

  console.log('='.repeat(72));
  console.log(`SUMMARY: ${plan.length} trends affected`);
  console.log(`         ${totalKept} memberships kept`);
  console.log(`         ${totalRemoved} memberships to delete`);
  console.log('='.repeat(72));
  console.log('');
}

// ── Apply ────────────────────────────────────────────────────────────────
async function applyPlan(plan) {
  let membershipsDeleted = 0, signalsDeleted = 0;
  const affected = new Set();

  for (const p of plan) {
    const membershipIds = p.remove.map(r => r.id);
    const signalIds = p.remove.map(r => r.signal_id);

    console.log(`Trend ${p.trendId}: removing ${membershipIds.length} members...`);

    // 1. Delete trend_membership rows
    const { error: tmErr } = await supabase
      .from('trend_membership')
      .delete()
      .in('id', membershipIds);
    if (tmErr) { console.error(`  [!] membership delete failed: ${tmErr.message}`); continue; }
    membershipsDeleted += membershipIds.length;

    // 2. Verify signals aren't referenced elsewhere
    const { data: stillRef } = await supabase
      .from('trend_membership')
      .select('id')
      .in('signal_id', signalIds);
    if (stillRef && stillRef.length > 0) {
      console.error(`  [!] ${stillRef.length} signals still referenced elsewhere, skipping signal delete for this trend`);
      continue;
    }

    // 3. Delete trend_signals rows
    const { error: tsErr } = await supabase
      .from('trend_signals')
      .delete()
      .in('id', signalIds);
    if (tsErr) { console.error(`  [!] signal delete failed: ${tsErr.message}`); continue; }
    signalsDeleted += signalIds.length;

    // 4. Reset hysteresis
    await supabase
      .from('trend_clusters')
      .update({ periods_in_posture: 0, last_updated_at: new Date().toISOString() })
      .eq('id', p.trendId);

    affected.add(`${p.clientId}|${p.moduleId}|${p.industry}`);
    console.log(`  [ok] removed ${membershipIds.length} memberships + ${signalIds.length} signals`);
  }

  console.log('');
  console.log('='.repeat(72));
  console.log(`Deleted ${membershipsDeleted} memberships, ${signalsDeleted} signals`);
  console.log('='.repeat(72));
  console.log('');

  // 5. Re-run weekly scoring for each affected combo
  if (affected.size > 0) {
    console.log(`Re-scoring ${affected.size} client+module+industry combos...\n`);
    for (const key of affected) {
      const [clientId, moduleId, industry] = key.split('|');
      console.log(`--- Scoring: ${clientId} / ${moduleId} / ${industry}`);
      try { await runWeeklyScoring(moduleId, clientId, industry); }
      catch (err) { console.error(`  [!] scoring failed: ${err.message}`); }
      console.log('');
    }
  }
  console.log('Done.');
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
    if (CLIENT_FILTER) console.log(`Client filter: ${CLIENT_FILTER}`);
    if (TREND_FILTER)  console.log(`Trend filter:  ${TREND_FILTER}`);
    console.log('');

    console.log('Loading trend memberships...');
    const members = await loadAllMembers();
    console.log(`Loaded ${members.length} memberships across ${new Set(members.map(m => m.trend_id)).size} trends.\n`);

    console.log('Building cleanup plan...');
    const plan = await buildPlan(members);
    printPlan(plan);

    if (!APPLY) { console.log('DRY RUN — pass --apply to execute.'); process.exit(0); }
    if (plan.length === 0) { console.log('Nothing to do.'); process.exit(0); }

    await applyPlan(plan);
    process.exit(0);
  } catch (err) {
    console.error('[cleanup] Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();