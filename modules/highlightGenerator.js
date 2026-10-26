/**
 * modules/highlightGenerator.js
 * Makes ONE highlight (2-3 short paragraphs) per client + module
 * and saves it in public.daily_highlights.
 */
const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('./llmClient');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const POLICY_MODULE_ID          = '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960';
const MARKET_DYNAMICS_MODULE_ID = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const FORWARD_OUTLOOK_MODULE_ID = '2eb989fd-0ea0-4320-b73a-f7eb8b970473';

const MODULE_CONFIG = {
  [POLICY_MODULE_ID]: {
    label: 'Policy & Risk Monitor',
    table: 'policy_signals',
    columns: 'id, signal_title, category, impact_level, country, summary, created_at',
    tagField: 'category',
  },
  [MARKET_DYNAMICS_MODULE_ID]: {
    label: 'Market Dynamics',
    table: 'market_dynamics_signals',
    columns: 'id, insight_id, signal_title, category, organization, country, summary, created_at',
    tagField: 'category',
  },
  [FORWARD_OUTLOOK_MODULE_ID]: {
    label: 'Forward Outlook',
    table: 'trend_signals',
    columns: 'id, signal_title, sector, organization, horizon_estimate, summary, created_at',
    tagField: 'sector',
  },
};

const MAX_SIGNALS = 15;
const MAX_ATTEMPTS = 3;
const ATTEMPT_TEMPERATURES = [0.2, 0.4, 0.5];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Start and end (as UTC time) of the IST day that this time falls in
const getIstDayWindow = (isoTime) => {
  const shifted = new Date(new Date(isoTime).getTime() + IST_OFFSET_MS);
  const istMidnightAsUtc = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()
  );
  const start = new Date(istMidnightAsUtc - IST_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
};

const FIELD_LABELS = {
  signal_title: 'Title',
  category: 'Category',
  impact_level: 'Impact',
  country: 'Country',
  organization: 'Organization',
  sector: 'Sector',
  horizon_estimate: 'Time horizon',
  summary: 'Summary',
};

// truncate = true  -> short version that is sent to the AI
// truncate = false -> full text, used only for the number check
const describeSignal = (signal, truncate = true) =>
  Object.entries(FIELD_LABELS)
    .map(([key, label]) => {
      let value = signal[key];
      if (Array.isArray(value)) value = value.join(', ');
      if (!value) return null;
      value = String(value).replace(/\s+/g, ' ').trim();
      if (truncate && key === 'summary') value = value.slice(0, 300);
      return `${label}: ${value}`;
    })
    .filter(Boolean)
    .join('\n');

