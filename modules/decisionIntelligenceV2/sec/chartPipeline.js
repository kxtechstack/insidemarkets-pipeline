/**
 * modules/decisionIntelligenceV2/sec/chartPipeline.js
 *
 * COPIED from modules/decisionIntelligence/chartPipeline.js.
 * Changes: pure black chart text, darker gridlines, and true transparency
 * (render on white + black, derive real alpha) so no halo around text.
 */

const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const sharp = require('sharp');

// =============================================================================
// SECTION 1: formatChartData.js
// =============================================================================

function decideChartFormat(intent, facts) {
  const FRAMEWORK_OR_QUALITATIVE = new Set(['swot', 'pestle', 'risk_analysis', 'five_forces', 'qualitative']);
  if (FRAMEWORK_OR_QUALITATIVE.has(intent.questionCategory) || !facts.length) {
    return { format: 'text' };
  }

  if (!intent.isChartable) {
    return { format: 'text' };
  }

  if (intent.questionCategory === 'relationship') {
    return buildRelationshipChart(intent, facts);
  }

  if (intent.questionCategory === 'distribution') {
    return buildDistributionChart(intent, facts);
  }

  let chartType;
  if (intent.questionCategory === 'trend') {
    chartType = intent.isCumulativeQuestion ? 'area' : 'line';
  } else if (intent.questionCategory === 'comparison') {
    chartType = intent.isCompositionQuestion ? 'pie' : 'bar';
  } else if (intent.questionCategory === 'comparison_trend') {
    chartType = 'line';
  } else {
    chartType = 'bar';
  }

  const tickers = [...new Set(facts.map(f => f.ticker))].sort();
  const years = [...new Set(facts.map(f => f.fiscal_year))].sort((a, b) => a - b);
  const metricLabel = facts[0]?.metric_name || 'Value';

  const series = tickers.map(ticker => ({
    name: ticker,
    labels: years,
    data: years.map(year => {
      const match = facts.find(f => f.ticker === ticker && f.fiscal_year === year);
      return match && match.metric_value !== null ? Number(match.metric_value) : null;
    }),
  }));

  return {
    format: 'chart',
    chartType,
    chartData: {
      type: chartType,
      xAxis: (intent.questionCategory === 'trend' || intent.questionCategory === 'comparison_trend') ? 'year' : 'company',
      metricLabel,
      series,
    },
  };
}

function buildRelationshipChart(intent, facts) {
  const [m1, m2] = intent.metricsFound;
  const pairs = [...new Set(facts.map(f => `${f.ticker}|${f.fiscal_year}`))];

  const points = [];
  for (const pair of pairs) {
    const [ticker, yearStr] = pair.split('|');
    const year = Number(yearStr);
    const v1 = facts.find(f => f.ticker === ticker && f.fiscal_year === year && f.metric_name === m1);
    const v2 = facts.find(f => f.ticker === ticker && f.fiscal_year === year && f.metric_name === m2);
    if (v1 && v2 && v1.metric_value !== null && v2.metric_value !== null) {
      points.push({ label: `${ticker} FY${year}`, x: Number(v1.metric_value), y: Number(v2.metric_value) });
    }
  }

  if (points.length < 2) return { format: 'text' };

  return {
    format: 'chart',
    chartType: 'scatter',
    chartData: { type: 'scatter', xLabel: m1, yLabel: m2, points },
  };
}

function buildDistributionChart(intent, facts) {
  const metricLabel = facts[0]?.metric_name || 'Value';
  const tickers = [...new Set(facts.map(f => f.ticker))].sort();

  const values = [];
  const labels = [];
  for (const ticker of tickers) {
    const vals = facts.filter(f => f.ticker === ticker && f.metric_value !== null).map(f => Number(f.metric_value));
    if (vals.length) {
      values.push(vals.reduce((a, b) => a + b, 0) / vals.length);
      labels.push(ticker);
    }
  }

  if (values.length < 5) return { format: 'text' };

  return {
    format: 'chart',
    chartType: 'bar',
    chartData: { type: 'bar', xAxis: 'company', metricLabel, series: [{ name: metricLabel, labels, data: values }] },
  };
}

// =============================================================================
// SECTION 2: renderChart.js
// =============================================================================

const WIDTH = 700;
const HEIGHT = 450;
const PALETTE = ['#0088CC', '#E63946', '#F4A300', '#2A9D8F', '#7B2CBF', '#F77F00', '#06A77D'];

// Pure black text everywhere, darker gridlines so they stay visible
const TEXT = '#000000';
const GRID = 'rgba(0,0,0,0.15)';

const makeCanvas = (bg) => new ChartJSNodeCanvas({
  width: WIDTH,
  height: HEIGHT,
  backgroundColour: bg,
  chartCallback: (ChartJS) => {
    ChartJS.defaults.color = TEXT;
    ChartJS.defaults.borderColor = GRID;
    ChartJS.defaults.font.weight = '500';
  },
});

// Same chart is rendered on white AND black, then true alpha is derived
// from the difference. This gives clean transparent edges (no halo).
const canvasOnWhite = makeCanvas('white');
const canvasOnBlack = makeCanvas('black');

