// checkCandidateProgress.js
//
// Lists all 'candidate' trends for a module/client, showing signal count
// and days since first signal -- sorted so the ones closest to promotion
// eligibility (MIN_SIGNALS_FOR_PROMOTION=3, MIN_DAYS_FOR_PROMOTION=7) show
// first. Also pulls a couple of the actual signal titles per candidate so
// you can see what topic each one is about, to help you write a targeted
// prompt that pushes the closest ones over the line.
//
// Usage: node checkCandidateProgress.js <moduleId> <clientId>

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MIN_SIGNALS_FOR_PROMOTION = 3;
const MIN_DAYS_FOR_PROMOTION = 7;

const main = async () => {
  const [moduleId, clientId] = process.argv.slice(2);
  if (!moduleId || !clientId) {
    console.error('Usage: node checkCandidateProgress.js <moduleId> <clientId>');
    process.exit(1);
  }

  const { data: candidates, error } = await supabase
    .from('trend_clusters')
    .select('id, industry')
    .eq('module_id', moduleId)
    .eq('client_id', clientId)
    .eq('status', 'candidate');

  if (error) {
    console.error('Failed to fetch candidates:', error.message);
    process.exit(1);
  }

  if (!candidates || candidates.length === 0) {
    console.log('No candidate trends found.');
    process.exit(0);
  }

  const rows = [];

  for (const c of candidates) {
    const { data: members } = await supabase
      .from('trend_membership')
      .select('signal_id, joined_at')
      .eq('trend_id', c.id)
      .order('joined_at', { ascending: true });

    if (!members || members.length === 0) continue;

    const signalCount = members.length;
    const firstJoined = new Date(members[0].joined_at);
    const daysSinceFirst = (Date.now() - firstJoined.getTime()) / (1000 * 60 * 60 * 24);

    const signalsNeeded = Math.max(0, MIN_SIGNALS_FOR_PROMOTION - signalCount);
    const daysNeeded = Math.max(0, MIN_DAYS_FOR_PROMOTION - daysSinceFirst);
    const readyOnDays = signalsNeeded === 0 && daysNeeded === 0;

    // Pull titles so you can see what this candidate is actually about
    const signalIds = members.map(m => m.signal_id);
    const { data: signals } = await supabase
      .from('policy_signals')
      .select('signal_title, organization')
      .in('id', signalIds);

    rows.push({
      trendId: c.id,
      industry: c.industry,
      signalCount,
      signalsNeeded,
      daysSinceFirst: Math.round(daysSinceFirst * 10) / 10,
      daysNeeded: Math.round(daysNeeded * 10) / 10,
      readyOnDays,
      titles: (signals || []).map(s => `${s.organization ? s.organization + ': ' : ''}${s.signal_title}`),
    });
  }

  // Sort: fewest signals needed first, then fewest days needed
  rows.sort((a, b) => {
    if (a.signalsNeeded !== b.signalsNeeded) return a.signalsNeeded - b.signalsNeeded;
    return a.daysNeeded - b.daysNeeded;
  });

  console.log(`\n=== ${rows.length} candidate trend(s), closest to eligibility first ===\n`);

  rows.forEach((r, i) => {
    const statusFlag = r.signalsNeeded === 0
      ? (r.readyOnDays ? '✅ ELIGIBLE NOW (should promote on next check)' : `⏳ needs ${r.daysNeeded} more day(s)`)
      : `needs ${r.signalsNeeded} more signal(s)${r.daysNeeded > 0 ? ` + ${r.daysNeeded} more day(s)` : ''}`;

    console.log(`${i + 1}. ${r.trendId}  [${r.industry}]`);
    console.log(`   Signals: ${r.signalCount}/3  |  Days since first: ${r.daysSinceFirst}  |  ${statusFlag}`);
    r.titles.forEach(t => console.log(`     - ${t}`));
    console.log('');
  });

  process.exit(0);
};

main();