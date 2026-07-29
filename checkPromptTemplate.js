// checkPromptTemplate.js
//
// Fetches and prints the current trend naming+writeup prompt template
// stored in Supabase, so it can be reviewed/rewritten.
//
// Usage: node checkPromptTemplate.js

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const main = async () => {
  const { data, error } = await supabase
    .from('prompts')
    .select('id, prompt_template, is_active, updated_at')
    .eq('id', 'trend_naming_writeup_v1')
    .single();

  if (error || !data) {
    console.error('Could not fetch prompt:', error?.message);
    process.exit(1);
  }

  console.log(`\n=== Prompt: ${data.id} (active: ${data.is_active}) ===\n`);
  console.log(data.prompt_template);
  console.log('\n=== End ===\n');

  process.exit(0);
};

main();