function formatUsd(value) {
  if (value === null || value === undefined) return 'N/A';
  const num = Number(value);
  const abs = Math.abs(num);
  if (abs >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

function buildChartConfig(chartData) {
  const { type, metricLabel = 'Value' } = chartData;

  if (type === 'scatter') {
    return {
      type: 'scatter',
      data: {
        datasets: [{
          label: `${chartData.xLabel} vs ${chartData.yLabel}`,
          data: chartData.points.map(p => ({ x: p.x, y: p.y })),
          backgroundColor: PALETTE[0],
          pointRadius: 6,
        }],
      },
      options: {
        plugins: {
          title: { display: true, text: `${chartData.xLabel} vs ${chartData.yLabel}`, font: { size: 16 }, color: TEXT },
          legend: { display: false, labels: { color: TEXT } },
        },
        scales: {
          x: { title: { display: true, text: chartData.xLabel, color: TEXT }, ticks: { callback: v => formatUsd(v), color: TEXT }, grid: { color: GRID } },
          y: { title: { display: true, text: chartData.yLabel, color: TEXT }, ticks: { callback: v => formatUsd(v), color: TEXT }, grid: { color: GRID } },
        },
      },
    };
  }

  const series = chartData.series || [];
  const singleYearComparison = chartData.xAxis === 'company' && series.every(s => s.labels.length === 1);

  if (singleYearComparison) {
    const labels = series.map(s => s.name);
    const values = series.map(s => s.data[0]);

    if (type === 'pie') {
      const hasNegative = values.some(v => v !== null && v < 0);
      if (!hasNegative) {
        return {
          type: 'pie',
          data: {
            labels: labels.map((l, i) => `${l} (${formatUsd(values[i])})`),
            datasets: [{ data: values, backgroundColor: PALETTE }],
          },
          options: {
            plugins: {
              title: { display: true, text: `${metricLabel} Composition`, font: { size: 16 }, color: TEXT },
              legend: { labels: { color: TEXT } },
            },
          },
        };
      }
    }

    return {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: metricLabel, data: values, backgroundColor: PALETTE }],
      },
      options: {
        plugins: {
          title: { display: true, text: `${metricLabel} Comparison`, font: { size: 16 }, color: TEXT },
          legend: { display: false, labels: { color: TEXT } },
        },
        scales: {
          x: { ticks: { color: TEXT }, grid: { color: GRID } },
          y: { ticks: { callback: v => formatUsd(v), color: TEXT }, grid: { color: GRID } },
        },
      },
    };
  }

  if (type === 'bar' && series.length === 1 && chartData.xAxis === 'company') {
    return {
      type: 'bar',
      data: {
        labels: series[0].labels,
        datasets: [{ label: metricLabel, data: series[0].data, backgroundColor: PALETTE[0] }],
      },
      options: {
        plugins: {
          title: { display: true, text: `${metricLabel} by Company`, font: { size: 16 }, color: TEXT },
          legend: { display: false, labels: { color: TEXT } },
        },
        scales: {
          x: { ticks: { color: TEXT }, grid: { color: GRID } },
          y: { ticks: { callback: v => formatUsd(v), color: TEXT }, grid: { color: GRID } },
        },
      },
    };
  }

  const years = series[0]?.labels || [];
  const datasets = series.map((s, i) => ({
    label: s.name,
    data: s.data,
    borderColor: PALETTE[i % PALETTE.length],
    backgroundColor: type === 'area' ? `${PALETTE[i % PALETTE.length]}66` : PALETTE[i % PALETTE.length],
    fill: type === 'area',
    tension: 0,
  }));

  return {
    type: type === 'area' ? 'line' : type,
    data: { labels: years, datasets },
    options: {
      plugins: {
        title: { display: true, text: metricLabel, font: { size: 16 }, color: TEXT },
        legend: { display: series.length > 1, labels: { color: TEXT } },
      },
      scales: {
        x: { ticks: { color: TEXT }, grid: { color: GRID } },
        y: { ticks: { callback: v => formatUsd(v), color: TEXT }, grid: { color: GRID } },
      },
    },
  };
}

async function renderChart(chartData) {
  // Render the same chart on white and on black, then derive true alpha
  const [whiteBuf, blackBuf] = await Promise.all([
    canvasOnWhite.renderToBuffer(buildChartConfig(chartData), 'image/png'),
    canvasOnBlack.renderToBuffer(buildChartConfig(chartData), 'image/png'),
  ]);

  const w = await sharp(whiteBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(blackBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const { width, height, channels } = w.info; // 3 (alpha removed)
  const out = Buffer.alloc(width * height * 4);

  for (let i = 0, o = 0; i < w.data.length; i += channels, o += 4) {
    const diff =
      (w.data[i] - b.data[i]) +
      (w.data[i + 1] - b.data[i + 1]) +
      (w.data[i + 2] - b.data[i + 2]);

    // white render - black render = 255 * (1 - alpha)
    const alpha = Math.max(0, Math.min(255, 255 - diff / 3));

    if (alpha < 1) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    } else {
      // un-premultiply the black render to recover the true color
      out[o]     = Math.min(255, Math.round((b.data[i]     * 255) / alpha));
      out[o + 1] = Math.min(255, Math.round((b.data[i + 1] * 255) / alpha));
      out[o + 2] = Math.min(255, Math.round((b.data[i + 2] * 255) / alpha));
      out[o + 3] = Math.round(alpha);
    }
  }

  const finalBuffer = await sharp(out, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();

  return finalBuffer.toString('base64');
}

module.exports = {
  decideChartFormat,
  renderChart, buildChartConfig, formatUsd,
};