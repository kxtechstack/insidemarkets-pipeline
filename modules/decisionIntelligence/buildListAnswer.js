/**
 * modules/decisionIntelligence/buildListAnswer.js
 *
 * Builds a List answer for the Decision Intelligence chat -- NO LLM call.
 *
 * Joins by article_id (present in the Qdrant payload from
 * retrieveClientData.js) against the signal table that matches each
 * module:
 *   - Policy & Risk    -> policy_signals   (signal_title, category, impact_level, country, summary)
 *   - Forward Outlook  -> trend_signals    (signal_title, sector, horizon_estimate) -- no impact_level/category
 *   - Market Dynamics  -> market_dynamics_signals (article-level) -> market_insights_live
 *     (bundle-level, via insight_id) -> market_insight_members (to collect every
 *     source article in the bundle). A market_insights_live row is a BUNDLE of
 *     several articles, so dedup for this module happens on insight_id, not
 *     article_id -- two different matched articles can belong to the same bundle.
 */

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const POLICY_MODULE_ID = '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960';
const MARKET_DYNAMICS_MODULE_ID = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const FORWARD_OUTLOOK_MODULE_ID = '2eb989fd-0ea0-4320-b73a-f7eb8b970473';

/**
 * @param {Array} searchResults - the array returned by retrieveClientData()
 * @returns {Promise<Array>} formatted list items, ready to display directly
 *   Policy & Forward Outlook items: { title, category, impact, country, summary, url, module }
 *   Market Dynamics items:          { title, category, impact, country, summary, urls: [...], module }
 *     (note: `urls` is an ARRAY for Market Dynamics -- a bundle can have multiple sources -- while
 *     Policy/Forward Outlook keep the singular `url`, since those are true 1:1 article matches)
 */
