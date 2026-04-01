/**
 * batteryAnalyzer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * All analysis logic for the YETI Battery Analyzer tool.
 *
 * This file is intentionally structured so each concern is its own clearly
 * named function — the Astro page only calls initBatteryAnalyzer() and the
 * DOM wiring happens here.
 *
 * Data flow:
 *   File input  →  parseDSLog()       →  raw [{t, v, c, enabled, auto}]
 *                  mergeAndCompute()   →  aligned arrays + derived signals
 *                  buildCharts()       →  Chart.js instances
 *
 * Sections:
 *   1. DS LOG PARSER          — handles .dslog binary + any delimited text
 *   2. MATH UTILITIES         — rolling windows, regression, local maxima
 *   3. ANALYSIS PIPELINE      — aligns signals, computes impedance, stats
 *   4. CHART BUILDER          — creates/updates Chart.js canvases
 *   5. TOGGLE & SLIDER WIRING — interactivity
 *   6. CSV EXPORT             — per-section download
 *   7. DOM INIT               — entry point, file input wiring, demo data
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const V_RADIO_BROWNOUT = 6.3;   // V — radio resets at or below this
const V_CAN_FAULT      = 7.5;   // V — CAN controllers fault
const V_MOTOR_LOSS     = 8.5;   // V — significant torque reduction
const I_BREAKER        = 120;   // A — main breaker sustained-trip
const I_CRITICAL       = 160;   // A — critical, severe fault risk
const I_MIN_IMP        = 15;    // A — minimum current for impedance calc
const R_MAX_PLAUSIBLE  = 0.15;  // Ω — sanity cap for per-sample impedance
const BATT_CAPACITY_WH = 216;   // Wh — 18 Ah × 12 V nominal

const YETI_BLUE = '#3b82f6';   // matches Tailwind blue-500 / yeti-blue

// ─────────────────────────────────────────────────────────────────────────────
// 1. DS LOG PARSER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a DS log file (binary or text) into a uniform array of samples.
 *
 * Each sample: { t: number, v: number, c: number|NaN, enabled: boolean, auto: boolean }
 *   t       — timestamp in seconds
 *   v       — battery terminal voltage (V)
 *   c       — total robot current (A), or NaN if not present in log
 *   enabled — robot was enabled at this sample
 *   auto    — autonomous mode was active at this sample
 *
 * Returns a Promise that resolves to the array, or null on failure.
 */
export function parseDSLog(file) {
  return new Promise(resolve => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.dslog') || name.endsWith('.dsevents')) {
      const reader = new FileReader();
      reader.onload = e => resolve(parseDSBinary(new DataView(e.target.result)));
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = e => resolve(parseDSText(e.target.result));
      reader.readAsText(file);
    }
  });
}

/**
 * Binary .dslog decoder.
 *
 * The DS Log v3 format stores records at a fixed stride (~22 bytes at 50 Hz).
 * No public spec exists, so we probe several stride lengths and byte offsets,
 * scoring each combination by the fraction of records that yield a plausible
 * voltage value (6 – 14.5 V).
 *
 * Voltage encoding attempts (in priority order):
 *   uint16 LE at offset+4, divided by 256   ← most common
 *   uint16 LE at offset+2, divided by 256
 *   uint8  at offset+4, divided by 10
 *   uint16 LE at offset+6, divided by 1000
 *   uint16 BE at offset+4, divided by 256
 *
 * Current encoding (when found):
 *   uint16 LE at offset+6, divided by 256   ← DS v3 robot current field
 *   uint16 LE at offset+8, divided by 256   ← alternate position
 */
function parseDSBinary(dv) {
  const len = dv.byteLength;

  let bestVolts = null;
  let bestCurr  = null;
  let bestScore = 0;

  for (const stride of [22, 20, 24, 16, 32, 28]) {
    if (len < stride * 20) continue;
    const volts   = [];
    const currArr = [];
    let good = 0;

    for (let off = 0; off + stride <= len; off += stride) {
      try {
        // Attempt voltage decode
        const vCandidates = [
          dv.getUint16(off + 4, true)  / 256,
          dv.getUint16(off + 2, true)  / 256,
          dv.getUint8(off + 4)         / 10,
          dv.getUint16(off + 6, true)  / 1000,
          dv.getUint16(off + 4, false) / 256,
        ];
        const v = vCandidates.find(c => c >= 6 && c <= 14.5);
        if (v === undefined) { volts.push(NaN); currArr.push(NaN); continue; }

        good++;
        volts.push(v);

        // Attempt current decode from alternate offsets
        const cCandidates = [
          dv.getUint16(off + 6, true) / 256,
          dv.getUint16(off + 8, true) / 256,
          dv.getUint16(off + 10, true) / 256,
        ];
        // A valid current reading: 0 – 500 A
        const c = cCandidates.find(x => x >= 0 && x <= 500);
        currArr.push(c !== undefined ? c : NaN);
      } catch (_) {
        volts.push(NaN);
        currArr.push(NaN);
      }
    }

    const coverage = good / (len / stride);
    if (coverage > bestScore && good > 50) {
      bestScore = coverage;
      bestVolts = volts;
      bestCurr  = currArr;
    }
  }

  if (!bestVolts) {
    // Last-resort: walk all uint16 LE values looking for voltage-range values
    const found = [];
    for (let off = 0; off + 2 <= len; off += 2) {
      const v = dv.getUint16(off, true) / 1000;
      if (v >= 8 && v <= 14) found.push(v);
      if (found.length > 10000) break;
    }
    if (found.length < 100) return null;
    return found.map((v, i) => ({
      t: +(i * 0.02).toFixed(3), v: +v.toFixed(4),
      c: NaN, enabled: true, auto: false,
    }));
  }

  return bestVolts
    .map((v, i) => ({
      t: +(i * 0.02).toFixed(3),
      v: isNaN(v) ? null : +v.toFixed(4),
      c: bestCurr ? bestCurr[i] : NaN,
      enabled: true,
      auto: i < 375, // first 7.5 s assumed auto (15 s auto = 750 samples at 50 Hz)
    }))
    .filter(s => s.v !== null);
}

/**
 * Text / CSV / TSV / semicolon-delimited log decoder.
 *
 * Auto-detects:
 *   • Delimiter (tab, comma, semicolon) by character frequency in the first 6 lines
 *   • Header row (any row where < 65% of tokens parse as numbers)
 *   • Column mapping by keyword matching (case-insensitive, punctuation stripped):
 *       time     → time, timestamp, elapsed, t
 *       voltage  → battery, voltage, volt, batt, vbat
 *       current  → current, amps, amp, curr, robotcurrent, totalcurrent
 *       enabled  → enabled, enable
 *       auto     → auto, autonomous
 *   • Falls back to scanning column medians to find the voltage column when
 *     none of the keyword patterns match (handles headerless files)
 */
