require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const DYNAMIC_BLOCK = `=================================================
DYNAMIC FORMAT OVERRIDE — READ THIS FIRST
=================================================

If the user message contains a "HEADINGS TO USE" block, this DYNAMIC FORMAT
OVERRIDES the JSON schema specified below. IGNORE the required fields
listed below (outlook, analysis, key_facts, driving_factors, what_to_watch,
decision_implication, confidence_evidence) and instead return this shape:

{
  "title": "<short descriptive title>",
  "sections": [
    { "heading": "<exact heading from HEADINGS TO USE>", "points": ["<bullet>", "<bullet>", ...] },
    ...
  ],
  "bottom_line": "<2-3 sentence conclusion>"
}

Rules when using the dynamic shape:
- Use EXACTLY the headings provided in the "HEADINGS TO USE" block, in EXACTLY that order.
- Do NOT add, rename, remove, or reorder any section.
- Each section's "points" array must have 3-5 substantive bullets drawn from the context.
- If a section cannot be supported by the context, still include it with a single point: "No relevant data in the current dataset."
- Do NOT include citation markers like [1], [2] in the bullet text.
- The CITED_SOURCES line at the very top is still required.

If the user message does NOT contain a "HEADINGS TO USE" block, use the
legacy fixed schema specified below.

=================================================
LEGACY FORMAT — USE ONLY WHEN NO HEADINGS ARE PROVIDED
=================================================

`;

const PROMPT_IDS = [
  'decision_intelligence_inference_v2',
  'decision_intelligence_qualitative_v2',
];

(async () => {
  for (const id of PROMPT_IDS) {
    const { data, error } = await s.from('prompts').select('prompt_template').eq('id', id).single();
    if (error || !data) { console.error(`SKIP ${id}: ${error?.message || 'no data'}`); continue; }

    if (data.prompt_template.startsWith('=================================================\nDYNAMIC FORMAT OVERRIDE')) {
      console.log(`SKIP ${id}: already has dynamic block`);
      continue;
    }

    const updated = DYNAMIC_BLOCK + data.prompt_template;
    const { error: updErr } = await s.from('prompts').update({ prompt_template: updated }).eq('id', id);
    if (updErr) console.error(`FAIL ${id}: ${updErr.message}`);
    else console.log(`OK ${id} — prepended, new length=${updated.length}`);
  }
})();