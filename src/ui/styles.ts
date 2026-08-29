/**
 * @module
 * Base stylesheet for `aio/ui`. Rendered through AIR (not injected via the
 * global document) so it works in SSR and tests. Ships light + dark by default
 * (follows `prefers-color-scheme`).
 *
 * ONE VOCABULARY. The kit's own tokens are `--aio-ui-*`, and each one DEFAULTS
 * to the matching token of the default theme (`--aio-accent`, `--aio-text`,
 * `--aio-border`, …) with the kit's literal as the fallback. So a page that
 * opted into `ui.theme` tints the kit automatically, a page that did not looks
 * exactly as before, and neither can be surprised by the other.
 *
 * They used to share the `--aio-*` namespace with the theme, and two of the
 * shared names MEANT DIFFERENT THINGS: the kit's `--aio-accent-ink` was the ink
 * ON the accent (the theme calls that `--aio-on-accent`), while the theme's
 * `--aio-accent-ink` is the accent AS TEXT on the page. Rendering a kit button
 * on a themed page therefore painted accent-coloured text on an accent fill,
 * and the kit's unlayered `:root` overrode the app's identity hue everywhere.
 * Override `--aio-accent` (theme-wide) or a single `--aio-ui-*` (kit-only).
 * The four names only the kit ever defined (`--aio-radius`, `--aio-ink`,
 * `--aio-ink-soft`, `--aio-line`) are still READ as the first fallback, so an
 * app that reskinned the kit through them keeps its reskin: explicit legacy
 * override > theme token > kit literal.
 */
import { h } from "../air/vdom.ts";
import type { VNode } from "../air/vdom.ts";