function parseDSText(raw) {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                   .split('\n').filter(l => l.trim());
  if (lines.length < 5) return null;

  // Detect delimiter
  const sample = lines.slice(0, 6).join('\n');
  const nTabs   = (sample.match(/\t/g) || []).length;
  const nCommas = (sample.match(/,/g)  || []).length;
  const nSemis  = (sample.match(/;/g)  || []).length;
  const delim   = nTabs > nCommas && nTabs > nSemis ? '\t'
                : nSemis > nCommas ? ';' : ',';

  const split = l => l.split(delim).map(s => s.trim().replace(/"/g, ''));

  // Find header row
  let hIdx = 0, headers = [];
  for (let i = 0; i < Math.min(8, lines.length); i++) {
    const cols = split(lines[i]);
    const numCount = cols.filter(c => !isNaN(parseFloat(c)) && c !== '').length;
    if (numCount < cols.length * 0.65) {
      headers = cols;
      hIdx    = i;
      break;
    }
  }

  // Column finder — strips all non-alpha before comparing
  const norm  = s => s.toLowerCase().replace(/[^a-z]/g, '');
  const findCol = (...kws) => {
    for (const kw of kws) {
      const k = norm(kw);
      const i = headers.findIndex(h => norm(h).includes(k));
      if (i !== -1) return i;
    }
    return -1;
  };

  let iT  = findCol('time', 'timestamp', 'elapsed');
  let iV  = findCol('battery', 'voltage', 'volt', 'batt', 'vbat');
  let iC  = findCol('current', 'amps', 'amp', 'curr', 'robotcurrent', 'totalcurrent');
  let iEn = findCol('enabled', 'enable');
  let iAu = findCol('auto', 'autonomous');

  // Fallback: scan column medians for a voltage-range column
  if (iV === -1) {
    const dataStart = hIdx + (headers.length ? 1 : 0);
    const nCols = split(lines[dataStart] || lines[0]).length;
    const colSamples = Array.from({ length: nCols }, () => []);
    for (let i = dataStart; i < Math.min(dataStart + 200, lines.length); i++) {
      split(lines[i]).forEach((c, j) => {
        const v = parseFloat(c);
        if (!isNaN(v)) colSamples[j].push(v);
      });
    }
    for (let j = 0; j < nCols; j++) {
      const s   = [...colSamples[j]].sort((a, b) => a - b);
      const med = s[Math.floor(s.length / 2)];
      if (med >= 9 && med <= 13.5 && s[0] >= 5) {
        iV = j;
        if (iT === -1 && j > 0) iT = 0;
        break;
      }
    }
  }

  if (iV === -1) return null;

  const dataStart = hIdx + (headers.length ? 1 : 0);
  const data = [];
  for (let i = dataStart; i < lines.length; i++) {
    const cols = split(lines[i]);
    const v = parseFloat(cols[iV]);
    if (isNaN(v) || v < 3 || v > 16) continue;
    const t  = iT  !== -1 ? parseFloat(cols[iT])  : data.length * 0.02;
    const c  = iC  !== -1 ? parseFloat(cols[iC])  : NaN;
    const en = iEn !== -1
      ? cols[iEn].trim() === '1' || cols[iEn].toLowerCase().trim() === 'true'
      : true;
    const au = iAu !== -1
      ? cols[iAu].trim() === '1' || cols[iAu].toLowerCase().trim() === 'true'
      : false;
    data.push({
      t:  isNaN(t) ? data.length * 0.02 : t,
      v:  +v.toFixed(4),
      c:  isNaN(c) ? NaN : +Math.max(0, c).toFixed(3),
      enabled: en,
      auto: au,
    });
  }
  return data.length > 10 ? data : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. MATH UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rolling minimum — causal backward-looking window.
 * out[i] = min of arr[max(0, i−w+1) .. i]
 * Used for voltage: reveals worst-case dips within the window.
 *
 * Uses a monotone deque for O(n) performance.
 */
function rollingMin(arr, w) {
  const out   = new Float64Array(arr.length);
  const deque = []; // indices, maintained so arr[deque[0]] is always the min
  for (let i = 0; i < arr.length; i++) {
    // Remove indices that fall out of the window
    while (deque.length && deque[0] < i - w + 1) deque.shift();
    // Remove indices whose values are >= arr[i] (they can never be the min)
    while (deque.length && arr[deque[deque.length - 1]] >= arr[i]) deque.pop();
    deque.push(i);
    out[i] = arr[deque[0]];
  }
  return out;
}

/**
 * Rolling mean — O(n) accumulator.
 * out[i] = mean of arr[max(0, i−w+1) .. i]
 * Used for current and power.
 */
function rollingMean(arr, w) {
  const out = new Float64Array(arr.length);
  let sum = 0, cnt = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i]; cnt++;
    if (i >= w) { sum -= arr[i - w]; cnt--; }
    out[i] = sum / cnt;
  }
  return out;
}

/**
 * Rolling median — O(n·w).
 * Acceptable for w ≤ 250 at typical log sizes (8000 samples).
 * Used for impedance, which is already a sparse sub-array.
 */
function rollingMedian(arr, w) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const win = Array.from(arr.slice(Math.max(0, i - w + 1), i + 1)).sort((a, b) => a - b);
    out[i] = win[Math.floor(win.length / 2)];
  }
  return out;
}

/**
 * Linear regression: y = m·x + b
 * Returns { m, b, r2 }.
 */
function linReg(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { m: 0, b: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sx  += xs[i]; sy  += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
    syy += ys[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { m: 0, b: sy / n, r2: 0 };
  const m      = (n * sxy - sx * sy) / denom;
  const b      = (sy - m * sx) / n;
  const ssTot  = syy - sy * sy / n;
  const ssRes  = syy - m * sxy - b * sy;
  const r2     = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return {
    m:  +m.toFixed(8),
    b:  +b.toFixed(6),
    r2: +r2.toFixed(4),
  };
}

/** Format regression equation for display. */
function fmtEq(reg, xLabel = 't', yLabel = 'y') {
  if (!reg || reg.r2 === 0) return '—';
  const sign = reg.b >= 0 ? '+' : '−';
  return `${yLabel} = ${reg.m.toExponential(3)} · ${xLabel} ${sign} ${Math.abs(reg.b).toFixed(4)}  (R² = ${reg.r2.toFixed(3)})`;
}

/**
 * Local maxima finder.
 * Returns indices where arr[i] > arr[i−1], arr[i] > arr[i+1], and arr[i] >= threshold.
 * Enforces a minimum gap (minGap samples) between successive peaks to avoid
 * clustering noise spikes.
 */
function localMaxima(arr, threshold = 0, minGap = 5) {
  const peaks = [];
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i] >= threshold && arr[i] >= arr[i - 1] && arr[i] >= arr[i + 1]) {
      if (!peaks.length || i - peaks[peaks.length - 1] >= minGap) {
        peaks.push(i);
      }
    }
  }
  return peaks;
}

