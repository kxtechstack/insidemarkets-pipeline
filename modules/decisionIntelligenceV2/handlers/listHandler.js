/**
 * modules/decisionIntelligenceV2/handlers/listHandler.js
 *
 * STAGE 3a — list handler.
 *
 * Takes retrieval hits from retrieveClientSignals and returns a clean
 * items array. No LLM call. Pure joins.
 *
 * Flow:
 *   1. Group hits by module_id.
 *   2. For each module, look up the corresponding signal row by article_id:
 *        Policy & Risk    → policy_signals
 *        Market Dynamics  → market_dynamics_signals  (+ insight title)
 *        Forward Outlook  → trend_signals            (+ trend title)
 *   3. Merge, sort, return.
 *
 * The `matched` flag from the retrieval layer is preserved so the frontend
 * can style matched vs un-matched items differently.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const POLICY_MODULE_ID = '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960';
const MD_MODULE_ID     = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const FO_MODULE_ID     = '2eb989fd-0ea0-4320-b73a-f7eb8b970473';

// ─────────────────────────────────────────────────────────────────────────
// Signal-table lookups per module
// ─────────────────────────────────────────────────────────────────────────

async function fetchPolicySignals(articleIds) {
  if (!articleIds.length) return new Map();
  const { data, error } = await supabase
    .from('policy_signals')
    .select('id, article_id, signal_title, summary, category, impact_level, country, source_article_url, source_published_date')
    .in('article_id', articleIds);
  if (error) {
    console.log(`[listHandler] policy_signals lookup failed: ${error.message}`);
    return new Map();
  }
  return new Map((data || []).map((r) => [r.article_id, r]));
}

async function fetchMDSignals(articleIds) {
  if (!articleIds.length) return new Map();
  const { data: signalRows, error } = await supabase
    .from('market_dynamics_signals')
    .select('id, article_id, insight_id, signal_title, summary, organization, country, source_url, published_date, category')
    .in('article_id', articleIds);
  if (error) {
    console.log(`[listHandler] market_dynamics_signals lookup failed: ${error.message}`);
    return new Map();
  }

  // Look up parent insight titles for MD signals (nice for parentLabel)
  const insightIds = [...new Set((signalRows || []).map((r) => r.insight_id).filter(Boolean))];
  let insightById = new Map();
  if (insightIds.length) {
    const { data: insights } = await supabase
      .from('market_insights')
      .select('id, title, category')
      .in('id', insightIds);
    insightById = new Map((insights || []).map((i) => [i.id, i]));
  }

  const out = new Map();
  for (const r of signalRows || []) {
    const insight = r.insight_id ? insightById.get(r.insight_id) : null;
    out.set(r.article_id, {
      ...r,
      insight_title: insight?.title || null,
      insight_category: insight?.category || null,
    });
  }
  return out;
}

async function fetchFOSignals(articleIds) {
  if (!articleIds.length) return new Map();
  const { data: signalRows, error } = await supabase
    .from('trend_signals')
    .select('id, article_id, signal_title, summary, sector, horizon_estimate, source_article_url')
    .in('article_id', articleIds);
  if (error) {
    console.log(`[listHandler] trend_signals lookup failed: ${error.message}`);
    return new Map();
  }

  // Look up parent trend for each signal
  const signalIds = (signalRows || []).map((r) => r.id);
  let trendBySignal = new Map();
  let trendById = new Map();
  if (signalIds.length) {
    const { data: memberships } = await supabase
      .from('trend_membership')
      .select('signal_id, trend_id')
      .in('signal_id', signalIds);
    const trendIds = [...new Set((memberships || []).map((m) => m.trend_id))];
    if (trendIds.length) {
      const { data: trends } = await supabase
        .from('trend_clusters')
        .select('id, name, sector, status')
        .in('id', trendIds);
      trendById = new Map((trends || []).map((t) => [t.id, t]));
    }
    trendBySignal = new Map((memberships || []).map((m) => [m.signal_id, m.trend_id]));
  }

  const out = new Map();
  for (const r of signalRows || []) {
    const trendId = trendBySignal.get(r.id);
    const trend = trendId ? trendById.get(trendId) : null;
    // Only attach if the trend is active — matches what the FO tab shows
    const trendIsActive = trend?.status === 'active';
    out.set(r.article_id, {
      ...r,
      trend_name: trendIsActive ? trend.name : null,
      trend_sector: trendIsActive ? trend.sector : null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────
/**
 * @param {Array} hits  output of retrieveClientSignals() — already sorted,
 *                      has `_matched` flag on each
 * @returns {Promise<{
 *   items: Array<Object>,
 *   matchedCount: number,
 *   unmatchedCount: number,
 * }>}
 */
