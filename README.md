# YETI Battery Analyzer — Integration Guide

Drop-in tool for the YETI Robotics Astro website.  
Parses `.dslog` binary files or DS Log CSV exports and produces four scrollable
analysis sections: Voltage, Current, Power, and Impedance.

---

## Files to add

```
your-astro-site/
└── src/
    ├── pages/
    │   └── battery-analyzer.astro   ← the page (add this)
    └── lib/
        └── batteryAnalyzer.js       ← all JS logic (add this)
```

Also check `tailwind.config.mjs` — ensure `yeti-blue: '#3b82f6'` is present in
`theme.extend.colors`. The template diff is in `tailwind.config.mjs` in this folder.

---

## Steps

```bash
# 1. Copy files into your project
cp battery-analyzer.astro  <your-site>/src/pages/
cp batteryAnalyzer.js      <your-site>/src/lib/

# 2. Make sure your Layout.astro accepts a `title` prop (all YETI templates do)

# 3. Confirm tailwind.config.mjs has yeti-blue defined (see tailwind.config.mjs)

# 4. Run dev server
pnpm dev   # or npm run dev
# → open http://localhost:4321/battery-analyzer
```

---

## What the page does

| Section | What it shows | Rolling window |
|---|---|---|
| **① Voltage** | DS log terminal voltage | 0.1–5 s rolling minimum |
| **② Current** | Robot current from DS log | 0.1–5 s rolling mean |
| **③ Power** | P = V × I | 0.02–5 s rolling mean |
| **④ Impedance** | R = (V_oc − V) / I at current peaks | 0.02–5 s rolling median |

Each section has:
- **Toggleable series** — click a legend pill to show/hide raw, rolling, regression, or scatter
- **Live rolling slider** — 0.1 s to 5 s, recomputes instantly without a full redraw
- **Regression equation** — `y = m·t + b, R² = ...` displayed above each chart
- **Export CSV** — downloads a `.csv` with all computed columns for that section

---

## Data sources

**Voltage** — always from the DS log `Battery Voltage` column (or binary decode).

**Current** — from the DS log `Robot Current` column when available.  
Enable it in DS Log File Viewer: select your log → export with Robot Current checked.  
Without current, the Current / Power / Impedance sections show a warning banner
instead of charts.

**Impedance** — computed as `R = (V_oc − V) / I` at every current peak where I > 15 A.  
OCV is estimated as the mean of the top 3% of voltage samples.

---

## File formats accepted

| Format | Notes |
|---|---|
| `.dslog` binary | Stride-based decode, tries 6 different stride/offset combinations |
| `.csv` from DS Log Viewer | Auto-detects delimiter (`,` `\t` `;`), header row, column names |
| Any tab/semicolon-delimited text | Column detection by keyword match, then value-range fallback |

---

## Architecture

```
battery-analyzer.astro      HTML structure only — no JS logic
     ↓ imports
batteryAnalyzer.js           All analysis, charting, and interactivity
  ├── parseDSLog()           File parsing (binary + text)
  ├── analyze()              Rolling windows, regression, impedance, stats
  ├── buildCharts()          Chart.js rendering
  ├── wireSliders()          Live slider → rolling window update
  ├── downloadCSV()          Per-section CSV export
  └── initBatteryAnalyzer()  Entry point wired to DOM
```

The `.astro` page never contains logic — it is pure HTML/Tailwind markup that
calls `initBatteryAnalyzer()` via a single `<script type="module">` import.
This keeps the code readable and traceable: every calculation lives in
`batteryAnalyzer.js`, clearly commented with the FRC-specific rationale.

---

## Dependencies

- **Chart.js 4.4.1** — loaded from cdnjs CDN in the `.astro` file (no npm install needed)
- **Tailwind CSS** — already in your YETI template
- **Astro** — already in your YETI template

No other dependencies. No React, no Vue, no build step beyond what Astro already does.