/** Downsample array to at most maxPts points by uniform striding. */
function downsample(arr, maxPts = 900) {
  const step = Math.max(1, Math.floor(arr.length / maxPts));
  const out  = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  return out;
}

/** Percentile of a pre-sorted array. */
function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.floor(sorted.length * p)];
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ANALYSIS PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central analysis function.
 *
 * Takes raw parsed samples from parseDSLog() and computes all derived signals.
 * Returns a results object consumed by the chart builder and stat renderers.
 */
function analyze(rawSamples) {
  rawSamples.sort((a, b) => a.t - b.t);
  const n       = rawSamples.length;
  const times   = rawSamples.map(d => d.t);
  const volts   = rawSamples.map(d => d.v);
  const currRaw = rawSamples.map(d => d.c);
  const dt      = n > 1 ? (times[n - 1] - times[0]) / (n - 1) : 0.02;
  const hasCurr = currRaw.filter(c => !isNaN(c) && c > 0).length > n * 0.15;

  // Safe current array (replace NaN with 0 for rolling calculations)
  const currSafe = currRaw.map(c => (isNaN(c) ? 0 : Math.max(0, c)));

  // ── OCV: mean of top 3% of voltage samples ─────────────────────────────
  const sortedV = [...volts].sort((a, b) => b - a);
  const topN    = Math.max(3, Math.floor(n * 0.03));
  const ocv     = sortedV.slice(0, topN).reduce((a, b) => a + b, 0) / topN;

  // ── Power ────────────────────────────────────────────────────────────────
  const power = volts.map((v, i) => hasCurr ? Math.max(0, v * currSafe[i]) : NaN);

  // ── Impedance samples (at current peaks with I > I_MIN_IMP) ─────────────
  const peakMinGap = Math.max(1, Math.round(0.1 / dt));
  const peakIdxC   = localMaxima(currSafe, I_MIN_IMP, peakMinGap);
  const impSamples = peakIdxC
    .map(idx => {
      const sag = Math.max(0, ocv - volts[idx]);
      const R   = currSafe[idx] > 0 ? sag / currSafe[idx] : NaN;
      return {
        idx,
        t:    times[idx],
        v:    volts[idx],
        c:    currSafe[idx],
        sag,
        R,          // Ω
        Rmohm: R * 1000, // mΩ
      };
    })
    .filter(s => !isNaN(s.R) && s.R > 0 && s.R < R_MAX_PLAUSIBLE);

  // ── All current peaks (lower threshold, for scatter) ─────────────────────
  const peakIdxAll = hasCurr ? localMaxima(currSafe, 30, peakMinGap) : [];

  // ── Voltage statistics ────────────────────────────────────────────────────
  const vMin    = Math.min(...volts);
  const vMax    = Math.max(...volts);
  const vMean   = volts.reduce((a, b) => a + b, 0) / n;
  const nBrown  = volts.filter(v => v < V_RADIO_BROWNOUT).length;
  const nCan    = volts.filter(v => v < V_CAN_FAULT).length;
  const nMotor  = volts.filter(v => v < V_MOTOR_LOSS).length;

  // SOC estimate: linear interpolation 10.5 V = 0%, 12.8 V = 100%
  const socFn = v => Math.min(100, Math.max(0, (v - 10.5) / (12.8 - 10.5) * 100));
  const firstTop = [...rawSamples.slice(0, Math.min(200, n)).map(d => d.v)].sort((a, b) => b - a);
  const lastTop  = [...rawSamples.slice(-Math.min(200, n)).map(d => d.v)].sort((a, b) => b - a);
  const socStart = socFn(firstTop.slice(0, 5).reduce((a, b) => a + b, 0) / 5);
  const socEnd   = socFn(lastTop.slice(0, 5).reduce((a, b) => a + b, 0)  / 5);

  // ── Current statistics ────────────────────────────────────────────────────
  let cMax = NaN, cMean = NaN, cP90 = NaN, cP99 = NaN;
  let nOver120 = 0, nOver160 = 0;
  if (hasCurr) {
    const valid    = currSafe.filter(c => c > 0);
    const sortedC  = [...valid].sort((a, b) => a - b);
    cMax     = Math.max(...valid);
    cMean    = valid.reduce((a, b) => a + b, 0) / valid.length;
    cP90     = pct(sortedC, 0.90);
    cP99     = pct(sortedC, 0.99);
    nOver120 = valid.filter(c => c > I_BREAKER).length;
    nOver160 = valid.filter(c => c > I_CRITICAL).length;
  }

  // ── Power statistics ──────────────────────────────────────────────────────
  let pMax = NaN, pMean = NaN, totalWh = NaN;
  if (hasCurr) {
    const validP = power.filter(p => !isNaN(p) && p > 0);
    pMax     = Math.max(...validP);
    pMean    = validP.reduce((a, b) => a + b, 0) / validP.length;
    totalWh  = power.reduce((a, p) => a + (isNaN(p) ? 0 : p), 0) * dt / 3600;
  }

  // ── Impedance statistics ──────────────────────────────────────────────────
  let medR = NaN, p10R = NaN, p90R = NaN, p97R = NaN, ccaEst = NaN;
  if (impSamples.length > 3) {
    const sortedR = [...impSamples.map(s => s.Rmohm)].sort((a, b) => a - b);
    medR   = pct(sortedR, 0.50);
    p10R   = pct(sortedR, 0.10);
    p90R   = pct(sortedR, 0.90);
    p97R   = pct(sortedR, 0.97);
    ccaEst = medR > 0 ? Math.round(7200 / medR) : NaN; // 7.2 Ω × 1000 mΩ/Ω
  }

  // ── Health score (0–100) ─────────────────────────────────────────────────
  let score = 100;
  if (!isNaN(medR)) {
    if      (medR > 35) score -= 28;
    else if (medR > 25) score -= 15;
    else if (medR > 18) score -= 7;
    if (!isNaN(p90R) && medR > 0 && p90R / medR > 4) score -= 9;
  }
  if (nCan / n * 100 > 5)   score -= 24;
  else if (nCan / n * 100 > 1) score -= 11;
  if (nMotor / n * 100 > 15) score -= 18;
  else if (nMotor / n * 100 > 5) score -= 7;
  if (socEnd < 30) score -= 14;
  else if (socEnd < 50) score -= 5;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    // raw
    times, volts, currSafe, power, impSamples, peakIdxAll, peakIdxC,
    // derived
    ocv, dt, n, hasCurr,
    // voltage stats
    vMin, vMax, vMean, nBrown, nCan, nMotor, socStart, socEnd,
    // current stats
    cMax, cMean, cP90, cP99, nOver120, nOver160,
    // power stats
    pMax, pMean, totalWh,
    // impedance stats
    medR, p10R, p90R, p97R, ccaEst,
    // score
    score,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CHART BUILDER
// ─────────────────────────────────────────────────────────────────────────────

// Chart instances (destroyed and recreated on new file)
let CHARTS = {};

function destroyCharts() {
  Object.values(CHARTS).forEach(c => c && c.destroy());
  CHARTS = {};
}

// Shared Chart.js options that match the YETI dark theme
const BASE_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: { legend: { display: false } },
  scales: {
    x: {
      ticks: { color: '#64748b', font: { family: 'ui-monospace, monospace', size: 10 }, maxTicksLimit: 12 },
      grid:  { color: 'rgba(255,255,255,0.04)' },
    },
    y: {
      ticks: { color: '#64748b', font: { family: 'ui-monospace, monospace', size: 10 } },
      grid:  { color: 'rgba(255,255,255,0.04)' },
    },
  },
};

