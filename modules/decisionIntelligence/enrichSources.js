const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function enrichSourcesWithSignalIds(sources) {
  const client = (sources || []).filter(s => s.type === 'client' && s.article_id);
  if (!client.length) return sources;

  const idsFor = (mod) => [...new Set(client.filter(s => s.module === mod).map(s => s.article_id))];
  const map = new Map();

  const pIds = idsFor('Policy & Risk');
  if (pIds.length) {
    const { data } = await supabase.from('policy_signals').select('id, article_id').in('article_id', pIds);
    (data || []).forEach(r => map.set(r.article_id, { signal_id: r.id, parent_id: null }));
  }

  const fIds = idsFor('Forward Outlook');
  if (fIds.length) {
    const { data: sigs } = await supabase.from('trend_signals').select('id, article_id').in('article_id', fIds);
    const sigIds = (sigs || []).map(s => s.id);
    const { data: mem } = sigIds.length
      ? await supabase.from('trend_membership').select('signal_id, trend_id').in('signal_id', sigIds)
      : { data: [] };
    const trendIds = [...new Set((mem || []).map(m => m.trend_id))];
    const { data: trends } = trendIds.length
      ? await supabase.from('trend_clusters').select('id').in('id', trendIds).eq('status', 'active')
      : { data: [] };
    const active = new Set((trends || []).map(t => t.id));
    const trendBySig = new Map((mem || []).map(m => [m.signal_id, m.trend_id]));
    (sigs || []).forEach(s => {
      const t = trendBySig.get(s.id);
      if (t && active.has(t)) map.set(s.article_id, { signal_id: s.id, parent_id: t });
    });
  }

  const mIds = idsFor('Market Dynamics');
  if (mIds.length) {
    const { data } = await supabase
      .from('market_dynamics_signals').select('id, article_id, insight_id').in('article_id', mIds);
    (data || []).forEach(r => {
      if (r.insight_id) map.set(r.article_id, { signal_id: r.id, parent_id: r.insight_id });
    });
  }

  return sources.map(s =>
    s.type === 'client' && map.has(s.article_id) ? { ...s, ...map.get(s.article_id) } : s
  );
}

module.exports = { enrichSourcesWithSignalIds };