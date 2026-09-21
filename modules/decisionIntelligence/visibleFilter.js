const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MARKET_DYNAMICS_MODULE_ID = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const FORWARD_OUTLOOK_MODULE_ID = '2eb989fd-0ea0-4320-b73a-f7eb8b970473';

/**
 * Keeps only Qdrant hits that the module tabs actually show.
 *  - Policy & Risk: all kept (tab shows every policy signal)
 *  - Forward Outlook: only signals whose trend is in trend_snapshots_latest (active)
 *  - Market Dynamics: only signals whose insight is in market_insights_live
 */
async function keepVisibleResults(results, clientId) {
  if (!results || !results.length) return results;

  const idsFor = (mod) => [...new Set(
    results
      .filter(r => r.payload?.module_id === mod && r.payload?.article_id)
      .map(r => r.payload.article_id)
  )];

  const visible = new Set();

  // Forward Outlook
  const fIds = idsFor(FORWARD_OUTLOOK_MODULE_ID);
  if (fIds.length) {
    const { data: sigs } = await supabase.from('trend_signals').select('id, article_id').in('article_id', fIds);
    const sigIds = (sigs || []).map(s => s.id);
    const { data: mem } = sigIds.length
      ? await supabase.from('trend_membership').select('signal_id, trend_id').in('signal_id', sigIds)
      : { data: [] };
    const trendIds = [...new Set((mem || []).map(m => m.trend_id))];
    const { data: shown } = trendIds.length
      ? await supabase.from('trend_snapshots_latest').select('trend_id').eq('client_id', clientId).in('trend_id', trendIds)
      : { data: [] };
    const shownTrends = new Set((shown || []).map(t => t.trend_id));
    const trendBySig = new Map((mem || []).map(m => [m.signal_id, m.trend_id]));
    (sigs || []).forEach(s => {
      const t = trendBySig.get(s.id);
      if (t && shownTrends.has(t)) visible.add(s.article_id);
    });
  }

  // Market Dynamics
  const mIds = idsFor(MARKET_DYNAMICS_MODULE_ID);
  if (mIds.length) {
    const { data: rows } = await supabase
      .from('market_dynamics_signals').select('article_id, insight_id').in('article_id', mIds);
    const insightIds = [...new Set((rows || []).map(r => r.insight_id).filter(Boolean))];
    const { data: live } = insightIds.length
      ? await supabase.from('market_insights_live').select('id').eq('client_id', clientId).in('id', insightIds)
      : { data: [] };
    const shownIns = new Set((live || []).map(i => i.id));
    (rows || []).forEach(r => {
      if (r.insight_id && shownIns.has(r.insight_id)) visible.add(r.article_id);
    });
  }

  return results.filter(r => {
    const p = r.payload || {};
    if (p.module_id === FORWARD_OUTLOOK_MODULE_ID || p.module_id === MARKET_DYNAMICS_MODULE_ID) {
      return Boolean(p.article_id) && visible.has(p.article_id);
    }
    return true;
  });
}

module.exports = { keepVisibleResults };