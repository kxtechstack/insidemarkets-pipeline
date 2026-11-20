/**
 * modules/promptStore.js
 *
 * ONE place to read AI prompts from the database (public.prompts). No prompt text lives in the code:
 * edit a prompt in the prompts table and the pipeline uses the new text within 5 minutes.
 *
 *   const { getPrompt, fillPrompt } = require('./promptStore');
 *   const text = await getPrompt('same_event_check_v1');          // null when missing or switched off
 *   const prompt = fillPrompt(text, { title_a: 'x', title_b: 'y' });  // fills {name} and {{name}}
 *
 * A missing or switched-off prompt is never replaced by a hidden copy in the code: getPrompt returns
 * null, logs ONE clear line (per prompt, every 5 minutes), and the caller takes its safe path
 * (for example: keep the article, start a new card). requirePrompt throws instead.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();   // id -> { text, at }

async function getPrompt(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.text;
  let text = null;
  const read = async () => {
    const { data, error } = await supabase.from('prompts').select('prompt_template').eq('id', id).eq('is_active', true).maybeSingle();
    if (error) throw new Error(error.message);
    return data && data.prompt_template ? data.prompt_template : null;
  };
  try {
    try {
      text = await read();
    } catch (first) {
      // a short database hiccup ("fetch failed"): one more try after a moment
      await new Promise((r) => setTimeout(r, 1500));
      text = await read();
    }
  } catch (e) {
    console.error(`[Prompts] could not read prompt '${id}': ${e.message}`);
    return hit ? hit.text : null;   // database hiccup: keep using the last good text
  }
  if (!text) console.error(`[Prompts] prompt '${id}' is missing or switched off in the prompts table - this AI step is skipped`);
  cache.set(id, { text, at: Date.now() });
  return text;
}

async function requirePrompt(id) {
  const text = await getPrompt(id);
  if (!text) throw new Error(`prompt '${id}' is missing or switched off in the prompts table`);
  return text;
}

/** Fills {name} and {{name}} placeholders. Unknown placeholders are left as they are. */
function fillPrompt(text, vars = {}) {
  return String(text || '')
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m))
    .replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

module.exports = { getPrompt, requirePrompt, fillPrompt };
