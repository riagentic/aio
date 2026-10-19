// browser-vitals: the CLIENT half of vital signs, wired into the AIR transport.
//
// `renderBudget` is accepted, validated, bridged into the `cfg` frame and the
// page shell — and from alpha48 to alpha69 it was read by nothing: the
// transport swap deleted the only caller of `createRenderMeter()`, so no
// client measured staleness, no threshold could fire, `vitals-ping` had no
// sender and `/__aio/vitals` reported `clients: []` for every app. A config
// key accepted and dropped is the class this project forbids; this module is
// the reader.
//
// What runs, per WS connection:
//   • a render meter (rAF-driven — `manualTick` where there is no rAF, i.e.
//     a test process) — `recordPatch()` on every applied state/patches frame,
//     staleness = age of the newest unpainted patch, thresholds from
//     `__aioConfig.renderBudget` (shell-injected or the `cfg` frame);
//   • a transport probe — RTT from `vitals-pong`;
//   • one heartbeat timer sending `vitals-ping {t1, ms}` — `ms` is the meter's
//     staleness, which the server turns into per-client backpressure
//     (`server-ws.ts`, `_handleVitalsPing`) and into the `clients` rows of
//     `/__aio/vitals`.
//
// WS only, by contract: `envelope.ts` lists `vitals-ping` as unsupported on
// UDS/IPC (rejected loudly there), so the Electron bridge never pings.
//
// A threshold crossing is REPORTED, not just measured: status changes go to
// the diagnostic bus (dev overlay, `am errors`, client-log) with the hint
// engine's root-cause line, and the console, once per incident.

import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { enc } from "../protocol/envelope.ts";
import type { AioWindow } from "../protocol/protocol-types.ts";
import {
  createRenderMeter,
  type RenderGauges,
  renderHint,
} from "../vitals/render-meter.ts";
import { createTransportProbeClient } from "../vitals/transport-probe.ts";
import {
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_THRESHOLDS,
  type VitalStatus,
} from "../vitals/types.ts";
import {
  _setVitalsPingTimer,
  _setVitalsRenderMeter,
  _setVitalsTransportProbe,
  _setVitalsUrlLogged,
  _vitalsPingTimer,
  _vitalsRenderMeter,
  _vitalsTransportProbe,
  _vitalsUrlLogged,
} from "./protocol-subscription.ts";

/** Heartbeat period. One decider, overridable for a test that must not wait
 *  a real second per ping. */
let _heartbeatMs = DEFAULT_HEARTBEAT_INTERVAL;
/** Test seam: heartbeat period in ms (null resets to the default). */
// aio-ok: a test-only seam — a fake-clock test must not wait a real second per ping.
export function _setVitalsHeartbeatForTest(ms: number | null): void {
  _heartbeatMs = ms ?? DEFAULT_HEARTBEAT_INTERVAL;
}

/** The budget the app declared, as the page knows it: `__aioConfig` is
 *  filled by the shell at load and by the `cfg` frame after connect (same
 *  values; the frame only fills gaps). Read at meter creation — the first WS
 *  open — which is after both. */
export function _renderBudget(): {
  staleness?: number;
  pendingPatches?: number;
} | undefined {
  const rb = (globalThis as unknown as AioWindow).__aioConfig?.renderBudget;
  return rb && typeof rb === "object" ? rb : undefined;
}

/** True when the meter can drive itself from rAF; otherwise it is ticked on
 *  each heartbeat (a Deno test process, a worker). */
function _hasRaf(): boolean {
  return typeof (globalThis as { requestAnimationFrame?: unknown })
    .requestAnimationFrame === "function";
}

