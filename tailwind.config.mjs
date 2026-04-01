/**
 * tailwind.config.mjs  — YETI color token addition
 * ─────────────────────────────────────────────────────────────────────────────
 * Add the `yeti-blue` color token to your existing Astro-Template config.
 * Your template already has Tailwind + some YETI colors; this diff shows
 * exactly what to merge in.
 *
 * If your config already defines `yeti-blue`, you're done — no changes needed.
 *
 * BEFORE (typical Astro-Template tailwind.config.mjs):
 * ──────────────────────────────────────────────────────
 * import defaultTheme from 'tailwindcss/defaultTheme';
 *
 * export default {
 *   content: ['./src/**\/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
 *   theme: {
 *     extend: {
 *       colors: {
 *         // ... existing YETI colors ...
 *       },
 *     },
 *   },
 *   plugins: [],
 * };
 *
 *
 * AFTER — merge this into theme.extend.colors:
 * ──────────────────────────────────────────────────────
 */

import defaultTheme from 'tailwindcss/defaultTheme';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],

  theme: {
    extend: {
      colors: {
        // ── YETI brand tokens ─────────────────────────────────────────────
        // These are used throughout the battery analyzer and should already
        // be present in the YETI Astro-Template. Add any that are missing.

        'yeti-blue': '#3b82f6',   // Tailwind blue-500 — primary accent

        // Optionally add these shades if your design system uses them:
        // 'yeti-blue-light': '#60a5fa',  // blue-400
        // 'yeti-blue-dark':  '#2563eb',  // blue-600
      },

      fontFamily: {
        // Keep whatever font stack the template already defines.
        // The analyzer uses `font-mono` (ui-monospace) for numbers/labels
        // and `font-sans` (your template's body font) for prose.
        sans:  ['Inter', ...defaultTheme.fontFamily.sans],
        mono:  ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', ...defaultTheme.fontFamily.mono],
      },
    },
  },

  plugins: [],
};
