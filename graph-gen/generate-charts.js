#!/usr/bin/env node
/**
 * Nexus Testnet Chart Generator
 * Generates 11 SVG charts from daily digest data for weekly trend reports.
 *
 * Usage:
 *   node generate-charts.js --week=2026-11 --data-dir=../../memory/testnet-digests
 *   node generate-charts.js --week=2026-11 --data-dir=../../memory/testnet-digests --mock
 *
 * Outputs SVG files to graphs/week-{WEEK}/
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Parse CLI args
const args = {};
process.argv.slice(2).forEach(arg => {
  const [key, val] = arg.replace(/^--/, '').split('=');
  args[key] = val || true;
});

const WEEK = args.week || (() => {
  const now = new Date();
  const year = now.getFullYear();
  const weekNum = getISOWeek(now);
  return `${year}-${String(weekNum).padStart(2, '0')}`;
})();

const DATA_DIR = args['data-dir'] || path.join(__dirname, '../../../memory/testnet-digests');
const REGISTRY_FILE = args.registry || path.join(__dirname, '../../../memory/contract-registry.json');
const JOURNEYS_FILE = args.journeys || path.join(__dirname, '../../../memory/developer-journeys.json');
const OUTPUT_DIR = args['output-dir'] || path.join(__dirname, `../../../graphs/week-${WEEK}`);
const MOCK_MODE = !!args.mock;

// Color palette
const COLORS = {
  primary: '#6366F1',      // indigo — organic/positive
  secondary: '#94A3B8',    // slate — raw/neutral
  alert: '#EF4444',        // red — negative
  success: '#22C55E',      // green
  warning: '#F59E0B',      // amber
  gridlines: '#E2E8F0',    // light gray
  background: '#FFFFFF',
  text: '#1E293B',
  textLight: '#64748B',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function loadDigests(dataDir, days = 30) {
  if (!fs.existsSync(dataDir)) {
    console.warn(`WARNING: data-dir not found: ${dataDir}`);
    return [];
  }
  const files = fs.readdirSync(dataDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-days);
  return files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
    } catch (e) {
      console.warn(`WARNING: Could not parse ${f}: ${e.message}`);
      return null;
    }
  }).filter(Boolean);
}

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(`WARNING: Could not load ${filePath}: ${e.message}`);
    return fallback;
  }
}

function getNestedValue(obj, path, defaultVal = 0) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : defaultVal), obj);
}

function generateMockDigests(count = 30) {
  const digests = [];
  const baseDate = new Date('2026-02-12');
  for (let i = 0; i < count; i++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + i);
    const organic = Math.floor(50 + Math.random() * 200 + i * 3);
    const raw = Math.floor(organic * (1.2 + Math.random() * 0.5));
    digests.push({
      date: date.toISOString().split('T')[0],
      chain_health: {
        avg_block_time: 1.5 + Math.random() * 0.8,
        current_block: 1000000 + i * 43200,
      },
      engagement: {
        organic_dau: organic,
        raw_dau: raw,
        organic_ratio: organic / raw,
        total_transactions: Math.floor(organic * (8 + Math.random() * 4)),
        bot_flagged: raw - organic,
      },
      contracts: {
        deployed_24h: Math.floor(Math.random() * 8),
        verified_24h: Math.floor(Math.random() * 5),
        verification_rate: 0.3 + Math.random() * 0.4,
      },
      developer_funnel: {
        stage_3_deploy: Math.floor(20 + i * 0.8),
        stage_4_verified: Math.floor(8 + i * 0.3),
        stage_5_second_deploy: Math.floor(3 + i * 0.15),
        stage_6_traction: Math.floor(1 + i * 0.05),
      },
      gas: {
        avg_gwei: 1 + Math.random() * 10,
        p50_gwei: 0.8 + Math.random() * 8,
        p95_gwei: 3 + Math.random() * 20,
      },
    });
  }
  return digests;
}

// ─── SVG Generation (pure SVG, no canvas required) ────────────────────────────

function svgWrap(width, height, content) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: ${COLORS.background};">
  <rect width="${width}" height="${height}" fill="${COLORS.background}"/>
  ${content}
</svg>`;
}

function svgText(x, y, text, opts = {}) {
  const { fontSize = 12, fill = COLORS.text, anchor = 'start', weight = 'normal' } = opts;
  return `<text x="${x}" y="${y}" font-size="${fontSize}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}">${escapeXml(String(text))}</text>`;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function drawLineChart(data, labels, series, opts = {}) {
  const { width = 800, height = 400, title = '', yLabel = '', padding = { top: 50, right: 30, bottom: 60, left: 70 } } = opts;
  const pw = width - padding.left - padding.right;
  const ph = height - padding.top - padding.bottom;

  if (!data || data.length === 0) {
    return svgWrap(width, height, svgText(width / 2, height / 2, 'No data available', { anchor: 'middle', fill: COLORS.textLight }));
  }

  const allValues = series.flatMap(s => data.map(d => d[s.key] || 0));
  const maxVal = Math.max(...allValues) * 1.1 || 1;
  const minVal = 0;

  const xScale = i => padding.left + (i / (data.length - 1 || 1)) * pw;
  const yScale = v => padding.top + ph - ((v - minVal) / (maxVal - minVal)) * ph;

  let content = '';

  // Title
  if (title) content += svgText(width / 2, 22, title, { anchor: 'middle', fontSize: 14, weight: 'bold' });

  // Grid lines
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (i / yTicks) * ph;
    const val = Math.round(maxVal - (i / yTicks) * maxVal);
    content += `<line x1="${padding.left}" y1="${y}" x2="${padding.left + pw}" y2="${y}" stroke="${COLORS.gridlines}" stroke-width="1"/>`;
    content += svgText(padding.left - 6, y + 4, val, { anchor: 'end', fontSize: 10, fill: COLORS.textLight });
  }

  // X-axis labels (show every Nth label to avoid clutter)
  const labelEvery = Math.ceil(data.length / 8);
  labels.forEach((label, i) => {
    if (i % labelEvery === 0 || i === data.length - 1) {
      const x = xScale(i);
      content += `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${padding.top + ph}" stroke="${COLORS.gridlines}" stroke-width="0.5"/>`;
      content += svgText(x, height - padding.bottom + 18, label, { anchor: 'middle', fontSize: 9, fill: COLORS.textLight });
    }
  });

  // Series lines and areas
  series.forEach(s => {
    const points = data.map((d, i) => `${xScale(i)},${yScale(d[s.key] || 0)}`).join(' ');
    const areaPoints = `${xScale(0)},${padding.top + ph} ` + points + ` ${xScale(data.length - 1)},${padding.top + ph}`;

    if (s.area) {
      content += `<polygon points="${areaPoints}" fill="${s.color}" opacity="0.15"/>`;
    }
    content += `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
  });

  // Legend
  series.forEach((s, i) => {
    const lx = padding.left + i * 160;
    const ly = height - 12;
    content += `<rect x="${lx}" y="${ly - 8}" width="20" height="3" fill="${s.color}" rx="1.5"/>`;
    content += svgText(lx + 24, ly, s.label, { fontSize: 10, fill: COLORS.textLight });
  });

  // Axes
  content += `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + ph}" stroke="${COLORS.textLight}" stroke-width="1"/>`;
  content += `<line x1="${padding.left}" y1="${padding.top + ph}" x2="${padding.left + pw}" y2="${padding.top + ph}" stroke="${COLORS.textLight}" stroke-width="1"/>`;

  // Y-axis label
  if (yLabel) {
    content += `<text x="${12}" y="${padding.top + ph / 2}" font-size="10" fill="${COLORS.textLight}" text-anchor="middle" transform="rotate(-90, 12, ${padding.top + ph / 2})">${escapeXml(yLabel)}</text>`;
  }

  return svgWrap(width, height, content);
}

function drawBarChart(data, labels, series, opts = {}) {
  const { width = 800, height = 400, title = '', stacked = false, padding = { top: 50, right: 30, bottom: 60, left: 70 } } = opts;
  const pw = width - padding.left - padding.right;
  const ph = height - padding.top - padding.bottom;

  if (!data || data.length === 0) {
    return svgWrap(width, height, svgText(width / 2, height / 2, 'No data available', { anchor: 'middle', fill: COLORS.textLight }));
  }

  const allValues = stacked
    ? data.map(d => series.reduce((sum, s) => sum + (d[s.key] || 0), 0))
    : series.flatMap(s => data.map(d => d[s.key] || 0));
  const maxVal = Math.max(...allValues) * 1.1 || 1;

  const barGroupW = pw / data.length;
  const barW = stacked ? barGroupW * 0.7 : (barGroupW * 0.8) / series.length;

  const xScale = i => padding.left + i * barGroupW + barGroupW * 0.1;
  const yScale = v => padding.top + ph - (v / maxVal) * ph;

  let content = '';
  if (title) content += svgText(width / 2, 22, title, { anchor: 'middle', fontSize: 14, weight: 'bold' });

  // Grid
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (i / 5) * ph;
    const val = Math.round(maxVal - (i / 5) * maxVal);
    content += `<line x1="${padding.left}" y1="${y}" x2="${padding.left + pw}" y2="${y}" stroke="${COLORS.gridlines}" stroke-width="1"/>`;
    content += svgText(padding.left - 6, y + 4, val, { anchor: 'end', fontSize: 10, fill: COLORS.textLight });
  }

  // Bars
  data.forEach((d, i) => {
    let stackOffset = 0;
    series.forEach((s, si) => {
      const val = d[s.key] || 0;
      const x = stacked ? xScale(i) : xScale(i) + si * barW;
      const barH = (val / maxVal) * ph;
      const y = stacked ? yScale(stackOffset + val) : yScale(val);
      if (barH > 0) {
        content += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${s.color}" rx="2" opacity="0.85"/>`;
      }
      if (stacked) stackOffset += val;
    });

    // X label
    const labelEvery = Math.ceil(data.length / 8);
    if (i % labelEvery === 0 || i === data.length - 1) {
      content += svgText(xScale(i) + barGroupW * 0.3, height - padding.bottom + 18, labels[i] || i, { anchor: 'middle', fontSize: 9, fill: COLORS.textLight });
    }
  });

  // Legend
  series.forEach((s, i) => {
    const lx = padding.left + i * 160;
    content += `<rect x="${lx}" y="${height - 12}" width="12" height="12" fill="${s.color}" rx="2" opacity="0.85"/>`;
    content += svgText(lx + 16, height - 3, s.label, { fontSize: 10, fill: COLORS.textLight });
  });

  content += `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + ph}" stroke="${COLORS.textLight}" stroke-width="1"/>`;
  content += `<line x1="${padding.left}" y1="${padding.top + ph}" x2="${padding.left + pw}" y2="${padding.top + ph}" stroke="${COLORS.textLight}" stroke-width="1"/>`;

  return svgWrap(width, height, content);
}

function drawHistogram(values, opts = {}) {
  const { width = 800, height = 400, title = '', bins = 20, xLabel = 'Block time (s)', padding = { top: 50, right: 30, bottom: 60, left: 70 } } = opts;
  const pw = width - padding.left - padding.right;
  const ph = height - padding.top - padding.bottom;

  if (!values || values.length === 0) {
    return svgWrap(width, height, svgText(width / 2, height / 2, 'No data available', { anchor: 'middle', fill: COLORS.textLight }));
  }

  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const binW = (maxVal - minVal) / bins || 0.1;

  const histogram = Array(bins).fill(0);
  values.forEach(v => {
    const idx = Math.min(Math.floor((v - minVal) / binW), bins - 1);
    histogram[idx]++;
  });

  const maxCount = Math.max(...histogram) * 1.1 || 1;
  const barW = pw / bins;
  const xScale = i => padding.left + i * barW;
  const yScale = v => padding.top + ph - (v / maxCount) * ph;

  let content = '';
  if (title) content += svgText(width / 2, 22, title, { anchor: 'middle', fontSize: 14, weight: 'bold' });

  histogram.forEach((count, i) => {
    const barH = (count / maxCount) * ph;
    const x = xScale(i);
    const y = yScale(count);
    if (barH > 0) {
      content += `<rect x="${x}" y="${y}" width="${barW - 1}" height="${barH}" fill="${COLORS.primary}" rx="1" opacity="0.8"/>`;
    }
    if (i % 4 === 0) {
      const val = (minVal + i * binW).toFixed(1);
      content += svgText(x, height - padding.bottom + 18, val, { anchor: 'middle', fontSize: 9, fill: COLORS.textLight });
    }
  });

  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (i / 5) * ph;
    const val = Math.round(maxCount - (i / 5) * maxCount);
    content += `<line x1="${padding.left}" y1="${y}" x2="${padding.left + pw}" y2="${y}" stroke="${COLORS.gridlines}" stroke-width="1"/>`;
    content += svgText(padding.left - 6, y + 4, val, { anchor: 'end', fontSize: 10, fill: COLORS.textLight });
  }

  content += `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + ph}" stroke="${COLORS.textLight}" stroke-width="1"/>`;
  content += `<line x1="${padding.left}" y1="${padding.top + ph}" x2="${padding.left + pw}" y2="${padding.top + ph}" stroke="${COLORS.textLight}" stroke-width="1"/>`;

  if (xLabel) content += svgText(padding.left + pw / 2, height - 4, xLabel, { anchor: 'middle', fontSize: 10, fill: COLORS.textLight });

  return svgWrap(width, height, content);
}

function drawTreemap(categories, opts = {}) {
  const { width = 600, height = 500, title = '' } = opts;

  if (!categories || categories.length === 0) {
    return svgWrap(width, height, svgText(width / 2, height / 2, 'No contract data', { anchor: 'middle', fill: COLORS.textLight }));
  }

  const total = categories.reduce((sum, c) => sum + (c.value || 0), 0) || 1;
  const palette = [COLORS.primary, COLORS.success, COLORS.warning, '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'];

  // Simple squarified treemap approximation
  let content = '';
  if (title) content += svgText(width / 2, 22, title, { anchor: 'middle', fontSize: 14, weight: 'bold' });

  const PADDING = { top: 35, left: 10, right: 10, bottom: 10 };
  let x = PADDING.left;
  let y = PADDING.top;
  const areaWidth = width - PADDING.left - PADDING.right;
  const areaHeight = height - PADDING.top - PADDING.bottom;

  // Sort by value desc, then lay out left-to-right, top-to-bottom
  const sorted = [...categories].sort((a, b) => (b.value || 0) - (a.value || 0));
  const rowHeight = areaHeight / Math.ceil(Math.sqrt(sorted.length));

  sorted.forEach((cat, i) => {
    const proportion = (cat.value || 0) / total;
    const cellWidth = Math.max(proportion * areaWidth * 2.5, 40);
    const cellHeight = Math.max(rowHeight * 0.85, 30);

    if (x + cellWidth > width - PADDING.right) {
      x = PADDING.left;
      y += rowHeight;
    }

    const fill = palette[i % palette.length];
    content += `<rect x="${x}" y="${y}" width="${Math.min(cellWidth, areaWidth)}" height="${cellHeight}" fill="${fill}" rx="4" opacity="0.85"/>`;
    if (cellWidth > 60) {
      content += svgText(x + 6, y + 16, cat.label || cat.category, { fontSize: 10, fill: '#fff', weight: 'bold' });
      content += svgText(x + 6, y + 28, cat.value || 0, { fontSize: 9, fill: 'rgba(255,255,255,0.8)' });
    }
    x += cellWidth + 4;
  });

  return svgWrap(width, height, content);
}

function drawRadarChart(dimensions, scores, opts = {}) {
  const { width = 600, height = 600, title = '', maxVal = 100 } = opts;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.35;
  const n = dimensions.length;

  let content = '';
  if (title) content += svgText(cx, 22, title, { anchor: 'middle', fontSize: 14, weight: 'bold' });

  // Grid rings
  [0.25, 0.5, 0.75, 1.0].forEach(r => {
    const pts = dimensions.map((_, i) => {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
      return `${cx + radius * r * Math.cos(angle)},${cy + radius * r * Math.sin(angle)}`;
    }).join(' ');
    content += `<polygon points="${pts}" fill="none" stroke="${COLORS.gridlines}" stroke-width="1"/>`;
    content += svgText(cx + 4, cy - radius * r + 4, Math.round(maxVal * r), { fontSize: 8, fill: COLORS.textLight });
  });

  // Axes
  dimensions.forEach((dim, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const x2 = cx + radius * Math.cos(angle);
    const y2 = cy + radius * Math.sin(angle);
    content += `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${COLORS.gridlines}" stroke-width="1"/>`;

    // Labels
    const lx = cx + (radius + 28) * Math.cos(angle);
    const ly = cy + (radius + 28) * Math.sin(angle);
    content += svgText(lx, ly + 4, dim, { anchor: 'middle', fontSize: 10, fill: COLORS.text });
  });

  // Score polygon
  const scorePts = scores.map((score, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const r = (score / maxVal) * radius;
    return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
  }).join(' ');

  content += `<polygon points="${scorePts}" fill="${COLORS.primary}" opacity="0.25" stroke="${COLORS.primary}" stroke-width="2"/>`;

  scores.forEach((score, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const r = (score / maxVal) * radius;
    const px = cx + r * Math.cos(angle);
    const py = cy + r * Math.sin(angle);
    content += `<circle cx="${px}" cy="${py}" r="4" fill="${COLORS.primary}"/>`;
  });

  return svgWrap(width, height, content);
}

function drawFunnelChart(stages, values, opts = {}) {
  const { width = 800, height = 400, title = '' } = opts;
  const PADDING = { top: 50, right: 200, bottom: 40, left: 20 };
  const pw = width - PADDING.left - PADDING.right;
  const ph = height - PADDING.top - PADDING.bottom;

  if (!stages || stages.length === 0) {
    return svgWrap(width, height, svgText(width / 2, height / 2, 'No funnel data', { anchor: 'middle', fill: COLORS.textLight }));
  }

  const maxVal = Math.max(...values) || 1;
  const barH = ph / stages.length * 0.7;
  const gap = ph / stages.length * 0.3;
  const palette = [COLORS.primary, '#818CF8', '#A5B4FC', '#C7D2FE', '#E0E7FF', '#EEF2FF'];

  let content = '';
  if (title) content += svgText(width / 2, 22, title, { anchor: 'middle', fontSize: 14, weight: 'bold' });

  stages.forEach((stage, i) => {
    const val = values[i] || 0;
    const barW = (val / maxVal) * pw;
    const y = PADDING.top + i * (barH + gap);
    const fill = palette[i % palette.length];

    content += `<rect x="${PADDING.left}" y="${y}" width="${barW}" height="${barH}" fill="${fill}" rx="3" opacity="0.85"/>`;
    content += svgText(PADDING.left + barW + 8, y + barH / 2 + 4, `${stage}: ${val}`, { fontSize: 11, fill: COLORS.text });

    if (i > 0 && values[i - 1] > 0) {
      const conv = Math.round((val / values[i - 1]) * 100);
      content += svgText(PADDING.left + pw + 60, y + barH / 2 + 4, `${conv}% →`, { fontSize: 10, fill: COLORS.textLight, anchor: 'middle' });
    }
  });

  return svgWrap(width, height, content);
}

function drawHeatmap(cohorts, stages, matrix, opts = {}) {
  const { width = 800, height = 500, title = '' } = opts;
  const PADDING = { top: 60, right: 20, bottom: 30, left: 80 };
  const pw = width - PADDING.left - PADDING.right;
  const ph = height - PADDING.top - PADDING.bottom;

  if (!matrix || matrix.length === 0) {
    return svgWrap(width, height, svgText(width / 2, height / 2, 'No cohort data', { anchor: 'middle', fill: COLORS.textLight }));
  }

  const cellW = pw / stages.length;
  const cellH = ph / cohorts.length;
  const maxVal = Math.max(...matrix.flat()) || 1;

  const interpolateColor = (v) => {
    const t = v / maxVal;
    // White → indigo gradient
    const r = Math.round(255 - t * (255 - 99));
    const g = Math.round(255 - t * (255 - 102));
    const b = Math.round(255 - t * (255 - 241));
    return `rgb(${r},${g},${b})`;
  };

  let content = '';
  if (title) content += svgText(width / 2, 22, title, { anchor: 'middle', fontSize: 14, weight: 'bold' });

  // Column headers
  stages.forEach((stage, j) => {
    content += svgText(PADDING.left + j * cellW + cellW / 2, PADDING.top - 8, stage, { anchor: 'middle', fontSize: 9, fill: COLORS.text });
  });

  // Row labels and cells
  cohorts.forEach((cohort, i) => {
    content += svgText(PADDING.left - 6, PADDING.top + i * cellH + cellH / 2 + 4, cohort, { anchor: 'end', fontSize: 9, fill: COLORS.text });

    stages.forEach((_, j) => {
      const val = (matrix[i] && matrix[i][j]) || 0;
      const x = PADDING.left + j * cellW;
      const y = PADDING.top + i * cellH;
      const fill = interpolateColor(val);
      content += `<rect x="${x + 1}" y="${y + 1}" width="${cellW - 2}" height="${cellH - 2}" fill="${fill}" rx="2"/>`;
      if (val > 0) {
        content += svgText(x + cellW / 2, y + cellH / 2 + 4, val, { anchor: 'middle', fontSize: 9, fill: val / maxVal > 0.5 ? '#fff' : COLORS.text });
      }
    });
  });

  return svgWrap(width, height, content);
}

// ─── Chart Generators ──────────────────────────────────────────────────────────

function generateActiveAddresses(digests) {
  const labels = digests.map(d => (d.date || '').slice(5));
  const data = digests.map(d => ({
    organic: getNestedValue(d, 'engagement.organic_dau'),
    raw: getNestedValue(d, 'engagement.raw_dau'),
  }));
  return drawLineChart(data, labels, [
    { key: 'raw', label: 'Raw DAU', color: COLORS.secondary, area: true },
    { key: 'organic', label: 'Organic DAU', color: COLORS.primary, area: true, width: 2.5 },
  ], { title: 'Active Addresses (30d)', yLabel: 'Addresses' });
}

function generateDailyTransactions(digests) {
  const labels = digests.map(d => (d.date || '').slice(5));
  const data = digests.map(d => ({
    organic: Math.floor(getNestedValue(d, 'engagement.total_transactions') * getNestedValue(d, 'engagement.organic_ratio', 0.6)),
    bot: Math.floor(getNestedValue(d, 'engagement.total_transactions') * (1 - getNestedValue(d, 'engagement.organic_ratio', 0.6))),
  }));
  return drawBarChart(data, labels, [
    { key: 'organic', label: 'Organic', color: COLORS.primary },
    { key: 'bot', label: 'Bot/filtered', color: COLORS.secondary },
  ], { title: 'Daily Transactions (30d)', stacked: true });
}

function generateGasEconomics(digests) {
  const labels = digests.map(d => (d.date || '').slice(5));
  const data = digests.map(d => ({
    avg: getNestedValue(d, 'gas.avg_gwei', getNestedValue(d, 'chain_health.avg_gas_gwei', 2)),
    p50: getNestedValue(d, 'gas.p50_gwei', getNestedValue(d, 'chain_health.p50_gas_gwei', 1.5)),
    p95: getNestedValue(d, 'gas.p95_gwei', getNestedValue(d, 'chain_health.p95_gas_gwei', 8)),
  }));
  return drawLineChart(data, labels, [
    { key: 'p95', label: 'p95', color: COLORS.warning },
    { key: 'avg', label: 'Average', color: COLORS.primary, width: 2 },
    { key: 'p50', label: 'p50', color: COLORS.success },
  ], { title: 'Gas Economics (30d, gwei)', yLabel: 'Gwei' });
}

function generateContractDeployments(digests) {
  const labels = digests.map(d => (d.date || '').slice(5));
  const data = digests.map(d => ({
    deployed: getNestedValue(d, 'contracts.deployed_24h'),
    verified: getNestedValue(d, 'contracts.verified_24h'),
  }));
  return drawBarChart(data, labels, [
    { key: 'deployed', label: 'Deployed', color: COLORS.secondary },
    { key: 'verified', label: 'Verified', color: COLORS.primary },
  ], { title: 'Contract Deployments (30d)' });
}

function generateBlockTimeDistribution(digests) {
  // Use last 7 days, approximate block time distribution from avg
  const last7 = digests.slice(-7);
  const blockTimes = last7.flatMap(d => {
    const avg = getNestedValue(d, 'chain_health.avg_block_time', 2);
    // Generate approximate distribution around avg with +/-30% variance
    return Array.from({ length: 20 }, () => avg + (Math.random() - 0.5) * avg * 0.6);
  });
  return drawHistogram(blockTimes, { title: 'Block Time Distribution (7d)', xLabel: 'Block time (s)', bins: 20 });
}

function generateEcosystemMap(registry) {
  const contracts = registry.contracts || [];
  const categoryCounts = {};
  contracts.forEach(c => {
    (c.categories || ['unknown']).forEach(cat => {
      categoryCounts[cat] = (categoryCounts[cat] || 0) + (c.activity?.tx_count || 1);
    });
  });
  const categories = Object.entries(categoryCounts)
    .map(([category, value]) => ({ category, label: category.replace(/_/g, ' '), value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  return drawTreemap(categories, { title: 'Contract Ecosystem Map (by interactions)', width: 600, height: 500 });
}

function generateScorecardTrend(digests) {
  // Use weekly digests (every 7th) for 12-week trend
  const weekly = digests.filter((_, i) => i % 7 === 0).slice(-12);
  const labels = weekly.map(d => (d.date || '').slice(5, 10));
  const data = weekly.map(d => ({
    organic_dau: getNestedValue(d, 'engagement.organic_dau'),
    contracts: getNestedValue(d, 'contracts.deployed_24h') * 7,
    verification: getNestedValue(d, 'contracts.verification_rate') * 100,
  }));
  return drawLineChart(data, labels, [
    { key: 'organic_dau', label: 'Organic DAU', color: COLORS.primary },
    { key: 'contracts', label: 'Contracts/week', color: COLORS.success },
    { key: 'verification', label: 'Verify rate %', color: COLORS.warning },
  ], { title: 'Scorecard Trend (12 weeks)' });
}

function generateDeveloperFunnel(journeys) {
  const snapshot = journeys.funnel_snapshot || {};
  const stages = ['Faucet', 'First Tx', 'Deploy', 'Verified', '2nd Deploy', 'Traction'];
  const values = [
    snapshot.stage_1_faucet || 0,
    snapshot.stage_2_first_tx || 0,
    snapshot.stage_3_first_deploy || 0,
    snapshot.stage_4_verified || 0,
    snapshot.stage_5_second_deploy || 0,
    snapshot.stage_6_traction || 0,
  ];
  return drawFunnelChart(stages, values, { title: 'Developer Funnel' });
}

function generateExchangeReadinessIndex(eriComponents) {
  const dimensions = [
    'Trading\nPrimitives',
    'Token\nPairs',
    'Financial\nDiversity',
    'Trading\nTx Share',
    'Dev\nIntent',
    'NexusCore\nUtilization',
  ];
  const scores = [
    eriComponents.trading_primitives || 0,
    eriComponents.token_pairs || 0,
    eriComponents.financial_diversity || 0,
    eriComponents.trading_tx_share || 0,
    eriComponents.developer_intent || 0,
    eriComponents.nexuscore_utilization || 0,
  ];
  return drawRadarChart(dimensions, scores, { title: 'Exchange Readiness Index', width: 600, height: 600 });
}

function generateEriTrend(digests) {
  // ERI trend over time (stored in digest if available, else approximate from contract data)
  const weekly = digests.filter((_, i) => i % 7 === 0).slice(-12);
  const labels = weekly.map(d => (d.date || '').slice(5, 10));
  const data = weekly.map(d => ({
    eri: getNestedValue(d, 'eri_score', 0),
  }));
  return drawLineChart(data, labels, [
    { key: 'eri', label: 'ERI Score (0-100)', color: COLORS.primary, area: true, width: 2 },
  ], { title: 'Exchange Readiness Index Trend (12 weeks)', yLabel: 'ERI Score' });
}

function generateCohortRetention(journeys) {
  const devs = journeys.developers || {};
  const devList = Object.values(devs);

  // Build cohort matrix: week of first_seen x current funnel stage
  const weekCohorts = {};
  devList.forEach(dev => {
    const firstSeen = dev.first_seen || dev.stage_timestamps?.stage_1_faucet || '';
    if (!firstSeen) return;
    const week = firstSeen.slice(0, 7); // YYYY-MM
    if (!weekCohorts[week]) weekCohorts[week] = Array(6).fill(0);
    const stage = Math.min(Math.max((dev.stage || 0) - 1, 0), 5);
    for (let s = 0; s <= stage; s++) {
      weekCohorts[week][s]++;
    }
  });

  const cohorts = Object.keys(weekCohorts).sort().slice(-8);
  const stages = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
  const matrix = cohorts.map(c => weekCohorts[c] || Array(6).fill(0));

  return drawHeatmap(cohorts, stages, matrix, { title: 'Cohort Retention (month x funnel stage)' });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nNexus Testnet Chart Generator`);
  console.log(`Week: ${WEEK}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
  console.log(`Mock mode: ${MOCK_MODE}\n`);

  // Create output dir
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Load data
  let digests = MOCK_MODE ? generateMockDigests(30) : loadDigests(DATA_DIR, 30);

  if (digests.length === 0 && !MOCK_MODE) {
    console.warn('No digest data found. Generating with mock data...');
    digests = generateMockDigests(7);
  }

  const registry = loadJSON(REGISTRY_FILE, { contracts: [] });
  const journeys = loadJSON(JOURNEYS_FILE, { developers: {}, funnel_snapshot: {} });

  // Mock ERI components for rendering (real values injected by trend-report skill)
  const eriComponents = {
    trading_primitives: Math.round(Math.random() * 40),
    token_pairs: Math.round(Math.random() * 30),
    financial_diversity: Math.round(Math.random() * 50),
    trading_tx_share: Math.round(Math.random() * 25),
    developer_intent: Math.round(Math.random() * 45),
    nexuscore_utilization: 0, // Always 0 pre-launch
  };

  const charts = [
    ['active-addresses.svg', () => generateActiveAddresses(digests)],
    ['daily-transactions.svg', () => generateDailyTransactions(digests)],
    ['gas-economics.svg', () => generateGasEconomics(digests)],
    ['contract-deployments.svg', () => generateContractDeployments(digests)],
    ['block-time-distribution.svg', () => generateBlockTimeDistribution(digests)],
    ['ecosystem-map.svg', () => generateEcosystemMap(registry)],
    ['scorecard-trend.svg', () => generateScorecardTrend(digests)],
    ['developer-funnel.svg', () => generateDeveloperFunnel(journeys)],
    ['exchange-readiness-index.svg', () => generateExchangeReadinessIndex(eriComponents)],
    ['eri-trend.svg', () => generateEriTrend(digests)],
    ['cohort-retention.svg', () => generateCohortRetention(journeys)],
  ];

  let generated = 0;
  let failed = 0;

  for (const [filename, generator] of charts) {
    try {
      const svg = generator();
      const outputPath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(outputPath, svg, 'utf8');

      // Basic validation: check it's valid XML with SVG root
      if (!svg.includes('<svg ') || !svg.includes('</svg>')) {
        throw new Error('Generated SVG appears malformed');
      }

      console.log(`  + ${filename} (${Math.round(svg.length / 1024)}kb)`);
      generated++;
    } catch (e) {
      console.error(`  x ${filename}: ${e.message}`);
      failed++;

      // Write error placeholder SVG
      const errorSvg = svgWrap(800, 400,
        svgText(400, 200, `Chart generation failed: ${escapeXml(e.message)}`, { anchor: 'middle', fill: COLORS.alert })
      );
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), errorSvg, 'utf8');
    }
  }

  console.log(`\nComplete: ${generated} generated, ${failed} failed`);
  console.log(`Output: ${OUTPUT_DIR}/\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(2);
});