/** The kit's base CSS. Exported so you can inline it yourself if preferred. */
export const UI_CSS: string = `
:root {
  --aio-ui-accent: var(--aio-accent, #2860d8);
  --aio-ui-on-accent: var(--aio-on-accent, #ffffff);
  --aio-ui-bg: var(--aio-surface, #ffffff);
  --aio-ui-surface: var(--aio-surface-2, #f6f7f9);
  --aio-ui-ink: var(--aio-ink, var(--aio-text, #14181f));
  --aio-ui-ink-soft: var(--aio-ink-soft, var(--aio-muted, #55606f));
  --aio-ui-line: var(--aio-line, var(--aio-border, #e2e6ec));
  --aio-ui-danger: var(--aio-danger, #d3364a);
  --aio-ui-radius: var(--aio-radius, var(--aio-r-2, 8px));
  --aio-ui-font: var(--aio-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
}
@media (prefers-color-scheme: dark) {
  :root {
    --aio-ui-accent: var(--aio-accent, #5a9bff);
    --aio-ui-on-accent: var(--aio-on-accent, #0f121b);
    --aio-ui-bg: var(--aio-surface, #12151f);
    --aio-ui-surface: var(--aio-surface-2, #1a1f2e);
    --aio-ui-ink: var(--aio-ink, var(--aio-text, #e7eaf1));
    --aio-ui-ink-soft: var(--aio-ink-soft, var(--aio-muted, #97a1b5));
    --aio-ui-line: var(--aio-line, var(--aio-border, #2a3040));
    --aio-ui-danger: var(--aio-danger, #ff6b78);
  }
}

.aio-btn {
  font: inherit; font-family: var(--aio-ui-font); font-weight: 550;
  border: 1px solid transparent; border-radius: var(--aio-ui-radius);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  gap: 0.4em; line-height: 1; white-space: nowrap; transition: background .12s, border-color .12s, opacity .12s;
}
.aio-btn:disabled { opacity: .5; cursor: not-allowed; }
.aio-btn:focus-visible { outline: 2px solid var(--aio-ui-accent); outline-offset: 2px; }
.aio-btn--sm { padding: .4em .7em; font-size: .82rem; }
.aio-btn--md { padding: .55em .95em; font-size: .92rem; }
.aio-btn--lg { padding: .7em 1.2em; font-size: 1rem; }
.aio-btn--primary { background: var(--aio-ui-accent); color: var(--aio-ui-on-accent); }
.aio-btn--primary:hover:not(:disabled) { filter: brightness(1.07); }
.aio-btn--secondary { background: var(--aio-ui-surface); color: var(--aio-ui-ink); border-color: var(--aio-ui-line); }
.aio-btn--secondary:hover:not(:disabled) { border-color: var(--aio-ui-accent); }
.aio-btn--ghost { background: transparent; color: var(--aio-ui-ink); }
.aio-btn--ghost:hover:not(:disabled) { background: var(--aio-ui-surface); }
.aio-btn--danger { background: var(--aio-ui-danger); color: #fff; }
.aio-btn--danger:hover:not(:disabled) { filter: brightness(1.07); }

.aio-input {
  font: inherit; font-family: var(--aio-ui-font); color: var(--aio-ui-ink);
  background: var(--aio-ui-bg); border: 1px solid var(--aio-ui-line);
  border-radius: var(--aio-ui-radius); padding: .55em .7em; width: 100%;
  transition: border-color .12s, box-shadow .12s;
}
.aio-input::placeholder { color: var(--aio-ui-ink-soft); opacity: .7; }
.aio-input:focus { outline: none; border-color: var(--aio-ui-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--aio-ui-accent) 22%, transparent); }
.aio-input:disabled { opacity: .55; cursor: not-allowed; }
.aio-input--invalid { border-color: var(--aio-ui-danger); }
.aio-input--invalid:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--aio-ui-danger) 22%, transparent); }
.aio-textarea { resize: vertical; min-height: 2.5em; }
.aio-select { appearance: auto; }

.aio-checkbox { width: 1rem; height: 1rem; accent-color: var(--aio-ui-accent); }
.aio-checkbox-row { display: inline-flex; align-items: center; gap: .5em; cursor: pointer; color: var(--aio-ui-ink); }

.aio-field { display: flex; flex-direction: column; gap: .35em; margin-bottom: .9em; }
.aio-field__label { font-size: .82rem; font-weight: 550; color: var(--aio-ui-ink); font-family: var(--aio-ui-font); }
.aio-field__req { color: var(--aio-ui-danger); }
.aio-field__hint { font-size: .78rem; color: var(--aio-ui-ink-soft); }
.aio-field__error { font-size: .78rem; color: var(--aio-ui-danger); }

.aio-table { border-collapse: collapse; width: 100%; font-family: var(--aio-ui-font); color: var(--aio-ui-ink); font-size: .92rem; }
.aio-th { text-align: start; font-weight: 600; font-size: .76rem; letter-spacing: .04em; text-transform: uppercase; color: var(--aio-ui-ink-soft); padding: .55em .7em; border-bottom: 1px solid var(--aio-ui-line); }
.aio-td { padding: .55em .7em; border-bottom: 1px solid var(--aio-ui-line); }
.aio-tr--click { cursor: pointer; }
.aio-tr--click:hover { background: var(--aio-ui-surface); }
.aio-table__empty { text-align: center; color: var(--aio-ui-ink-soft); padding: 1.4em; }

.aio-card { background: var(--aio-ui-bg); border: 1px solid var(--aio-ui-line); border-radius: calc(var(--aio-ui-radius) + 2px); overflow: hidden; }
.aio-card__title { padding: .8em 1em; border-bottom: 1px solid var(--aio-ui-line); font-weight: 600; color: var(--aio-ui-ink); font-family: var(--aio-ui-font); }
.aio-card__body { padding: 1em; color: var(--aio-ui-ink); }
.aio-card__footer { padding: .7em 1em; border-top: 1px solid var(--aio-ui-line); background: var(--aio-ui-surface); }

.aio-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 1000; }
.aio-modal { background: var(--aio-ui-bg); color: var(--aio-ui-ink); border: 1px solid var(--aio-ui-line); border-radius: calc(var(--aio-ui-radius) + 4px); width: 100%; max-width: 32rem; max-height: 90vh; overflow: auto; box-shadow: 0 12px 40px rgba(0,0,0,.3); }
.aio-modal__title { padding: .9em 1.1em; border-bottom: 1px solid var(--aio-ui-line); font-weight: 600; font-family: var(--aio-ui-font); }
.aio-modal__body { padding: 1.1em; }
.aio-modal__footer { padding: .8em 1.1em; border-top: 1px solid var(--aio-ui-line); background: var(--aio-ui-surface); display: flex; gap: .5em; justify-content: flex-end; }

.aio-spinner { display: inline-block; width: 1em; height: 1em; border: 2px solid var(--aio-ui-line); border-top-color: var(--aio-ui-accent); border-radius: 50%; animation: aio-spin .6s linear infinite; vertical-align: -0.15em; }
@keyframes aio-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .aio-spinner { animation-duration: 1.6s; } }

.aio-avatar { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: #fff; font-family: var(--aio-ui-font); font-weight: 600; overflow: hidden; flex: none; user-select: none; }
.aio-avatar__img { width: 100%; height: 100%; object-fit: cover; display: block; }

.aio-confirm__msg { color: var(--aio-ui-ink); font-family: var(--aio-ui-font); line-height: 1.5; }

.aio-page { display: inline-flex; gap: .25em; font-family: var(--aio-ui-font); }
.aio-page__btn { min-width: 2em; padding: .35em .55em; border: 1px solid var(--aio-ui-line); background: var(--aio-ui-bg); color: var(--aio-ui-ink); border-radius: var(--aio-ui-radius); cursor: pointer; font: inherit; }
.aio-page__btn:hover:not(:disabled) { background: var(--aio-ui-surface); }
.aio-page__btn:disabled { opacity: .45; cursor: default; }
.aio-page__btn--current { background: var(--aio-ui-accent); border-color: var(--aio-ui-accent); color: var(--aio-ui-on-accent); }

.aio-toasts { position: fixed; bottom: 1rem; inset-inline-end: 1rem; display: flex; flex-direction: column; gap: .5em; z-index: 1100; max-width: min(24rem, 90vw); }
.aio-toast { display: flex; align-items: center; gap: .6em; padding: .7em .9em; border-radius: var(--aio-ui-radius); background: var(--aio-ui-bg); color: var(--aio-ui-ink); border: 1px solid var(--aio-ui-line); border-inline-start: 3px solid var(--aio-ui-ink-soft); box-shadow: 0 6px 20px rgba(0,0,0,.18); font-family: var(--aio-ui-font); animation: aio-toast-in .18s ease-out; }
.aio-toast--success { border-inline-start-color: #2f9e5e; }
.aio-toast--warn { border-inline-start-color: #d99117; }
.aio-toast--error { border-inline-start-color: var(--aio-ui-danger); }
.aio-toast__msg { flex: 1; line-height: 1.4; }
.aio-toast__x { border: none; background: none; color: var(--aio-ui-ink-soft); cursor: pointer; font-size: 1.2em; line-height: 1; padding: 0 .1em; }
.aio-toast__x:hover { color: var(--aio-ui-ink); }
@keyframes aio-toast-in { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) { .aio-toast { animation: none; } }

.aio-md { color: var(--aio-ui-ink); font-family: var(--aio-ui-font); line-height: 1.6; }
.aio-md__p { margin: 0 0 .8em; }
.aio-md h1, .aio-md h2, .aio-md h3, .aio-md h4, .aio-md h5, .aio-md h6 { margin: 1.2em 0 .5em; line-height: 1.25; }
.aio-md__a { color: var(--aio-ui-accent); }
.aio-md__code { background: var(--aio-ui-surface); border: 1px solid var(--aio-ui-line); border-radius: 4px; padding: .1em .35em; font-size: .9em; }
.aio-md__pre { background: var(--aio-ui-surface); border: 1px solid var(--aio-ui-line); border-radius: var(--aio-ui-radius); padding: .8em 1em; overflow-x: auto; margin: 0 0 .8em; }
.aio-md__pre code { background: none; border: none; padding: 0; font-size: .9em; }
.aio-md__list { margin: 0 0 .8em; padding-inline-start: 1.4em; }
.aio-md__quote { margin: 0 0 .8em; padding-block: .2em; padding-inline: 1em 0; border-inline-start: 3px solid var(--aio-ui-line); color: var(--aio-ui-ink-soft); }
.aio-md__hr { border: none; border-top: 1px solid var(--aio-ui-line); margin: 1.2em 0; }
.aio-md__img { max-width: 100%; border-radius: var(--aio-ui-radius); }

/* ── controls (alpha72) ─────────────────────────────────────────────
   Every rule below is written in logical properties, so one <html dir="rtl">
   mirrors the whole kit — see tests/rtl-logical-css.test.ts, which fails the
   build if a physical one comes back. */

/* Radio */
.aio-radios { display: flex; flex-direction: column; gap: .45em; }
.aio-radio-row { display: inline-flex; align-items: center; gap: .55em; cursor: pointer; font-family: var(--aio-ui-font); color: var(--aio-ui-ink); }
.aio-radio-row[data-disabled] { opacity: .55; cursor: not-allowed; }
.aio-radio { accent-color: var(--aio-ui-accent); inline-size: 1em; block-size: 1em; }

/* Switch — a real checkbox, painted */
.aio-switch-row { display: inline-flex; align-items: center; gap: .6em; cursor: pointer; font-family: var(--aio-ui-font); color: var(--aio-ui-ink); }
.aio-switch { appearance: none; -webkit-appearance: none; inline-size: 2.4em; block-size: 1.35em; border-radius: 1em; background: var(--aio-ui-line); border: 1px solid var(--aio-ui-line); position: relative; cursor: pointer; flex: none; transition: background-color .15s ease; }
.aio-switch::after { content: ""; position: absolute; inset-block-start: 50%; inset-inline-start: .16em; inline-size: 1em; block-size: 1em; border-radius: 50%; background: #fff; transform: translateY(-50%); transition: inset-inline-start .15s ease; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.aio-switch:checked { background: var(--aio-ui-accent); border-color: var(--aio-ui-accent); }
.aio-switch:checked::after { inset-inline-start: 1.22em; }
.aio-switch:disabled { opacity: .55; cursor: not-allowed; }
@media (prefers-reduced-motion: reduce) { .aio-switch, .aio-switch::after { transition: none; } }
@media (forced-colors: active) { .aio-switch { border: 1px solid CanvasText; } .aio-switch:checked { background: Highlight; } }

/* Tabs */
.aio-tablist { display: flex; gap: .15em; border-block-end: 1px solid var(--aio-ui-line); overflow-x: auto; }
.aio-tab { appearance: none; background: none; border: none; border-block-end: 2px solid transparent; padding: .6em .9em; font: inherit; font-family: var(--aio-ui-font); color: var(--aio-ui-ink-soft); cursor: pointer; white-space: nowrap; }
.aio-tab:hover:not(:disabled) { color: var(--aio-ui-ink); }
.aio-tab--active { color: var(--aio-ui-accent); border-block-end-color: var(--aio-ui-accent); font-weight: 600; }
.aio-tab:disabled { opacity: .45; cursor: not-allowed; }
.aio-tabpanel { padding-block-start: 1em; }
.aio-tabpanel:focus-visible { outline: 2px solid var(--aio-ui-accent); outline-offset: 2px; }

/* Progress */
.aio-progress-row { display: inline-flex; align-items: center; gap: .6em; }
.aio-progress { inline-size: 12rem; block-size: .5em; appearance: none; -webkit-appearance: none; border: none; border-radius: 1em; background: var(--aio-ui-line); overflow: hidden; }
.aio-progress::-webkit-progress-bar { background: var(--aio-ui-line); border-radius: 1em; }
.aio-progress::-webkit-progress-value { background: var(--aio-ui-accent); border-radius: 1em; }
.aio-progress::-moz-progress-bar { background: var(--aio-ui-accent); border-radius: 1em; }
.aio-progress__value { font-family: var(--aio-ui-font); font-size: .85em; color: var(--aio-ui-ink-soft); font-variant-numeric: tabular-nums; }

/* Alert */
.aio-alert { display: flex; align-items: flex-start; gap: .7em; padding: .8em 1em; border-radius: var(--aio-ui-radius); border: 1px solid var(--aio-ui-line); border-inline-start: 3px solid var(--aio-ui-ink-soft); background: var(--aio-ui-surface); color: var(--aio-ui-ink); font-family: var(--aio-ui-font); }
.aio-alert__body { flex: 1; min-inline-size: 0; }
.aio-alert__title { display: block; margin-block-end: .2em; }
.aio-alert__x { appearance: none; background: none; border: none; color: inherit; opacity: .6; cursor: pointer; font-size: 1.15em; line-height: 1; padding: 0 .1em; }
.aio-alert__x:hover { opacity: 1; }
.aio-alert--success { border-inline-start-color: #2f9e5e; }
.aio-alert--warn { border-inline-start-color: #d99117; }
.aio-alert--error { border-inline-start-color: var(--aio-ui-danger); }

/* Tooltip — hover AND focus, both in CSS */
.aio-tip { position: relative; display: inline-flex; }
.aio-tip__bubble { position: absolute; z-index: 1200; inset-inline-start: 50%; transform: translateX(-50%); background: var(--aio-ui-ink); color: var(--aio-ui-bg); font-family: var(--aio-ui-font); font-size: .82em; padding: .35em .6em; border-radius: 4px; white-space: nowrap; opacity: 0; visibility: hidden; transition: opacity .12s ease; pointer-events: none; }
.aio-tip--top .aio-tip__bubble { inset-block-end: calc(100% + .35em); }
.aio-tip--bottom .aio-tip__bubble { inset-block-start: calc(100% + .35em); }
.aio-tip:hover .aio-tip__bubble, .aio-tip:focus-within .aio-tip__bubble { opacity: 1; visibility: visible; }
.aio-tip[data-hidden] .aio-tip__bubble { opacity: 0; visibility: hidden; }
@media (prefers-reduced-motion: reduce) { .aio-tip__bubble { transition: none; } }

/* Menu */
.aio-menu { position: relative; display: inline-flex; }
.aio-menu__trigger { appearance: none; font: inherit; font-family: var(--aio-ui-font); background: var(--aio-ui-bg); color: var(--aio-ui-ink); border: 1px solid var(--aio-ui-line); border-radius: var(--aio-ui-radius); padding: .45em .8em; cursor: pointer; }
.aio-menu__trigger:hover { background: var(--aio-ui-surface); }
.aio-menu__list { position: absolute; z-index: 1200; inset-block-start: calc(100% + .25em); inset-inline-start: 0; min-inline-size: 11rem; background: var(--aio-ui-bg); border: 1px solid var(--aio-ui-line); border-radius: var(--aio-ui-radius); box-shadow: 0 8px 26px rgba(0,0,0,.16); padding: .25em; display: flex; flex-direction: column; }
.aio-menu__item { appearance: none; background: none; border: none; font: inherit; font-family: var(--aio-ui-font); color: var(--aio-ui-ink); text-align: start; padding: .5em .7em; border-radius: calc(var(--aio-ui-radius) - 2px); cursor: pointer; }
.aio-menu__item:hover:not(:disabled), .aio-menu__item:focus-visible { background: var(--aio-ui-surface); }
.aio-menu__item:disabled { opacity: .45; cursor: not-allowed; }
.aio-menu__item--danger { color: var(--aio-ui-danger); }

/* Breadcrumb */
.aio-crumbs { font-family: var(--aio-ui-font); font-size: .9em; }
.aio-crumbs__list { display: flex; flex-wrap: wrap; align-items: center; gap: .4em; list-style: none; margin: 0; padding: 0; }
.aio-crumbs__item { display: inline-flex; align-items: center; gap: .4em; color: var(--aio-ui-ink-soft); }
.aio-crumbs__item [aria-current="page"] { color: var(--aio-ui-ink); font-weight: 600; }
.aio-crumbs__sep { opacity: .5; }

/* Skeleton */
.aio-skel-stack { display: flex; flex-direction: column; gap: .45em; }
.aio-skel { display: block; inline-size: 100%; block-size: 1em; border-radius: 4px; background: linear-gradient(90deg, var(--aio-ui-line) 25%, var(--aio-ui-surface) 37%, var(--aio-ui-line) 63%); background-size: 400% 100%; animation: aio-skel-shimmer 1.4s ease infinite; }
.aio-skel--circle { border-radius: 50%; aspect-ratio: 1; inline-size: 2.5em; block-size: 2.5em; }
@keyframes aio-skel-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
@media (prefers-reduced-motion: reduce) { .aio-skel { animation: none; } }

/* EmptyState */
.aio-empty { display: flex; flex-direction: column; align-items: center; gap: .5em; text-align: center; padding: 2.5em 1.5em; color: var(--aio-ui-ink-soft); font-family: var(--aio-ui-font); }
.aio-empty__icon { font-size: 2rem; opacity: .7; line-height: 1; }
.aio-empty__title { margin: 0; font-weight: 600; color: var(--aio-ui-ink); }
.aio-empty__desc { margin: 0; max-inline-size: 28rem; }
.aio-empty__action { margin-block-start: .5em; }
`.trim();

/** Renders the `aio/ui` base stylesheet. Place once, near your app root.
 *  Rendering through AIR keeps it SSR- and test-safe (no global document). */
export function UiStyles(): VNode {
  return h("style", { "data-aio-ui": "" }, UI_CSS);
}
