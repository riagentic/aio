// Vitals probe initialization and diagnostic event logging for browser transport.

import { enc } from "../protocol/envelope.ts";
import {
  _checkWastedRenders,
  _notify,
  _setVitalsPingTimer,
  _setVitalsRenderMeter,
  _setVitalsTransportProbe,
  _setVitalsUrlLogged,
  _vitalsPingTimer,
  _vitalsRenderMeter,
  _vitalsTransportProbe,
  _vitalsUrlLogged,
  _w,
  createRenderMeter,
  createTransportProbeClient,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_THRESHOLDS,
  type DiagEvent,
  formatDiagEvent,
  renderHint,
} from "./browser-protocol.ts";
import { T } from "./browser-transport-state.ts";

/** Initializes render meter, transport probe, and vitals ping timer for a WS connection. */
export function initVitals(_ws: WebSocket): void {
  if (!_vitalsRenderMeter) {
    const _rb = _w?.__aioConfig?.renderBudget;
    _setVitalsRenderMeter(createRenderMeter({
      thresholds: _rb
        ? { staleness: _rb.staleness, pendingPatches: _rb.pendingPatches }
        : undefined,
      onNotify: _notify,
      onStatusChange: (status, gauges) => {
        if (status !== "healthy" && !_vitalsUrlLogged) {
          _setVitalsUrlLogged(true);
          console.warn(
            `[aio:vitals] dashboard at ${location.origin}/__aio/vitals`,
          );
        }
        if (status === "frozen" || status === "recovered") {
          const kind = status === "frozen"
            ? "freeze" as const
            : "recovered" as const;
          const event: DiagEvent = {
            kind,
            severity: kind === "freeze" ? "likely" : "speculative",
            summary: kind === "freeze"
              ? `RENDER FROZEN — staleness ${
                Math.round(gauges.staleness.current)
              }ms`
              : "render recovered",
            detail: {
              trigger: _vitalsRenderMeter?.getLastAction() ?? undefined,
            },
            timestamp: Date.now(),
          };
          logDiagEvent(event);
        } else if (status === "degraded" || status === "warning") {
          const wastedWarning = _checkWastedRenders(status);
          if (wastedWarning) console.warn(wastedWarning);
          const event: DiagEvent = {
            kind: "pressure",
            severity: status === "degraded" ? "speculative" : "possible",
            summary: `STALENESS ${status.toUpperCase()} — ${
              Math.round(gauges.staleness.current)
            }ms behind`,
            detail: {
              hint: renderHint(gauges) ??
                "check component complexity and update frequency",
            },
            timestamp: Date.now(),
          };
          logDiagEvent(event);
        }
      },
    }));
  }
  if (!_vitalsTransportProbe) {
    _setVitalsTransportProbe(createTransportProbeClient({
      thresholds: DEFAULT_THRESHOLDS,
      interval: DEFAULT_HEARTBEAT_INTERVAL,
    }));
  }
  if (!_vitalsPingTimer) {
    _setVitalsPingTimer(setInterval(() => {
      if (T.ws && T.ws.readyState === WebSocket.OPEN && _vitalsTransportProbe) {
        const ping = _vitalsTransportProbe.createPing();
        const ms = _vitalsRenderMeter
          ? Math.round(_vitalsRenderMeter.getStaleness())
          : 0;
        T.ws.send(enc("vitals-ping", { t1: ping.t1, ms }));
      }
    }, DEFAULT_HEARTBEAT_INTERVAL));
  }
}

/** Formats and logs a diagnostic event to the console. */
export function logDiagEvent(event: DiagEvent): void {
  const lines = formatDiagEvent(event);
  if (lines.length === 1) console.warn(lines[0]);
  else {
    console.group(lines[0]);
    for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
    console.groupEnd();
  }
}