/** Draw a horizontal threshold line after each chart render. */
function hLinePlugin(lines) {
  return {
    afterDraw(chart) {
      lines.forEach(({ y, scaleId = 'y', color, label }) => {
        const sc = chart.scales[scaleId];
        if (!sc) return;
        const { ctx, chartArea: ca } = chart;
        const py = sc.getPixelForValue(y);
        if (py < ca.top || py > ca.bottom) return;
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.moveTo(ca.left, py);
        ctx.lineTo(ca.right, py);
        ctx.stroke();
        ctx.font      = '9px ui-monospace, monospace';
        ctx.fillStyle = color;
        ctx.textAlign = 'right';
        ctx.fillText(label, ca.right - 4, py - 3);
        ctx.restore();
      });
    },
  };
}

/**
 * Builds all four section charts from the analysis results.
 *
 * Each chart stores its datasets by name so toggle() can find them by label
 * without relying on fragile numeric indices.
 */
function buildCharts(res, windows) {
  destroyCharts();
  buildVoltageChart(res, windows.v);
  buildCurrentChart(res, windows.c);
  buildPowerChart(res, windows.p);
  buildImpedanceChart(res, windows.i);
}

// ── VOLTAGE ──────────────────────────────────────────────────────────────────
function buildVoltageChart(res, w) {
  const { times, volts, dt } = res;
  const rollV = Array.from(rollingMin(new Float64Array(volts), w));
  const reg   = linReg(times, volts);
  const regY  = times.map(t => reg.m * t + reg.b);

  el('eqV').textContent = 'Regression: ' + fmtEq(reg, 't', 'V');

  const step = Math.max(1, Math.floor(times.length / 900));
  const T  = [], V = [], RV = [], RG = [];
  for (let i = 0; i < times.length; i += step) {
    T.push(+times[i].toFixed(2));
    V.push(+volts[i].toFixed(4));
    RV.push(+rollV[i].toFixed(4));
    RG.push(+regY[i].toFixed(4));
  }

  // Color rolling min segment by severity
  const segColor = ctx => {
    const v = RV[ctx.p1DataIndex] ?? RV[ctx.p0DataIndex];
    return v < V_RADIO_BROWNOUT ? '#ef4444'
         : v < V_CAN_FAULT      ? 'rgba(239,68,68,0.75)'
         : v < V_MOTOR_LOSS     ? '#f97316'
         : YETI_BLUE;
  };

  CHARTS.v = new Chart(el('chartV'), {
    data: {
      labels: T,
      datasets: [
        {
          label: 'Raw voltage',
          type: 'line', data: V, yAxisID: 'y',
          borderColor: 'rgba(59,130,246,0.30)', borderWidth: 1,
          pointRadius: 0, fill: false, tension: 0.04, order: 3,
        },
        {
          label: 'Rolling min',
          type: 'line', data: RV, yAxisID: 'y',
          borderColor: YETI_BLUE, borderWidth: 2.5,
          pointRadius: 0, fill: false, tension: 0, order: 2,
          segment: { borderColor: segColor },
        },
        {
          label: 'Regression',
          type: 'line', data: RG, yAxisID: 'y',
          borderColor: '#a78bfa', borderWidth: 1.5, borderDash: [6, 4],
          pointRadius: 0, fill: false, tension: 0, order: 1,
        },
      ],
    },
    options: {
      ...BASE_OPTS,
      scales: {
        ...BASE_OPTS.scales,
        y: {
          ...BASE_OPTS.scales.y,
          ticks: { ...BASE_OPTS.scales.y.ticks, color: YETI_BLUE },
          title: { display: true, text: 'V', color: YETI_BLUE, font: { size: 10, family: 'ui-monospace, monospace' } },
        },
      },
    },
    plugins: [hLinePlugin([
      { y: V_RADIO_BROWNOUT, color: 'rgba(239,68,68,0.55)',  label: '6.3V radio' },
      { y: V_MOTOR_LOSS,     color: 'rgba(249,115,22,0.45)', label: '8.5V motors' },
    ])],
  });

  buildToggles('v', CHARTS.v, [
    { label: 'Raw voltage', color: 'rgba(59,130,246,0.5)' },
    { label: 'Rolling min', color: YETI_BLUE },
    { label: 'Regression',  color: '#a78bfa' },
  ]);

  // Store for CSV + slider updates
  CHARTS.v._meta = { times, volts, rollV, regY, reg, w };
}

