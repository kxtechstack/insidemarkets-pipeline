/**
 * modules/decisionIntelligenceV2/sec/buildNumericAnswer.js
 *
 * COPIED VERBATIM from modules/decisionIntelligence/buildNumericAnswer.js.
 * No logic changed.
 *
 * Builds the numeric answer directly from financial_facts rows — no LLM.
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

function buildNumericAnswer(facts) {
  if (!facts || !facts.length) {
    return "Verified financial data for this question wasn't found.";
  }

  const tickers = [...new Set(facts.map(f => f.ticker))];
  const lines = [];

  for (const ticker of tickers) {
    const tickerFacts = facts
      .filter(f => f.ticker === ticker)
      .sort((a, b) => a.fiscal_year - b.fiscal_year || a.metric_name.localeCompare(b.metric_name));

    if (tickers.length > 1) {
      const displayName = tickerFacts[0]?.company_name || ticker;
      lines.push(`\n### ${displayName} (${ticker})\n`);
    }

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