// ── Clean the AI text ──────────────────────────────────────────────────
// Removes intro lines, bold, '#' marks, and heading-like lines
// (one short sentence on its own, e.g. "Supercapacitors Gain Momentum.")
const cleanHighlightText = (raw) => {
  const text = (raw || '')
    .replace(/^(here'?s|below is|the following is)[^\n]*\n+/i, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .filter(p => !(p.length < 110 && (p.match(/[.!?]/g) || []).length <= 1))
    .slice(0, 3)
    .join('\n\n');
};

// ── Number safety check ────────────────────────────────────────────────
// Every number in the highlight must also appear in the signals.
const extractNumbers = (text) =>
  new Set((text.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(n => n.replace(/,/g, '')));

const findUnsupportedNumbers = (highlightText, sourceText) => {
  const allowed = extractNumbers(sourceText);
  return [...extractNumbers(highlightText)].filter(n => !allowed.has(n));
};

const removeUnsupportedSentences = (text, badNumbers) => {
  const bad = new Set(badNumbers);
  return text
    .split(/\n\s*\n/)
    .map(paragraph =>
      paragraph
        .split(/(?<=[.!?])\s+/)
        .filter(sentence => ![...extractNumbers(sentence)].some(n => bad.has(n)))
        .join(' ')
        .trim()
    )
    .filter(Boolean)
    .join('\n\n');
};

// Too short or too few paragraphs = broken answer
const isTooWeak = (text, signalCount) => {
  const paragraphs = text.split(/\n\s*\n/).filter(Boolean).length;
  const minParagraphs = signalCount >= 3 ? 2 : 1;
  return text.length < 200 || paragraphs < minParagraphs;
};

const loadPromptTemplate = async () => {
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', 'daily_highlight_v1')
    .eq('is_active', true)
    .single();
  if (error || !data) {
    throw new Error(`Could not load prompt daily_highlight_v1: ${error?.message}`);
  }
  return data.prompt_template;
};

// `industry` is kept so the pipeline call does not change, but it is no
// longer sent to the AI (it made the AI force links to that industry).
const generateHighlight = async (clientId, moduleId, industry = '') => {
  const config = MODULE_CONFIG[moduleId];
  if (!config) {
    console.error(`[HighlightGen] Unknown module_id: ${moduleId}`);
    return { success: false, error: 'Unknown module_id' };
  }
  const tag = `[HighlightGen] ${config.label}`;

  try {
    // 1. Find the newest signal for this client in this module
    const { data: newest, error: newestErr } = await supabase
      .from(config.table)
      .select('created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (newestErr) throw new Error(`Newest signal query failed: ${newestErr.message}`);

    if (!newest || newest.length === 0) {
      console.log(`${tag}: no signals yet, nothing to do (old highlight is kept).`);
      return { success: true, skipped: true, reason: 'no signals' };
    }

    // 2. Take the signals from that same (IST) day
    const { startIso, endIso } = getIstDayWindow(newest[0].created_at);
    const signalDate = new Date(new Date(startIso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
    const { data: signals, error: signalsErr } = await supabase
      .from(config.table)
      .select(config.columns)
      .eq('client_id', clientId)
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('created_at', { ascending: false })
      .limit(MAX_SIGNALS);
    if (signalsErr) throw new Error(`Signals query failed: ${signalsErr.message}`);

    if (!signals || signals.length === 0) {
      console.log(`${tag}: no signals found in the window, old highlight is kept.`);
      return { success: true, skipped: true, reason: 'no signals in window' };
    }
    console.log(`${tag}: using ${signals.length} signals (${startIso} to ${endIso})`);

        // Keep the exact list of signals used, so the page can show the same ones
    const signalsUsed = signals.map(s => ({
      id: s.id,
      insight_id: s.insight_id || null,
      title: s.signal_title,
      tag: s[config.tagField] || null,
    }));

    // 3. Build the prompt
    const template = await loadPromptTemplate();
    const signalBlock = signals
      .map((s, i) => `Signal ${i + 1}\n${describeSignal(s)}`)
      .join('\n\n-----\n\n');
    const finalPrompt = `${template}\n\nMODULE: ${config.label}\n\nSIGNALS:\n\n${signalBlock}`;
    const sourceText = signals.map(s => describeSignal(s, false)).join('\n');

    // 4. Write it (try again if the answer is broken)
    let highlightText = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const raw = await callLLM(
        [{ role: 'user', content: finalPrompt }],
        { temperature: ATTEMPT_TEMPERATURES[attempt - 1], max_tokens: 500, timeout: 120000 }
      );
      let candidate = cleanHighlightText(raw);

      const unsupported = findUnsupportedNumbers(candidate, sourceText);
      if (unsupported.length > 0) {
        console.log(`${tag}: numbers not in signals (${unsupported.join(', ')}) -- removing those sentences`);
        candidate = cleanHighlightText(removeUnsupportedSentences(candidate, unsupported));
      }

      if (!isTooWeak(candidate, signals.length)) {
        highlightText = candidate;
        break;
      }
      console.log(`${tag}: attempt ${attempt}/${MAX_ATTEMPTS} was too short or broken, trying again`);
    }

    if (!highlightText) {
      console.error(`${tag}: all attempts failed, old highlight is kept.`);
      return { success: false, error: 'All attempts gave a broken answer' };
    }

    // 5. Save the new one first, then remove the older ones
    const { data: inserted, error: insertErr } = await supabase
      .from('daily_highlights')
      .insert({ client_id: clientId, module_id: moduleId, highlight_text: highlightText, signal_date: signalDate, signals_used: signalsUsed })
      .select('id')
      .single();
    if (insertErr) throw new Error(`Insert failed: ${insertErr.message}`);

    const { error: cleanupErr } = await supabase
      .from('daily_highlights')
      .delete()
      .eq('client_id', clientId)
      .eq('module_id', moduleId)
      .neq('id', inserted.id);
    if (cleanupErr) console.error(`${tag}: could not remove old highlights: ${cleanupErr.message}`);

    console.log(`${tag}: highlight saved.`);
    return { success: true, id: inserted.id, signalCount: signals.length };

  } catch (err) {
    console.error(`${tag}: failed: ${err.message}`);
    return { success: false, error: err.message };
  }
};

// ───────────────────────────────────────────────────────────────────────
// Intro + conclusion for the landing page.
// Written ONLY from the module highlights above (never from raw signals).
// ───────────────────────────────────────────────────────────────────────
const MODULE_ORDER = [MARKET_DYNAMICS_MODULE_ID, POLICY_MODULE_ID, FORWARD_OUTLOOK_MODULE_ID];
const CONCLUSION_CLOSING = 'Use Ask Decision Intelligence below to explore any of these developments in more detail.';

const splitSentences = (text) =>
  text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

const cleanFrameText = (raw) =>
  (raw || '')
    .replace(/^(here'?s|below is|the following is)[^\n]*\n+/i, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^["“]+|["”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const loadPromptById = async (promptId) => {
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', promptId)
    .eq('is_active', true)
    .single();
  if (error || !data) throw new Error(`Could not load prompt ${promptId}: ${error?.message}`);
  return data.prompt_template;
};

const writeFrameText = async ({ promptId, sourceBlock, sourceText, maxSentences, tag }) => {
  const template = await loadPromptById(promptId);
  const finalPrompt = `${template}\n\nMODULE HIGHLIGHTS:\n\n${sourceBlock}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await callLLM(
      [{ role: 'user', content: finalPrompt }],
      { temperature: ATTEMPT_TEMPERATURES[attempt - 1], max_tokens: 200, timeout: 120000 }
    );
    let text = cleanFrameText(raw);

    const unsupported = findUnsupportedNumbers(text, sourceText);
    if (unsupported.length > 0) {
      console.log(`${tag}: numbers not in highlights (${unsupported.join(', ')}) -- removing those sentences`);
      text = cleanFrameText(removeUnsupportedSentences(text, unsupported));
    }

    text = splitSentences(text).slice(0, maxSentences).join(' ');
    if (text.length >= 40) return text;
    console.log(`${tag}: attempt ${attempt}/${MAX_ATTEMPTS} was too short, trying again`);
  }
  return null;
};

const saveFrameRow = async (clientId, kind, text) => {
  const { data: inserted, error } = await supabase
    .from('daily_highlights')
    .insert({ client_id: clientId, module_id: null, kind, highlight_text: text })
    .select('id')
    .single();
  if (error) throw new Error(`Insert (${kind}) failed: ${error.message}`);

  const { error: cleanupErr } = await supabase
    .from('daily_highlights')
    .delete()
    .eq('client_id', clientId)
    .eq('kind', kind)
    .neq('id', inserted.id);
  if (cleanupErr) console.error(`[HighlightGen] could not remove old ${kind}: ${cleanupErr.message}`);
};

const generateBriefingFrame = async (clientId) => {
  const tag = '[HighlightGen] Briefing frame';
  try {
    const { data: rows, error } = await supabase
      .from('daily_highlights')
      .select('module_id, highlight_text, created_at')
      .eq('client_id', clientId)
      .eq('kind', 'module')
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Load module highlights failed: ${error.message}`);

    const latest = {};
    for (const r of rows || []) {
      if (r.module_id && !latest[r.module_id]) latest[r.module_id] = r;
    }
    const available = MODULE_ORDER.filter(id => latest[id]);
    if (available.length === 0) {
      console.log(`${tag}: no module highlights yet, nothing to do.`);
      return { success: true, skipped: true };
    }

    const sourceBlock = available
      .map(id => `${MODULE_CONFIG[id].label.toUpperCase()}:\n${latest[id].highlight_text}`)
      .join('\n\n=====\n\n');
    const sourceText = available.map(id => latest[id].highlight_text).join('\n');

    const intro = await writeFrameText({
      promptId: 'daily_highlight_intro_v1', sourceBlock, sourceText, maxSentences: 3, tag,
    });
    if (intro) await saveFrameRow(clientId, 'intro', intro);
    else console.error(`${tag}: intro failed, old intro is kept.`);

    const recap = await writeFrameText({
      promptId: 'daily_highlight_conclusion_v1', sourceBlock, sourceText, maxSentences: 1, tag,
    });
    if (recap) await saveFrameRow(clientId, 'conclusion', `${recap} ${CONCLUSION_CLOSING}`);
    else console.error(`${tag}: conclusion failed, old conclusion is kept.`);

    console.log(`${tag}: done (intro: ${!!intro}, conclusion: ${!!recap}).`);
    return { success: true, intro: !!intro, conclusion: !!recap };

  } catch (err) {
    console.error(`${tag}: failed: ${err.message}`);
    return { success: false, error: err.message };
  }
};

module.exports = { generateHighlight, generateBriefingFrame };