// ── CURRENT ───────────────────────────────────────────────────────────────────
function buildCurrentChart(res, w) {
  const { times, currSafe, hasCurr, peakIdxAll, dt } = res;
  if (!hasCurr) return;

  const rollC  = Array.from(rollingMean(new Float64Array(currSafe), w));
  const peakTs = peakIdxAll.map(i => times[i]);
  const peakCs = peakIdxAll.map(i => currSafe[i]);
  const reg    = linReg(peakTs, peakCs); // regression on peaks only
  const regPts = [
    { x: peakTs[0]                   ?? 0, y: reg.m * (peakTs[0] ?? 0)                    + reg.b },
    { x: peakTs[peakTs.length - 1]   ?? 0, y: reg.m * (peakTs[peakTs.length - 1] ?? 0)   + reg.b },
  ];

  el('eqC').textContent = 'Regression (peaks): ' + fmtEq(reg, 't', 'I');

  const step = Math.max(1, Math.floor(times.length / 900));
  const T = [], C = [], RC = [];
  for (let i = 0; i < times.length; i += step) {
    T.push(+times[i].toFixed(2));
    C.push(+currSafe[i].toFixed(2));
    RC.push(+rollC[i].toFixed(2));
  }
  const scatter = peakIdxAll.map(i => ({ x: +times[i].toFixed(2), y: +currSafe[i].toFixed(2) }));

  CHARTS.c = new Chart(el('chartC'), {
    data: {
      labels: T,
      datasets: [
        {
          label: 'Raw current',
          type: 'line', data: C, yAxisID: 'y',
          borderColor: 'rgba(59,130,246,0.25)', borderWidth: 0.8,
          pointRadius: 0, fill: false, tension: 0.04, order: 4,
        },
        {
          label: 'Rolling mean',
          type: 'line', data: RC, yAxisID: 'y',
          borderColor: YETI_BLUE, borderWidth: 2.5,
          pointRadius: 0, fill: false, tension: 0.1, order: 3,
        },
        {
          label: 'Peak scatter',
          type: 'scatter', data: scatter, yAxisID: 'y',
          backgroundColor: 'rgba(249,115,22,0.65)',
          pointRadius: 3, pointHoverRadius: 5, order: 2,
        },
        {
          label: 'Regression',
          type: 'line', data: regPts, yAxisID: 'y',
          borderColor: '#a78bfa', borderWidth: 1.5, borderDash: [6, 4],
          pointRadius: 0, fill: false, order: 1,
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        },
      ],
    },
    options: {
      ...BASE_OPTS,
      scales: {
        ...BASE_OPTS.scales,
        y: {
          ...BASE_OPTS.scales.y, min: 0,
          ticks: { ...BASE_OPTS.scales.y.ticks, color: YETI_BLUE },
          title: { display: true, text: 'A', color: YETI_BLUE, font: { size: 10, family: 'ui-monospace, monospace' } },
        },
      },
    },
    plugins: [hLinePlugin([
      { y: I_BREAKER,  color: 'rgba(249,115,22,0.65)', label: '120A breaker' },
      { y: I_CRITICAL, color: 'rgba(239,68,68,0.60)',  label: '160A critical' },
    ])],
  });

  buildToggles('c', CHARTS.c, [
    { label: 'Raw current',  color: 'rgba(59,130,246,0.5)' },
    { label: 'Rolling mean', color: YETI_BLUE },
    { label: 'Peak scatter', color: '#f97316' },
    { label: 'Regression',   color: '#a78bfa' },
  ]);

  CHARTS.c._meta = { times, currSafe, rollC, peakTs, peakCs, reg, regPts, scatter, w };
}

// ── POWER ─────────────────────────────────────────────────────────────────────
function buildPowerChart(res, w) {
  const { times, power, hasCurr, dt } = res;
  if (!hasCurr) return;

  const safePow = power.map(p => isNaN(p) ? 0 : p);
  const rollP   = Array.from(rollingMean(new Float64Array(safePow), w));
  const reg     = linReg(times, safePow);
  const regY    = times.map(t => reg.m * t + reg.b);

  el('eqP').textContent = 'Regression: ' + fmtEq(reg, 't', 'P');

  const step = Math.max(1, Math.floor(times.length / 900));
  const T = [], P = [], RP = [], RG = [];
  for (let i = 0; i < times.length; i += step) {
    T.push(+times[i].toFixed(2));
    P.push(+safePow[i].toFixed(1));
    RP.push(+rollP[i].toFixed(1));
    RG.push(+regY[i].toFixed(1));
  }

  CHARTS.p = new Chart(el('chartP'), {
    data: {
      labels: T,
      datasets: [
        {
          label: 'Raw power',
          type: 'line', data: P, yAxisID: 'y',
          borderColor: 'rgba(167,139,250,0.25)', borderWidth: 0.8,
          pointRadius: 0, fill: false, tension: 0.04, order: 3,
        },
        {
          label: 'Rolling mean',
          type: 'line', data: RP, yAxisID: 'y',
          borderColor: '#a78bfa', borderWidth: 2.5,
          pointRadius: 0, fill: false, tension: 0.1, order: 2,
        },
        {
          label: 'Regression',
          type: 'line', data: RG, yAxisID: 'y',
          borderColor: '#34d399', borderWidth: 1.5, borderDash: [6, 4],
          pointRadius: 0, fill: false, tension: 0, order: 1,
        },
      ],
    },
    options: {
      ...BASE_OPTS,
      scales: {
        ...BASE_OPTS.scales,
        y: {
          ...BASE_OPTS.scales.y, min: 0,
          ticks: { ...BASE_OPTS.scales.y.ticks, color: '#a78bfa' },
          title: { display: true, text: 'W', color: '#a78bfa', font: { size: 10, family: 'ui-monospace, monospace' } },
        },
      },
    },
    plugins: [hLinePlugin([
      { y: 1500, color: 'rgba(249,115,22,0.50)', label: '1500W warn' },
    ])],
  });

  buildToggles('p', CHARTS.p, [
    { label: 'Raw power',    color: 'rgba(167,139,250,0.5)' },
    { label: 'Rolling mean', color: '#a78bfa' },
    { label: 'Regression',  color: '#34d399' },
  ]);

  CHARTS.p._meta = { times, safePow, rollP, regY, reg, w };
}