function _report(status: VitalStatus, gauges: RenderGauges): void {
  const stale = Math.round(gauges.staleness.current);
  const budget = Math.round(gauges.staleness.capacity);
  if (status !== "healthy" && !_vitalsUrlLogged) {
    _setVitalsUrlLogged(true);
    const origin = (globalThis as { location?: { origin?: string } })
      .location?.origin ?? "";
    console.warn(`[aio:vitals] dashboard at ${origin}/__aio/vitals`);
  }
  // The console line is the prod-visible half: the diagnostic bus is a
  // dev-only sink (`diagEmit` is a no-op unless the bus was opened in dev),
  // and a budget the app tuned must be heard when it is crossed in prod too.
  // One line per status CHANGE — the meter coalesces, so this cannot spam.
  if (status === "frozen" || status === "degraded" || status === "warning") {
    console.warn(
      `[aio:vitals] render ${status.toUpperCase()} — ${stale}ms behind ` +
        `(renderBudget.staleness ${budget}ms)` +
        (renderHint(gauges) ? ` — ${renderHint(gauges)}` : ""),
    );
  }
  if (status === "frozen") {
    diagEmit({
      type: "vitals:render-frozen",
      severity: "error",
      source: "browser-vitals",
      message: `render FROZEN — ${stale}ms behind (budget ${budget}ms)`,
      detail: {
        staleness: stale,
        pendingPatches: gauges.pendingPatches.current,
        frameTime: Math.round(gauges.frameTime.current),
        lastAction: _vitalsRenderMeter?.getLastAction() ?? null,
      },
      hint: renderHint(gauges) ??
        "check component complexity and update frequency",
    });
  } else if (status === "degraded" || status === "warning") {
    diagEmit({
      type: "vitals:render-stale",
      severity: "warning",
      source: "browser-vitals",
      message:
        `render ${status.toUpperCase()} — ${stale}ms behind (budget ${budget}ms)`,
      detail: {
        staleness: stale,
        pendingPatches: gauges.pendingPatches.current,
        frameTime: Math.round(gauges.frameTime.current),
      },
      hint: renderHint(gauges) ??
        "check component complexity and update frequency",
    });
  } else if (status === "recovered") {
    diagEmit({
      type: "vitals:render-recovered",
      severity: "info",
      source: "browser-vitals",
      message: "render recovered",
    });
  }
}

// ── The silent-socket watchdog ───────────────────────────────────────────────
// A socket can die without a close event: the network under it goes away and
// the browser hears nothing until TCP gives up (measured on an Android 15
// WebView: nothing for 25–90 s, taps written into the void, the page looking
// connected). The heartbeat already asks the server once a second and the
// server answers every ping, so silence is observable — but silence alone is
// not death (a server busy for seconds is silent too). The evidence, in order:
//   1. this connection has answered a ping before (a server with vitals off,
//      or a peer that never pongs, is never judged);
//   2. beats are COUNTED, not timed: only a beat that ran and WROTE its ping
//      counts (one the pacer holds has asked the server nothing yet), and any
//      inbound frame resets the count — a throttled, frozen or suspended page
//      runs no beats, so it accrues no silence;
//   3. after `SILENT_BEATS_ASK` silent beats the page asks over HTTP. A
//      network error is the network saying so: dead now. An answer means the
//      server's loop turns and this socket still hears nothing: dead at the
//      next silent beat. A request that hangs is a busy server (or a black
//      hole) and decides nothing;
//   4. `SILENT_BEATS_DEAD` silent beats — past the 15 s after which every call
//      in flight has been rejected anyway — is dead whatever HTTP said.

/** Silent beats before the page asks over HTTP whether the server is there. */
export const SILENT_BEATS_ASK = 4;
/** Silent beats after which the socket is dead without further evidence. */
export const SILENT_BEATS_DEAD = 20;

/** What the transport lends the watchdog: `reach` asks the server over HTTP
 *  (true = answered, false = network error; it may never settle), `onDead`
 *  runs the connection's close path. */
export type SilenceWatch = {
  reach: () => Promise<boolean>;
  onDead: (why: string) => void;
};

let _ponged = false; // this connection has answered a ping
/** SOME connection of this page has answered a ping: the server pongs, so a
 *  new connection that dies before its own first pong (a flapping network —
 *  open, then gone within the first heartbeat) is judged too. Per connection
 *  only, that socket was never judged: measured in headless Chromium, it sat
 *  "connected" through a 70 s black hole, every call timing out, no
 *  reconnect. Cleared with the page's vitals, not with the connection. */
let _serverPongs = false;
let _silent = 0; // pings written since the last inbound frame
let _reached = false; // HTTP answered while the socket stayed silent
let _silence = 0; // bumped whenever the silence ends — a late answer is void
let _asked = -1; // the silence HTTP was asked about (once each)
/** This connection's beat, for `visibilitychange` to run at once: a hidden
 *  page's timers are throttled, so its pings say `h: 1` and the server stops
 *  grading it as frozen until a visible one. */
let _beatNow: (() => void) | null = null;
let _onVis = false;

function _heard(): void {
  _silent = 0;
  _reached = false;
  _silence++;
}