async function buildListItems(hits) {
  if (!Array.isArray(hits) || hits.length === 0) {
    return { items: [], matchedCount: 0, unmatchedCount: 0 };
  }

  // Group by module (skip hits without article_id — can't be resolved)
  const byModule = {
    [POLICY_MODULE_ID]: [],
    [MD_MODULE_ID]: [],
    [FO_MODULE_ID]: [],
  };
  for (const h of hits) {
    const articleId = h.article_id;
    if (!articleId) continue;
    const bucket = byModule[h.module_id];
    if (bucket) bucket.push(h);
  }

  // Parallel fetches
  const [policyByArticle, mdByArticle, foByArticle] = await Promise.all([
    fetchPolicySignals(byModule[POLICY_MODULE_ID].map((h) => h.article_id)),
    fetchMDSignals(byModule[MD_MODULE_ID].map((h) => h.article_id)),
    fetchFOSignals(byModule[FO_MODULE_ID].map((h) => h.article_id)),
  ]);

  // Preserve hit order (hits came in sorted order — matched first).
  // Dedupe by article_id only. Two hits with different article_ids are
  // two different articles — even if their titles look similar — so both
  // are kept. Syndicated copies ARE separate articles with their own URLs
  // and are shown to the user as separate sources.
  const seenArticleIds = new Set();
  const items = [];

  for (const h of hits) {
    const articleId = h.article_id;
    if (!articleId) continue;
    if (seenArticleIds.has(articleId)) continue;
    seenArticleIds.add(articleId);

    let item = null;

    if (h.module_id === POLICY_MODULE_ID) {
      const row = policyByArticle.get(articleId);
      if (row) {
        item = {
          id: row.id,
          title: row.signal_title,
          summary: row.summary,
          url: row.source_article_url,
          module: 'Policy & Risk',
          category: row.category,
          impact: row.impact_level,
          country: row.country,
          organization: null,
          horizon: null,
          publishedDate: row.source_published_date,
          parentLabel: null,
          matched: Boolean(h._matched),
        };
      }
    } else if (h.module_id === MD_MODULE_ID) {
      const row = mdByArticle.get(articleId);
      if (row) {
        item = {
          id: row.id,
          title: row.signal_title,
          summary: row.summary,
          url: row.source_url,
          module: 'Market Dynamics',
          category: row.insight_category || row.category || null,
          impact: null,
          country: row.country,
          organization: row.organization,
          horizon: null,
          publishedDate: row.published_date,
          parentLabel: row.insight_title ? `Insight: ${row.insight_title}` : null,
          matched: Boolean(h._matched),
        };
      }
    } else if (h.module_id === FO_MODULE_ID) {
      const row = foByArticle.get(articleId);
      if (row) {
        item = {
          id: row.id,
          title: row.signal_title,
          summary: row.summary,
          url: row.source_article_url,
          module: 'Forward Outlook',
          category: row.trend_sector || row.sector || null,
          impact: null,
          country: null,
          organization: null,
          horizon: row.horizon_estimate,
          publishedDate: null,
          parentLabel: row.trend_name ? `Trend: ${row.trend_name}` : null,
          matched: Boolean(h._matched),
        };
      }
    }

    if (item) items.push(item);
  }

  const matchedCount = items.filter((i) => i.matched).length;
  const unmatchedCount = items.length - matchedCount;
  return { items, matchedCount, unmatchedCount };
}

module.exports = { buildListItems };