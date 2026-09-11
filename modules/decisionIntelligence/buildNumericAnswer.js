/**
 * modules/decisionIntelligence/buildNumericAnswer.js
 *
 * Node port of query_rag.py's build_numeric_answer() and _format_usd().
 *
 * Builds the numeric answer DIRECTLY from verified financial_facts rows --
 * no LLM involved. This is what prevents digit-transcription errors
 * (e.g. $383.29B written as $38B) and fabricated numbers: the model never
 * sees the raw digits, because there IS no model call for this path.
 */

/**
 * 383285000000 -> '$383.29B'. Postgres numeric columns can come back as
 * strings in JS (pg/Supabase don't always parse numeric to JS number),
 * so this always coerces to Number first.
 */
function formatUsd(value) {
  if (value === null || value === undefined) return 'N/A';
  const num = Number(value);
  const abs = Math.abs(num);
  if (abs >= 1e9) return `$${(num / 1e9).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}B`;
  if (abs >= 1e6) return `$${(num / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
  if (abs >= 1e3) return `$${(num / 1e3).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}K`;
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * @param {Array<object>} facts - rows from financial_facts (ticker, fiscal_year, metric_name, metric_value, unit)
 * @returns {string} formatted answer text, e.g.:
 *   "- Revenue (FY2023): $383.29B (verified financial data)"
 * or, with multiple tickers:
 *   "**AAPL**\n- Revenue (FY2023): $383.29B (verified financial data)\n**MSFT**\n- ..."
 */
function buildNumericAnswer(facts) {
  if (!facts || !facts.length) {
    return "Verified financial data for this question wasn't found.";
  }

  const tickers = [...new Set(facts.map(f => f.ticker))].sort();
  const lines = [];

  for (const ticker of tickers) {
    const tickerFacts = facts
      .filter(f => f.ticker === ticker)
      .sort((a, b) => a.fiscal_year - b.fiscal_year || a.metric_name.localeCompare(b.metric_name));

    if (tickers.length > 1) lines.push(`\n### ${ticker}\n`);

    for (const f of tickerFacts) {
      const valueStr = (f.unit || 'USD') === 'USD'
        ? formatUsd(f.metric_value)
        : `${f.metric_value} ${f.unit || ''}`;
      lines.push(`- ${f.metric_name} (FY${f.fiscal_year}): ${valueStr} (verified financial data)`);
    }
  }

  return lines.join('\n');
}

module.exports = { buildNumericAnswer, formatUsd };