// ── IMPEDANCE ─────────────────────────────────────────────────────────────────
function buildImpedanceChart(res, w) {
  const { impSamples } = res;
  if (!impSamples.length) return;

  const iT    = impSamples.map(s => s.t);
  const iR    = impSamples.map(s => s.Rmohm);
  const iV    = impSamples.map(s => s.v);
  const rollI = Array.from(rollingMedian(new Float64Array(iR), Math.max(1, w)));
  const reg   = linReg(iT, iR);
  const regY  = iT.map(t => reg.m * t + reg.b);

  el('eqI').textContent = 'Regression: ' + fmtEq(reg, 't', 'R(mΩ)');

  const barColors = iR.map(r =>
    r < 18 ? 'rgba(52,211,153,0.60)'   // green — good
  : r < 28 ? 'rgba(251,191,36,0.65)'   // amber — wear
           : 'rgba(239,68,68,0.70)'    // red — replace
  );

  const vScatter = impSamples.map(s => ({ x: +s.t.toFixed(2), y: +s.v.toFixed(4) }));
  const maxR = Math.min(100, Math.max(...iR) * 1.15);

  CHARTS.i = new Chart(el('chartI'), {
    data: {
      labels: iT.map(t => +t.toFixed(2)),
      datasets: [
        {
          label: 'Impedance (mΩ)',
          type: 'bar', data: iR, yAxisID: 'yR',
          backgroundColor: barColors, borderWidth: 0,
          barPercentage: 1.4, categoryPercentage: 1.4, order: 4,
        },
        {
          label: 'Rolling median',
          type: 'line', data: rollI, yAxisID: 'yR',
          borderColor: '#fbbf24', borderWidth: 2.5,
          pointRadius: 0, fill: false, tension: 0.3, order: 3,
        },
        {
          label: 'Regression',
          type: 'line', data: regY, yAxisID: 'yR',
          borderColor: '#34d399', borderWidth: 1.5, borderDash: [6, 4],
          pointRadius: 0, fill: false, tension: 0, order: 2,
        },
        {
          label: 'Voltage @ peaks',
          type: 'scatter', data: vScatter, yAxisID: 'yV',
          backgroundColor: 'rgba(59,130,246,0.45)',
          pointRadius: 3, pointHoverRadius: 5, order: 1,
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        },
      ],
    },
    options: {
      ...BASE_OPTS,
      scales: {
        x: {
          ticks: { color: '#64748b', font: { family: 'ui-monospace, monospace', size: 10 }, maxTicksLimit: 12 },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
        yR: {
          position: 'left', min: 0, max: maxR,
          ticks: { color: '#fbbf24', font: { family: 'ui-monospace, monospace', size: 10 } },
          grid: { color: 'rgba(255,255,255,0.04)' },
          title: { display: true, text: 'mΩ', color: '#fbbf24', font: { size: 10, family: 'ui-monospace, monospace' } },
        },
        yV: {
          position: 'right',
          ticks: { color: 'rgba(59,130,246,0.8)', font: { family: 'ui-monospace, monospace', size: 10 } },
          grid: { display: false },
          title: { display: true, text: 'V @ peak', color: 'rgba(59,130,246,0.8)', font: { size: 10, family: 'ui-monospace, monospace' } },
        },
      },
    },
    plugins: [hLinePlugin([
      { y: 28, scaleId: 'yR', color: 'rgba(249,115,22,0.55)', label: '28mΩ replace' },
    ])],
  });

  buildToggles('i', CHARTS.i, [
    { label: 'Impedance (mΩ)', color: '#fbbf24' },
    { label: 'Rolling median', color: '#fbbf24' },
    { label: 'Regression',    color: '#34d399' },
    { label: 'Voltage @ peaks', color: YETI_BLUE },
  ]);

  CHARTS.i._meta = { iT, iR, iV, rollI, regY, reg, w };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. TOGGLE & SLIDER WIRING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build toggle buttons for a chart section.
 * Each dataset gets a button; clicking it hides/shows that series.
 */
function buildToggles(sectionKey, chart, series) {
  const container = el(`${sectionKey}Toggles`);
  container.innerHTML = '';
  series.forEach((s, dsIdx) => {
    const btn = document.createElement('button');
    btn.className  = 'tog-btn on';
    btn.textContent = s.label;
    btn.style.setProperty('--tog-color', s.color);
    btn.style.background = s.color;
    btn.onclick = () => {
      const isOn = btn.classList.toggle('on');
      chart.data.datasets[dsIdx].hidden = !isOn;
      if (isOn) {
        btn.style.background = s.color;
        btn.style.color = '#0f172a';
      } else {
        btn.style.background = 'transparent';
        btn.style.color = '#64748b';
      }
      chart.update('none');
    };
    container.appendChild(btn);
  });
}

/**
 * Wires all four range sliders to live-update their respective charts.
 */
function wireSliders(res) {
  const wire = (sliderId, lblId, chartKey, updateFn) => {
    const slider = el(sliderId);
    const lbl    = el(lblId);
    const fmt    = w => `${+(w * res.dt).toFixed(2)}s`;
    lbl.textContent = fmt(slider.value);
    slider.oninput  = () => {
      const w = Math.max(1, Math.round(+slider.value));
      lbl.textContent = fmt(w);
      updateFn(w);
    };
  };

  wire('sliderV', 'sliderVLbl', 'v', w => updateVoltageRoll(res, w));
  wire('sliderC', 'sliderCLbl', 'c', w => updateCurrentRoll(res, w));
  wire('sliderP', 'sliderPLbl', 'p', w => updatePowerRoll(res, w));
  wire('sliderI', 'sliderILbl', 'i', w => updateImpedanceRoll(res, w));
}

function updateVoltageRoll(res, w) {
  if (!CHARTS.v) return;
  const rollV = Array.from(rollingMin(new Float64Array(res.volts), w));
  const step  = Math.max(1, Math.floor(res.times.length / 900));
  const RV    = [];
  for (let i = 0; i < res.times.length; i += step) RV.push(+rollV[i].toFixed(4));
  CHARTS.v.data.datasets[1].data = RV;
  CHARTS.v.update('none');
  CHARTS.v._meta.rollV = rollV;
  CHARTS.v._meta.w     = w;
}

function updateCurrentRoll(res, w) {
  if (!CHARTS.c || !res.hasCurr) return;
  const rollC = Array.from(rollingMean(new Float64Array(res.currSafe), w));
  const step  = Math.max(1, Math.floor(res.times.length / 900));
  const RC    = [];
  for (let i = 0; i < res.times.length; i += step) RC.push(+rollC[i].toFixed(2));
  CHARTS.c.data.datasets[1].data = RC;
  CHARTS.c.update('none');
  CHARTS.c._meta.rollC = rollC;
  CHARTS.c._meta.w     = w;
}

function updatePowerRoll(res, w) {
  if (!CHARTS.p || !res.hasCurr) return;
  const safePow = res.power.map(p => isNaN(p) ? 0 : p);
  const rollP   = Array.from(rollingMean(new Float64Array(safePow), w));
  const step    = Math.max(1, Math.floor(res.times.length / 900));
  const RP      = [];
  for (let i = 0; i < res.times.length; i += step) RP.push(+rollP[i].toFixed(1));
  CHARTS.p.data.datasets[1].data = RP;
  CHARTS.p.update('none');
  CHARTS.p._meta.rollP = rollP;
  CHARTS.p._meta.w     = w;
}

function updateImpedanceRoll(res, w) {
  if (!CHARTS.i || !res.impSamples.length) return;
  const iR    = res.impSamples.map(s => s.Rmohm);
  const rollI = Array.from(rollingMedian(new Float64Array(iR), Math.max(1, w)));
  CHARTS.i.data.datasets[1].data = rollI;
  CHARTS.i.update('none');
  CHARTS.i._meta.rollI = rollI;
  CHARTS.i._meta.w     = w;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. CSV EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called by the "Export CSV" buttons in the Astro template.
 * Exported as a global so the onclick attributes can call it.
 */
function downloadCSV(section) {
  let rows = [], header = '';

  if (section === 'voltage' && CHARTS.v?._meta) {
    const { times, volts, rollV, regY } = CHARTS.v._meta;
    header = 'time_s,voltage_V,rolling_min_V,regression_V';
    rows   = times.map((t, i) =>
      `${t.toFixed(3)},${volts[i].toFixed(4)},${rollV[i].toFixed(4)},${regY[i].toFixed(4)}`
    );

  } else if (section === 'current' && CHARTS.c?._meta) {
    const { times, currSafe, rollC, peakTs, peakCs } = CHARTS.c._meta;
    const peakSet = new Set(peakTs.map(t => +t.toFixed(3)));
    header = 'time_s,current_A,rolling_mean_A,is_peak';
    rows   = times.map((t, i) =>
      `${t.toFixed(3)},${currSafe[i].toFixed(2)},${rollC[i].toFixed(2)},${peakSet.has(+t.toFixed(3)) ? 1 : 0}`
    );

  } else if (section === 'power' && CHARTS.p?._meta) {
    const { times, safePow, rollP, regY } = CHARTS.p._meta;
    header = 'time_s,power_W,rolling_mean_W,regression_W';
    rows   = times.map((t, i) =>
      `${t.toFixed(3)},${safePow[i].toFixed(1)},${rollP[i].toFixed(1)},${regY[i].toFixed(1)}`
    );

  } else if (section === 'impedance' && CHARTS.i?._meta) {
    const { iT, iR, iV, rollI, regY } = CHARTS.i._meta;
    header = 'time_s,voltage_at_peak_V,impedance_mohm,rolling_median_mohm,regression_mohm';
    rows   = iT.map((t, i) =>
      `${t.toFixed(3)},${iV[i].toFixed(4)},${iR[i].toFixed(3)},${(rollI[i]||0).toFixed(3)},${regY[i].toFixed(3)}`
    );
  }

  if (!rows.length) { alert('No data to export yet.'); return; }

  const csv  = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `yeti_battery_${section}.csv`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. STAT CARD RENDERER
// ─────────────────────────────────────────────────────────────────────────────

const f2  = v => isNaN(v) || v == null ? '—' : (+v).toFixed(2);
const f1  = v => isNaN(v) || v == null ? '—' : (+v).toFixed(1);
const f0  = v => isNaN(v) || v == null ? '—' : Math.round(+v).toString();
const cls = (v, g, y) => v == null || isNaN(v) ? '' : v <= g ? 'g' : v <= y ? 'y' : 'r';

function statCard(label, value, unit, note, colorClass) {
  return `<div class="stat-card ${colorClass}">
    <div class="text-xs font-mono text-slate-500 uppercase tracking-wider mb-2">${label}</div>
    <div class="text-2xl font-bold font-mono text-white leading-none">
      ${value}<span class="text-sm font-normal text-slate-400 ml-1">${unit}</span>
    </div>
    <div class="text-xs text-slate-500 mt-1.5 leading-snug">${note}</div>
  </div>`;
}

function renderStats(res) {
  const { vMin, vMax, vMean, nBrown, nCan, nMotor, socStart, socEnd, dt, n,
          cMax, cMean, cP90, cP99, nOver120, nOver160,
          pMax, pMean, totalWh,
          medR, p10R, p90R, p97R, ccaEst, hasCurr, score,
          impSamples } = res;

  // ── Voltage stats ────────────────────────────────────────────────────────
  el('vStats').innerHTML =
    statCard('Min voltage',    f2(vMin),               'V',  'Lowest single sample',        cls(vMin, 8.5, 7.5) === 'g' ? 'g' : vMin >= 7.5 ? 'y' : 'r') +
    statCard('OCV estimate',   f2(res.ocv),             'V',  'Top-3% sample average',       'b') +
    statCard('Mean voltage',   f2(vMean),               'V',  'Average across log',          vMean >= 11 ? 'g' : vMean >= 10 ? 'y' : 'r') +
    statCard('< 8.5V time',    f2(nMotor * dt),         's',  `${(nMotor/n*100).toFixed(1)}% — motor torque loss`, nMotor === 0 ? 'g' : nMotor < 50 ? 'y' : 'r') +
    statCard('< 6.3V time',    f2(nBrown * dt),         's',  `${(nBrown/n*100).toFixed(2)}% — radio brownout`,   nBrown === 0 ? 'g' : 'r') +
    statCard('SOC start→end',  `${f0(socStart)}→${f0(socEnd)}`, '%', 'Estimated charge change', socEnd >= 50 ? 'g' : socEnd >= 30 ? 'y' : 'r') +
    statCard('Health score',   score,                   '/100','Composite battery health',   score >= 75 ? 'g' : score >= 50 ? 'y' : 'r');

  // ── Current stats ────────────────────────────────────────────────────────
  if (hasCurr) {
    el('noCurrentMsg').classList.add('hidden');
    el('cStats').innerHTML =
      statCard('Peak current',  f1(cMax),          'A', 'Highest single sample',    cMax < 120 ? 'g' : cMax < 160 ? 'y' : 'r') +
      statCard('Mean current',  f1(cMean),         'A', 'Average demand',           cMean < 60 ? 'g' : cMean < 90 ? 'y' : 'r') +
      statCard('P90 current',   f1(cP90),          'A', '90th percentile',          cP90 < 80 ? 'g' : cP90 < 120 ? 'y' : 'r') +
      statCard('P99 current',   f1(cP99),          'A', '99th percentile',          cP99 < 120 ? 'g' : cP99 < 160 ? 'y' : 'r') +
      statCard('> 120A time',   f2(nOver120 * dt), 's', `${nOver120} samples above main breaker`, nOver120 === 0 ? 'g' : nOver120 < 20 ? 'y' : 'r') +
      statCard('> 160A time',   f2(nOver160 * dt), 's', `${nOver160} samples critical`,           nOver160 === 0 ? 'g' : 'r');
  } else {
    el('noCurrentMsg').classList.remove('hidden');
    el('cStats').innerHTML = '';
  }

  // ── Power stats ──────────────────────────────────────────────────────────
  if (hasCurr) {
    el('noPowerMsg').classList.add('hidden');
    const pctCap = totalWh / BATT_CAPACITY_WH * 100;
    el('pStats').innerHTML =
      statCard('Peak power',    f0(pMax),          'W',  'Highest instantaneous',          pMax < 2000 ? 'g' : pMax < 3000 ? 'y' : 'r') +
      statCard('Mean power',    f0(pMean),         'W',  'Average demand',                 pMean < 800 ? 'g' : pMean < 1200 ? 'y' : 'r') +
      statCard('Total energy',  f2(totalWh),       'Wh', `${f1(pctCap)}% of 216 Wh capacity`, pctCap < 50 ? 'g' : pctCap < 70 ? 'y' : 'r') +
      statCard('Remaining',     f2(Math.max(0, BATT_CAPACITY_WH - totalWh)), 'Wh', 'Estimated remaining', pctCap < 50 ? 'g' : pctCap < 70 ? 'y' : 'r') +
      statCard('Matches left',  f1(Math.max(0, (BATT_CAPACITY_WH - totalWh) / Math.max(1, totalWh))), '×', 'At this usage rate', '');
  } else {
    el('noPowerMsg').classList.remove('hidden');
    el('pStats').innerHTML = '';
  }

  // ── Impedance stats ──────────────────────────────────────────────────────
  // Condition bands
  const bands = [
    { label: '< 10 mΩ  New',       color: 'text-emerald-400', bg: 'bg-emerald-900/20 border-emerald-700/40' },
    { label: '10–18 mΩ  Good',     color: 'text-green-400',   bg: 'bg-green-900/20   border-green-700/40'   },
    { label: '18–28 mΩ  Wear',     color: 'text-amber-400',   bg: 'bg-amber-900/20   border-amber-700/40'   },
    { label: '28–40 mΩ  Replace',  color: 'text-orange-400',  bg: 'bg-orange-900/20  border-orange-700/40'  },
    { label: '> 40 mΩ   Critical', color: 'text-red-400',     bg: 'bg-red-900/20     border-red-700/40'     },
  ];
  el('impBands').innerHTML = bands.map(b =>
    `<span class="text-xs font-mono px-3 py-1 rounded-md border ${b.bg} ${b.color}">${b.label}</span>`
  ).join('');

  if (impSamples.length > 3) {
    el('noImpedanceMsg').classList.add('hidden');
    el('iStats').innerHTML =
      statCard('P10 impedance',   f1(p10R),      'mΩ', 'Best-case (light load)',    'g') +
      statCard('Median R',        f1(medR),      'mΩ', 'Representative value',     medR <= 18 ? 'g' : medR <= 28 ? 'y' : 'r') +
      statCard('P90 impedance',   f1(p90R),      'mΩ', 'Under heavy current',      p90R <= 25 ? 'g' : p90R <= 40 ? 'y' : 'r') +
      statCard('P97 spike',       f1(p97R),      'mΩ', 'Worst transient',          p97R <= 40 ? 'g' : p97R <= 60 ? 'y' : 'r') +
      statCard('Spike factor',    f1(medR > 0 ? p90R / medR : NaN), '×', 'P90 / Median',  medR > 0 && p90R / medR <= 2 ? 'g' : medR > 0 && p90R / medR <= 3.5 ? 'y' : 'r') +
      statCard('Est. CCA',        f0(ccaEst),    'A',  '7.2Ω / R_median empirical', !isNaN(ccaEst) && ccaEst >= 400 ? 'g' : !isNaN(ccaEst) && ccaEst >= 260 ? 'y' : 'r') +
      statCard('R samples',       impSamples.length, '', 'I > 15A peak samples used', 'b');
  } else {
    el('noImpedanceMsg').classList.remove('hidden');
    el('iStats').innerHTML = '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. SCROLL SPY
// ─────────────────────────────────────────────────────────────────────────────

function initScrollSpy() {
  const sections = ['sec-voltage', 'sec-current', 'sec-power', 'sec-impedance'];
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        document.querySelectorAll('.nav-link').forEach(a => {
          a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id);
        });
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px' });

  sections.forEach(id => {
    const el2 = document.getElementById(id);
    if (el2) obs.observe(el2);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. DEMO DATA GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

function generateDemoData() {
  const data = [];
  let soc = 0.91, t = 0;
  const push = (en, au, load) => {
    const imp = 0.013 + (1 - soc) * 0.030 + (Math.random() - 0.5) * 0.004;
    const v   = Math.max(6.1, 12.6 * soc - load * imp + (Math.random() - 0.5) * 0.07);
    const c   = Math.max(0, load + (Math.random() - 0.5) * 5);
    data.push({ t: +t.toFixed(3), v: +v.toFixed(4), c: +c.toFixed(2), enabled: en, auto: au });
    soc -= load * 1e-7;
    t   += 0.02;
  };
  for (let i = 0; i < 250;  i++) push(false, false, 7 + Math.random() * 4);
  for (let i = 0; i < 750;  i++) {
    const l = 75 + Math.sin(i * 0.2) * 40 + (Math.random() < 0.08 ? 140 : 0) + Math.random() * 10;
    push(true, true, l);
  }
  for (let i = 0; i < 6750; i++) {
    const spike = Math.random() < 0.05 ? 155 + Math.random() * 65 : 0;
    const l     = 52 + Math.sin(i * 0.055) * 35 + Math.sin(i * 0.22) * 18 + spike + Math.random() * 12;
    push(true, false, l);
  }
  for (let i = 0; i < 250;  i++) push(false, false, 5 + Math.random() * 3);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. DOM WIRING — ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/** Shorthand querySelector */
function el(id) { return document.getElementById(id); }

function setLoading(msg) {
  const overlay = el('loadOverlay');
  if (msg) {
    overlay.classList.remove('hidden');
    el('loadMsg').textContent = msg;
  } else {
    overlay.classList.add('hidden');
  }
}

function showAnalysis(fileName) {
  el('landing').classList.add('hidden');
  el('analysisPage').classList.remove('hidden');
  if (fileName) {
    const badge = el('fileNameBadge');
    badge.textContent = fileName;
    badge.classList.remove('hidden');
  }
}

function showLanding() {
  el('analysisPage').classList.add('hidden');
  el('landing').classList.remove('hidden');
  el('fileInput').value = '';
  el('swapInput').value = '';
}

/**
 * Run the full pipeline: parse → analyze → render.
 */
async function runFile(file) {
  setLoading('Parsing log…');
  try {
    const samples = await parseDSLog(file);
    if (!samples || samples.length < 20) {
      throw new Error('Could not extract valid voltage data. Check that your file is a .dslog binary or CSV with a voltage column.');
    }
    setLoading('Analyzing…');
    await new Promise(r => setTimeout(r, 40)); // yield for UI update
    const res = analyze(samples);
    renderStats(res);
    const defaultWindows = { v: 5, c: 5, p: 25, i: 25 };
    buildCharts(res, defaultWindows);
    wireSliders(res);
    setLoading('');
    showAnalysis(file?.name);
    // Store for CSV and slider updates
    window._battRes = res;
  } catch (err) {
    setLoading('');
    alert('Analysis failed: ' + err.message);
  }
}

/**
 * Public entry point — called by the Astro page's <script> tag.
 */
export function initBatteryAnalyzer() {
  // Expose downloadCSV as a global so Astro's onclick attributes can call it
  window.downloadCSV = downloadCSV;

  // File input on landing page
  el('fileInput').addEventListener('change', e => {
    if (e.target.files[0]) runFile(e.target.files[0]);
  });

  // Drag and drop on landing card
  const card = el('dropCard');
  card.addEventListener('dragover', e => {
    e.preventDefault();
    card.classList.add('border-yeti-blue');
  });
  card.addEventListener('dragleave', () => card.classList.remove('border-yeti-blue'));
  card.addEventListener('drop', e => {
    e.preventDefault();
    card.classList.remove('border-yeti-blue');
    if (e.dataTransfer.files[0]) runFile(e.dataTransfer.files[0]);
  });

  // Demo button
  el('demoBtn').addEventListener('click', () => {
    setLoading('Generating demo data…');
    setTimeout(() => {
      const samples = generateDemoData();
      setLoading('Analyzing…');
      setTimeout(() => {
        const res = analyze(samples);
        renderStats(res);
        buildCharts(res, { v: 5, c: 5, p: 25, i: 25 });
        wireSliders(res);
        setLoading('');
        showAnalysis('demo_match.dslog');
        window._battRes = res;
      }, 40);
    }, 40);
  });

  // New file / swap file
  el('newFileBtn').addEventListener('click', () => {
    destroyCharts();
    showLanding();
  });
  el('swapInput').addEventListener('change', e => {
    if (e.target.files[0]) runFile(e.target.files[0]);
  });

  // Scroll spy
  initScrollSpy();
}
