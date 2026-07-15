/**
 * @module
 * Base stylesheet for `aio/ui`. Rendered through AIR (not injected via the
 * global document) so it works in SSR and tests. Everything keys off `--aio-*`
 * custom properties — override any of them in your own CSS to reskin. Ships
 * light + dark by default (follows `prefers-color-scheme`).
 */
import { h } from "../air/vdom.ts";
import type { VNode } from "../air/vdom.ts";

/** The kit's base CSS. Exported so you can inline it yourself if preferred. */
export const UI_CSS: string = `
:root {
  --aio-accent: #2860d8;
  --aio-accent-ink: #ffffff;
  --aio-bg: #ffffff;
  --aio-surface: #f6f7f9;
  --aio-ink: #14181f;
  --aio-ink-soft: #55606f;
  --aio-line: #e2e6ec;
  --aio-danger: #d3364a;
  --aio-radius: 8px;
  --aio-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --aio-accent: #5a9bff;
    --aio-accent-ink: #0f121b;
    --aio-bg: #12151f;
    --aio-surface: #1a1f2e;
    --aio-ink: #e7eaf1;
    --aio-ink-soft: #97a1b5;
    --aio-line: #2a3040;
    --aio-danger: #ff6b78;
  }
}

.aio-btn {
  font: inherit; font-family: var(--aio-font); font-weight: 550;
  border: 1px solid transparent; border-radius: var(--aio-radius);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  gap: 0.4em; line-height: 1; white-space: nowrap; transition: background .12s, border-color .12s, opacity .12s;
}
.aio-btn:disabled { opacity: .5; cursor: not-allowed; }
.aio-btn:focus-visible { outline: 2px solid var(--aio-accent); outline-offset: 2px; }
.aio-btn--sm { padding: .4em .7em; font-size: .82rem; }
.aio-btn--md { padding: .55em .95em; font-size: .92rem; }
.aio-btn--lg { padding: .7em 1.2em; font-size: 1rem; }
.aio-btn--primary { background: var(--aio-accent); color: var(--aio-accent-ink); }
.aio-btn--primary:hover:not(:disabled) { filter: brightness(1.07); }
.aio-btn--secondary { background: var(--aio-surface); color: var(--aio-ink); border-color: var(--aio-line); }
.aio-btn--secondary:hover:not(:disabled) { border-color: var(--aio-accent); }
.aio-btn--ghost { background: transparent; color: var(--aio-ink); }
.aio-btn--ghost:hover:not(:disabled) { background: var(--aio-surface); }
.aio-btn--danger { background: var(--aio-danger); color: #fff; }
.aio-btn--danger:hover:not(:disabled) { filter: brightness(1.07); }

.aio-input {
  font: inherit; font-family: var(--aio-font); color: var(--aio-ink);
  background: var(--aio-bg); border: 1px solid var(--aio-line);
  border-radius: var(--aio-radius); padding: .55em .7em; width: 100%;
  transition: border-color .12s, box-shadow .12s;
}
.aio-input::placeholder { color: var(--aio-ink-soft); opacity: .7; }
.aio-input:focus { outline: none; border-color: var(--aio-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--aio-accent) 22%, transparent); }
.aio-input:disabled { opacity: .55; cursor: not-allowed; }
.aio-input--invalid { border-color: var(--aio-danger); }
.aio-input--invalid:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--aio-danger) 22%, transparent); }
.aio-textarea { resize: vertical; min-height: 2.5em; }
.aio-select { appearance: auto; }

.aio-checkbox { width: 1rem; height: 1rem; accent-color: var(--aio-accent); }
.aio-checkbox-row { display: inline-flex; align-items: center; gap: .5em; cursor: pointer; color: var(--aio-ink); }

.aio-field { display: flex; flex-direction: column; gap: .35em; margin-bottom: .9em; }
.aio-field__label { font-size: .82rem; font-weight: 550; color: var(--aio-ink); font-family: var(--aio-font); }
.aio-field__req { color: var(--aio-danger); }
.aio-field__hint { font-size: .78rem; color: var(--aio-ink-soft); }
.aio-field__error { font-size: .78rem; color: var(--aio-danger); }

.aio-table { border-collapse: collapse; width: 100%; font-family: var(--aio-font); color: var(--aio-ink); font-size: .92rem; }
.aio-th { text-align: left; font-weight: 600; font-size: .76rem; letter-spacing: .04em; text-transform: uppercase; color: var(--aio-ink-soft); padding: .55em .7em; border-bottom: 1px solid var(--aio-line); }
.aio-td { padding: .55em .7em; border-bottom: 1px solid var(--aio-line); }
.aio-tr--click { cursor: pointer; }
.aio-tr--click:hover { background: var(--aio-surface); }
.aio-table__empty { text-align: center; color: var(--aio-ink-soft); padding: 1.4em; }

.aio-card { background: var(--aio-bg); border: 1px solid var(--aio-line); border-radius: calc(var(--aio-radius) + 2px); overflow: hidden; }
.aio-card__title { padding: .8em 1em; border-bottom: 1px solid var(--aio-line); font-weight: 600; color: var(--aio-ink); font-family: var(--aio-font); }
.aio-card__body { padding: 1em; color: var(--aio-ink); }
.aio-card__footer { padding: .7em 1em; border-top: 1px solid var(--aio-line); background: var(--aio-surface); }

.aio-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 1000; }
.aio-modal { background: var(--aio-bg); color: var(--aio-ink); border: 1px solid var(--aio-line); border-radius: calc(var(--aio-radius) + 4px); width: 100%; max-width: 32rem; max-height: 90vh; overflow: auto; box-shadow: 0 12px 40px rgba(0,0,0,.3); }
.aio-modal__title { padding: .9em 1.1em; border-bottom: 1px solid var(--aio-line); font-weight: 600; font-family: var(--aio-font); }
.aio-modal__body { padding: 1.1em; }
.aio-modal__footer { padding: .8em 1.1em; border-top: 1px solid var(--aio-line); background: var(--aio-surface); display: flex; gap: .5em; justify-content: flex-end; }

.aio-spinner { display: inline-block; width: 1em; height: 1em; border: 2px solid var(--aio-line); border-top-color: var(--aio-accent); border-radius: 50%; animation: aio-spin .6s linear infinite; vertical-align: -0.15em; }
@keyframes aio-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .aio-spinner { animation-duration: 1.6s; } }
`.trim();

/** Renders the `aio/ui` base stylesheet. Place once, near your app root.
 *  Rendering through AIR keeps it SSR- and test-safe (no global document). */
export function UiStyles(): VNode {
  return h("style", { "data-aio-ui": "" }, UI_CSS);
}