async function buildListAnswer(searchResults) {
  // Dedupe by article_id (more reliable than title/url) and split by module
  const seen = new Set();
  const byModule = { [POLICY_MODULE_ID]: [], [FORWARD_OUTLOOK_MODULE_ID]: [], [MARKET_DYNAMICS_MODULE_ID]: [], other: [] };

  for (const r of searchResults) {
    const articleId = r.payload.article_id;
    const key = articleId || r.payload.url || r.payload.title;
    if (seen.has(key)) continue;
    seen.add(key);

    if (r.payload.module_id === POLICY_MODULE_ID && articleId) {
      byModule[POLICY_MODULE_ID].push({ articleId, payload: r.payload });
    } else if (r.payload.module_id === FORWARD_OUTLOOK_MODULE_ID && articleId) {
      byModule[FORWARD_OUTLOOK_MODULE_ID].push({ articleId, payload: r.payload });
    } else if (r.payload.module_id === MARKET_DYNAMICS_MODULE_ID && articleId) {
      byModule[MARKET_DYNAMICS_MODULE_ID].push({ articleId, payload: r.payload });
    } else {
      byModule.other.push(r);
    }
  }

  const items = [];

  // ---- Policy & Risk: join to policy_signals ----
  if (byModule[POLICY_MODULE_ID].length) {
    const ids = byModule[POLICY_MODULE_ID].map(x => x.articleId);
    const { data, error } = await supabase
      .from('policy_signals')
      .select('article_id, signal_title, category, impact_level, country, summary, source_article_url')
      .in('article_id', ids);
    if (error) throw error;

    const byArticleId = new Map(data.map(row => [row.article_id, row]));
    for (const { articleId } of byModule[POLICY_MODULE_ID]) {
      const row = byArticleId.get(articleId);
      if (row) {
        items.push({
          title: row.signal_title,
          category: row.category,
          impact: row.impact_level,
          country: row.country,
          summary: row.summary,
          url: row.source_article_url,
          module: 'Policy & Risk',
        });
      }
    }
  }

  // ---- Forward Outlook: join to trend_signals ----
  if (byModule[FORWARD_OUTLOOK_MODULE_ID].length) {
    const ids = byModule[FORWARD_OUTLOOK_MODULE_ID].map(x => x.articleId);
    const { data, error } = await supabase
      .from('trend_signals')
      .select('article_id, signal_title, sector, horizon_estimate, summary, source_article_url')
      .in('article_id', ids);
    if (error) throw error;

    const byArticleId = new Map(data.map(row => [row.article_id, row]));
    for (const { articleId } of byModule[FORWARD_OUTLOOK_MODULE_ID]) {
      const row = byArticleId.get(articleId);
      if (row) {
        items.push({
          title: row.signal_title,
          category: row.sector,
          impact: null, // trend_signals has no impact_level column
          horizon: row.horizon_estimate,
          summary: row.summary,
          url: row.source_article_url,
          module: 'Forward Outlook',
        });
      }
    }
  }

  // ---- Market Dynamics: article_id -> market_dynamics_signals -> insight_id ----
  // ----                  -> market_insights_live (bundle card) ----
  // ----                  -> market_insight_members (all sources in the bundle) ----
  if (byModule[MARKET_DYNAMICS_MODULE_ID].length) {
    const articleIds = byModule[MARKET_DYNAMICS_MODULE_ID].map(x => x.articleId);

    // Step 1: article_id -> signal row (gives us insight_id per matched article)
    const { data: signalRows, error: sigErr } = await supabase
      .from('market_dynamics_signals')
      .select('article_id, insight_id')
      .in('article_id', articleIds);
    if (sigErr) throw sigErr;

    const insightIdByArticleId = new Map(signalRows.map(r => [r.article_id, r.insight_id]));

    // Resolve to unique insight_ids -- this is the real dedup key for this module,
    // since multiple matched articles can belong to the same bundle.
    const uniqueInsightIds = [...new Set(insightIdByArticleId.values())].filter(Boolean);

    if (uniqueInsightIds.length) {
      // Step 2: insight_id -> the bundle-level card itself
      const { data: insightRows, error: insErr } = await supabase
        .from('market_insights_live')
        .select('id, title, category, relevance_level, country, summary, short_summary')
        .in('id', uniqueInsightIds);
      if (insErr) throw insErr;
      const insightById = new Map(insightRows.map(r => [r.id, r]));

      // Step 3: insight_id -> every article_id in that bundle
      const { data: memberRows, error: memErr } = await supabase
        .from('market_insight_members')
        .select('insight_id, article_id')
        .in('insight_id', uniqueInsightIds);
      if (memErr) throw memErr;

      const memberArticleIdsByInsight = new Map();
      for (const m of memberRows) {
        if (!memberArticleIdsByInsight.has(m.insight_id)) memberArticleIdsByInsight.set(m.insight_id, []);
        memberArticleIdsByInsight.get(m.insight_id).push(m.article_id);
      }

      // Step 4: every member article_id -> its source_url, so each card can list all its sources
      const allMemberArticleIds = [...new Set(memberRows.map(m => m.article_id))];
      const { data: urlRows, error: urlErr } = await supabase
        .from('market_dynamics_signals')
        .select('article_id, source_url')
        .in('article_id', allMemberArticleIds);
      if (urlErr) throw urlErr;
      const urlByArticleId = new Map(urlRows.map(r => [r.article_id, r.source_url]));

      // Build one item per unique insight_id (bundle), not per matched article
      for (const insightId of uniqueInsightIds) {
        const insight = insightById.get(insightId);
        if (!insight) continue;

        const memberArticleIds = memberArticleIdsByInsight.get(insightId) || [];
        const urls = memberArticleIds
          .map(aid => urlByArticleId.get(aid))
          .filter(Boolean);

        items.push({
          title: insight.title,
          category: insight.category,
          impact: insight.relevance_level, // relevance_level standing in for impact, same Low/Medium/High shape as Policy & Risk
          country: insight.country,
          summary: insight.summary,
          urls, // ARRAY -- a bundle can have multiple source articles, unlike Policy/Forward Outlook's single `url`
          module: 'Market Dynamics',
        });
      }
    }
  }

  // ---- Everything else (missing article_id, unknown module): fallback to raw Qdrant payload ----
  for (const r of byModule.other) {
    items.push({
      title: r.payload.title,
      category: null,
      impact: null,
      summary: r.payload.chunk_text ? r.payload.chunk_text.slice(0, 200) : null,
      url: r.payload.url,
      module: 'Unknown',
    });
  }

  return items;
}

module.exports = { buildListAnswer };