/**
 * scripts/ci-remove-changes.js - take WRONG changes out of the CI tab AND the chat (TEST clean-up).
 *
 *   node scripts/ci-remove-changes.js --client <uuid> --source product --hours 24
 *       -> only LISTS what would be removed (nothing is changed)
 *   node scripts/ci-remove-changes.js --client <uuid> --source product --hours 24 --yes
 *       -> removes them: status 'rejected' in Postgres (the CI tab and chat views hide it)
 *          + the point is deleted from Qdrant (so the chat cannot find it)
 *
 *   --source product|news|press|own_site|blog   which kind of change (default: product)
 *   --hours 24                                   only changes found in the last N hours
 *   --reset-pages                                also delete the stored page copies of this client,
 *                                                so the next page check starts fresh (baseline)
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { QDRANT } = require('../modules/competitiveIntelligence/constants');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const clientId = flag('--client');
const source = flag('--source') || 'product';
const hours = Number(flag('--hours') || 24);
const yes = args.includes('--yes');
const resetPages = args.includes('--reset-pages');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false });

(async () => {
  if (!/^[0-9a-f-]{36}$/i.test(clientId || '')) { console.log('Give --client <uuid>'); process.exit(1); }
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const { data: rows, error } = await supabase.from('competitor_changes')
    .select('id, organization, signal_name, signal_title, status, found_at')
    .eq('client_id', clientId).eq('source_kind', source).neq('status', 'rejected').gte('found_at', since)
    .order('found_at');
  if (error) throw new Error(error.message);

  console.log(`\n${rows.length} ${source} change(s) found in the last ${hours} hours:`);
  rows.forEach((r) => console.log(`  - ${r.organization} | ${r.signal_name} | ${r.signal_title}`));
  if (!yes) { console.log('\nNothing changed. Add --yes to remove them.'); process.exit(0); }

  if (rows.length) {
    const ids = rows.map((r) => r.id);
    await qdrant.delete(QDRANT.COLLECTION, { wait: true, points: ids });
    const { error: uErr } = await supabase.from('competitor_changes')
      .update({ status: 'rejected', status_reason: 'removed by hand (wrong change)' }).in('id', ids);
    if (uErr) throw new Error(uErr.message);
    // the page copies that point to these changes stay, but without the link
    await supabase.from('competitor_page_snapshots').update({ change_id: null }).in('change_id', ids);
    console.log(`\nRemoved ${ids.length}: hidden in the CI tab and deleted from the chat database.`);
  }
  if (resetPages) {
    const { data: del, error: dErr } = await supabase.from('competitor_page_snapshots').delete().eq('client_id', clientId).select('id');
    if (dErr) throw new Error(dErr.message);
    console.log(`Deleted ${(del || []).length} stored page copies - the next page check stores new starting points.`);
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });