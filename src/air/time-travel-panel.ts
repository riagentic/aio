// deno-lint-ignore-file
// Browser-side time-travel state — dev mode only.
// Receives "tt-state" frames from the server; `useTimeTravel()`
// (time-travel-air.ts) reads it. The floating panel is a dev hook
// (time-travel-dom.ts, via dev-air.ts), so a production bundle carries none
// of its DOM code — and a production server never sends `tt-state`.
import { Listeners } from "../state/listeners.ts";
import { enc } from "../protocol/envelope.ts";
import { devHooks } from "./dev-hooks.ts";

// ── Types ──────────────────────────────────────────────────────────────
export type TTMeta = {
  entries: {
    id: number;
    type: string;
    ts: number;
    perf?: {
      reduce: number;
      effects: number;
      budget: { reduce: number; effect: number };
    };
  }[];
  index: number;
  paused: boolean;
};

// ── Module-level state ─────────────────────────────────────────────────
let _ttState: TTMeta | null = null;
const _ttListeners = new Listeners<TTMeta>();

// ── Send function (injected by browser.ts) ─────────────────────────────
let _sendFn: ((msg: string) => void) | null = null;

/** Provide the WS/IPC send function. browser-air-transport.ts calls it once
 *  at load (its `_sendRaw` picks whichever channel is open). */
export function setSendFn(fn: ((msg: string) => void) | null): void {
  _sendFn = fn;
}

export function _sendTTCmd(cmd: string): void {
  if (_sendFn) _sendFn(cmd);
  else console.warn("[aio] time-travel command not sent — no client transport");
}

// ── Subscription ───────────────────────────────────────────────────────
// The history is up to `MAX_ENTRIES` entries and the server re-sends it on
// every recorded dispatch — so it is sent only to a client that SHOWS it: the
// panel open, or a `useTimeTravel()` reader. A client the server cannot place
// (`sub` never said) keeps the old behavior, which is why a client that does
// not want the frames it receives says so (`unsub`) instead of staying quiet.
let _panelOpen = false;
let _hookOn = false;
const _want = (): boolean => _panelOpen || _hookOn;
const _tell = (): void =>
  _sendTTCmd(enc("tt-cmd", { cmd: _want() ? "sub" : "unsub" }));

function _setWant(set: () => void): void {
  const was = _want();
  set();
  if (_ttState && _want() !== was) _tell();
}

/** `useTimeTravel()` reads the history: keep it coming. */
export function _ttHookOn(): void {
  _setWant(() => _hookOn = true);
}

/** The panel opened or closed (time-travel-dom.ts). */
function _ttPanelOpen(open: boolean): void {
  _setWant(() => _panelOpen = open);
}

/** Get current time-travel state. */
export function getTTState(): TTMeta | null {
  return _ttState;
}

/** Subscribe to TT state changes. Returns unsubscribe function. */
export function subscribeTT(fn: (t: TTMeta) => void): () => void {
  return _ttListeners.add(fn);
}

// ── Public API ─────────────────────────────────────────────────────────

/** Process a "tt-state" payload from the server (decoded object, or a JSON string). */
export function handleTTMessage(data: string | object): void {
  try {
    _ttState = (typeof data === "string" ? JSON.parse(data) : data) as TTMeta;
    if (!_want()) _tell();
    _ttListeners.notify(_ttState!);
    devHooks.showTT?.(_ttState!, _sendTTCmd, _ttPanelOpen);
  } catch (err) {
    console.warn("[aio] bad tt-state data:", err);
  }
}

/** Reset all time-travel panel state — the DOM node AND the `keydown`
 *  listener it puts on `document`, so a torn-down client leaves neither.
 *  Called from the client teardown (`_setTeardownFn` in
 *  browser-air-transport.ts). It used to name `browser.ts`, a file that has
 *  not existed since alpha52, and nothing called it at all. */
export function resetTT(): void {
  _ttState = null;
  _panelOpen = false;
  _hookOn = false;
  _ttListeners.clear();
  devHooks.resetTTPanel?.();
}
