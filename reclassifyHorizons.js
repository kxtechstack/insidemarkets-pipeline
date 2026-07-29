// reclassifyHorizons.js
//
// Bulk-corrects horizon_estimate on EXISTING policy_signals rows, using the
// same signal_type-anchored heuristic just added to
// forward_outlook_relevance_v1 (Patent -> long_term, R&D -> long_term,
// Innovation -> near_term, Capital Investment -> mid_term). This is a
// deterministic remap based on signal_type rather than a fresh LLM call --
// signal_type is already reliably stored, and the original LLM classification
// wasn't reliably using explicit timeline info anyway (that's the bug we're
// fixing), so a code-level default per signal_type is just as accurate and
// far cheaper/faster than re-calling the model per signal.
//
// After running this, re-run runWeeklyScoring (or trigger a new /run) for
// the affected client/module/industry so trend rings + snapshots pick up
// the corrected horizon values -- this script only fixes policy_signals,
// it does NOT recompute rings or refresh snapshots itself.
//
// Usage: node reclassifyHorizons.js <moduleId> <clientId>

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Same defaults as the forward_outlook_relevance_v1 prompt fix.
const SIGNAL_TYPE_TO_HORIZON = {
  'Patent': 'long_term',
  'R&D': 'long_term',
  'Innovation': 'near_term',
  'Capital Investment': 'mid_term',
};

const main = async () => {
  const [moduleId, clientId] = process.argv.slice(2);
  if (!moduleId || !clientId) {
    console.error('Usage: node reclassifyHorizons.js <moduleId> <clientId>');
    process.exit(1);
  }

  const { data: signals, error } = await supabase
    .from('policy_signals')
    .select('id, signal_type, horizon_estimate, signal_title')
    .eq('module_id', moduleId)
    .eq('client_id', clientId);

  if (error) {
    console.error('Failed to fetch signals:', error.message);
    process.exit(1);
  }

  if (!signals || signals.length === 0) {
    console.log('No signals found for this module/client.');
    process.exit(0);
  }

  console.log(`\nFound ${signals.length} signal(s). Checking for horizon_estimate corrections...\n`);

  let updated = 0;
  let unchanged = 0;
  let skippedNoMapping = 0;

  for (const signal of signals) {
    const correctHorizon = SIGNAL_TYPE_TO_HORIZON[signal.signal_type];

    if (!correctHorizon) {
      console.log(`  [skip] "${signal.signal_title}" — unrecognized signal_type "${signal.signal_type}", leaving as-is`);
      skippedNoMapping++;
      continue;
    }

    if (signal.horizon_estimate === correctHorizon) {
      unchanged++;
      continue;
    }

    const { error: updateError } = await supabase
      .from('policy_signals')
      .update({ horizon_estimate: correctHorizon })
      .eq('id', signal.id);

    if (updateError) {
      console.error(`  [error] Failed to update "${signal.signal_title}":`, updateError.message);
      continue;
    }

    console.log(`  [updated] "${signal.signal_title}" — ${signal.signal_type}: ${signal.horizon_estimate || '(none)'} -> ${correctHorizon}`);
    updated++;
  }

  console.log(`\n=== Done ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Already correct: ${unchanged}`);
  console.log(`Skipped (unrecognized signal_type): ${skippedNoMapping}`);
  console.log(`\nNext step: re-run runWeeklyScoring (or trigger a new /run) for this`);
  console.log(`client/module/industry so trend rings + snapshots pick up these changes.\n`);

  process.exit(0);
};

main();