/** Any frame arrived on the socket — it is alive. */
export function _noteClientFrame(): void {
  if (_silent > 0) _heard();
}

/** A `vitals-pong` arrived: this connection answers pings. */
export function _noteClientPong(): void {
  _ponged = _serverPongs = true;
}

/** Before a beat's ping: is the socket dead? Says why, or null. */
function _judgeSilence(watch: SilenceWatch): string | null {
  if (!_ponged && !_serverPongs) return null;
  if (_silent >= SILENT_BEATS_DEAD) {
    return `no frame for ${SILENT_BEATS_DEAD} heartbeats`;
  }
  if (_reached) return "the server answers HTTP, this socket hears nothing";
  if (_silent >= SILENT_BEATS_ASK && _asked !== _silence) {
    const asked = _asked = _silence;
    watch.reach().then((answered) => {
      if (asked !== _silence) return; // a frame arrived, or the socket closed
      if (answered) _reached = true;
      else watch.onDead("the network is unreachable");
    });
  }
  return null;
}

/** Start (or resume) client vitals for a WS connection. Idempotent: the meter
 *  and probe live for the page, the heartbeat for the connection. `sendRaw`
 *  writes a frame and answers whether it LEFT (not merely queued); `isOpen` says whether the WS
 *  is the live transport (pings are WS-only). `watch` arms the silent-socket
 *  watchdog for this connection. */
export function _startClientVitals(
  sendRaw: (raw: string) => boolean,
  isOpen: () => boolean,
  watch?: SilenceWatch,
): void {
  if (!_vitalsRenderMeter) {
    const rb = _renderBudget();
    const raf = _hasRaf();
    _setVitalsRenderMeter(createRenderMeter({
      manualTick: !raf,
      // No rAF → ticked from the heartbeat timer → the timers' clock.
      ...(raf ? {} : { now: () => Date.now() }),
      thresholds: rb
        ? { staleness: rb.staleness, pendingPatches: rb.pendingPatches }
        : undefined,
      onStatusChange: _report,
    }));
  }
  if (!_vitalsTransportProbe) {
    _setVitalsTransportProbe(createTransportProbeClient({
      thresholds: DEFAULT_THRESHOLDS,
      interval: _heartbeatMs,
    }));
  }
  if (_vitalsPingTimer) return;
  const doc = (globalThis as { document?: Document }).document;
  if (doc && !_onVis) {
    _onVis = true;
    doc.addEventListener("visibilitychange", () => _beatNow?.());
  }
  _setVitalsPingTimer(
    setInterval(_beatNow = _beat(sendRaw, isOpen, watch), _heartbeatMs),
  );
}

/** One heartbeat: tick a rAF-less meter, then ping with the staleness. */
function _beat(
  sendRaw: (raw: string) => boolean,
  isOpen: () => boolean,
  watch?: SilenceWatch,
): () => void {
  return () => {
    const meter = _vitalsRenderMeter;
    const probe = _vitalsTransportProbe;
    if (!meter || !probe || !isOpen()) return;
    if (!_hasRaf()) meter.tick(Date.now());
    const dead = watch ? _judgeSilence(watch) : null;
    if (dead) return watch!.onDead(dead);
    const ping = probe.createPing();
    const left = sendRaw(enc("vitals-ping", {
      t1: ping.t1,
      ms: Math.round(meter.getStaleness()),
      ...((globalThis as { document?: Document }).document?.hidden
        ? { h: 1 }
        : {}),
    }));
    if (left) _silent++;
  };
}

/** A state/patches frame was APPLIED — the meter's clock for "unpainted". */
export function _noteClientPatch(): void {
  _vitalsRenderMeter?.recordPatch();
}

/** The connection closed: stop the heartbeat, keep the meter (it measures the
 *  page, not the socket; a reconnect re-arms the timer). */
export function _pauseClientVitals(): void {
  _ponged = false;
  _heard();
  _beatNow = null;
  if (_vitalsPingTimer) {
    clearInterval(_vitalsPingTimer);
    _setVitalsPingTimer(null);
  }
}

/** Page teardown: everything goes. */
export function _stopClientVitals(): void {
  _pauseClientVitals();
  _serverPongs = false;
  _vitalsRenderMeter?.destroy();
  _setVitalsRenderMeter(null);
  _vitalsTransportProbe?.destroy();
  _setVitalsTransportProbe(null);
  _setVitalsUrlLogged(false);
}
