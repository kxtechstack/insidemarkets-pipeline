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

  // ---- Forward Outlook: return individual signals + parent trend name ----
if (byModule[FORWARD_OUTLOOK_MODULE_ID].length) {
  const ids = byModule[FORWARD_OUTLOOK_MODULE_ID].map(x => x.articleId);

  const { data: signals, error } = await supabase
    .from('trend_signals')
    .select('id, article_id, signal_title, sector, horizon_estimate, summary, source_article_url')
    .in('article_id', ids);
  if (error) throw error;

  // Get trend membership for these signals
  const signalIds = signals.map(s => s.id);
  const { data: memberships } = await supabase
    .from('trend_membership')
    .select('signal_id, trend_id')
    .in('signal_id', signalIds);

  const trendIdBySignal = new Map((memberships || []).map(m => [m.signal_id, m.trend_id]));

  // Get trend names
  const trendIds = [...new Set((memberships || []).map(m => m.trend_id))];
  const { data: trends } = trendIds.length
    ? await supabase.from('trend_clusters').select('id, name').in('id', trendIds)
    : { data: [] };

  const trendNameById = new Map((trends || []).map(t => [t.id, t.name]));

  for (const row of signals) {
    const trendId = trendIdBySignal.get(row.id);
    const trendName = trendId ? trendNameById.get(trendId) : null;

    // Skip orphan signals -- they're candidate trends that haven't been
    // promoted to a cluster yet. They're not visible anywhere in the
    // Forward Outlook module, so showing them in the DI list would create
    // a dead-end "Read more" link. They'll appear once the pipeline
    // assigns them to a trend on a future run.
    if (!trendName) continue;

    items.push({
      id: row.id,
      title: row.signal_title,
      category: row.sector,
      impact: null,
      horizon: row.horizon_estimate,
      summary: row.summary,
      url: row.source_article_url,
      module: 'Forward Outlook',
      parentLabel: `Trend: ${trendName}`,
    });
  }
}

    // ---- Market Dynamics: return individual signals + parent insight name ----
  if (byModule[MARKET_DYNAMICS_MODULE_ID].length) {
    const articleIds = byModule[MARKET_DYNAMICS_MODULE_ID].map(x => x.articleId);

    // Get individual signal rows for the matched articles
    const { data: signalRows, error: sigErr } = await supabase
      .from('market_dynamics_signals')
      .select('id, article_id, insight_id, signal_title, summary, organization, country, source_url, published_date, category')
      .in('article_id', articleIds);
    if (sigErr) throw sigErr;

    // Get parent insight (bundle) titles, just for the parentLabel display
    const insightIds = [...new Set((signalRows || []).map(r => r.insight_id).filter(Boolean))];
    const { data: insights } = insightIds.length
      ? await supabase.from('market_insights_live').select('id, title').in('id', insightIds)
      : { data: [] };

    const insightTitleById = new Map((insights || []).map(i => [i.id, i.title]));

    // Dedupe by signal id
    const seen = new Set();
    for (const row of signalRows || []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);

      // Skip orphan signals -- not yet promoted to an insight card, so
      // they have no viewable location in the Market Dynamics module.
      if (!row.insight_id) continue;

      items.push({
        id: row.id,
        title: row.signal_title,
        category: row.category,
        impact: null,
        country: row.country,
        summary: row.summary,
        url: row.source_url,
        organization: row.organization,
        publishedDate: row.published_date,
        module: 'Market Dynamics',
        parentLabel: `Insight: ${insightTitleById.get(row.insight_id) || '—'}`,
      });
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