const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function enrichSourcesWithSignalIds(sources, clientId) {
  const client = (sources || []).filter(s => s.type === 'client' && s.article_id);
  if (!client.length) return sources;

  const idsFor = (mod) => [...new Set(client.filter(s => s.module === mod).map(s => s.article_id))];
  const map = new Map();

  // Policy & Risk
  const pIds = idsFor('Policy & Risk');
  if (pIds.length) {
    const { data } = await supabase.from('policy_signals').select('id, article_id').in('article_id', pIds);
    (data || []).forEach(r => map.set(r.article_id, { signal_id: r.id }));
  }

  // Forward Outlook: trend must be one the tab actually shows (trend_snapshots_latest)
  const fIds = idsFor('Forward Outlook');
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
    const visible = new Set((shown || []).map(t => t.trend_id));
    const trendBySig = new Map((mem || []).map(m => [m.signal_id, m.trend_id]));
    (sigs || []).forEach(s => {
      const t = trendBySig.get(s.id);
      if (t && visible.has(t)) map.set(s.article_id, { signal_id: s.id });
    });
  }

  // Market Dynamics: insight must be one the tab actually shows (market_insights_live)
  const mIds = idsFor('Market Dynamics');
  if (mIds.length) {
    const { data } = await supabase
      .from('market_dynamics_signals').select('id, article_id, insight_id').in('article_id', mIds);
    const insightIds = [...new Set((data || []).map(r => r.insight_id).filter(Boolean))];
    const { data: live } = insightIds.length
      ? await supabase.from('market_insights_live').select('id').eq('client_id', clientId).in('id', insightIds)
      : { data: [] };
    const shownIns = new Set((live || []).map(i => i.id));
    (data || []).forEach(r => {
      if (r.insight_id && shownIns.has(r.insight_id)) map.set(r.article_id, { signal_id: r.id });
    });
  }

  console.log('[enrich]', sources.filter(s => s.type === 'client')
    .map(s => `${s.module} | ${(s.title || '').slice(0, 40)} -> ${map.get(s.article_id)?.signal_id || 'NONE'}`));

  return sources.map(s =>
    s.type === 'client' && map.has(s.article_id) ? { ...s, ...map.get(s.article_id) } : s
  );
}

module.exports = { enrichSourcesWithSignalIds };