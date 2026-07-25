// ─── Vital Signs — Pressure Monitor ────────────────────────────────────────
// Detects when resources approach limits. Emits DiagEvent with kind "pressure".
// Server-side only: payload size + broadcast rate.

import type { DiagEvent } from "./types.ts";
import { formatDiagEvent } from "./diag-formatter.ts";

const THROTTLE_MS = 2000;
/** Above this many live throttle keys, sweep the expired ones (they are
 *  keyed per client, so the set grows with connections, not with code). */
const THROTTLE_KEYS_MAX = 256;
const DEFAULT_PAYLOAD_THRESHOLD = 512_000; // 500KB
const DEFAULT_RATE_THRESHOLD = 30; // broadcasts/sec
const DEFAULT_BANDWIDTH_THRESHOLD = 1_048_576; // 1MB/s

/** Configuration for the pressure monitor — payload size, broadcast rate, and bandwidth thresholds. */
export type PressureMonitorConfig = {
  payloadThreshold?: number;
  rateThreshold?: number;
  bandwidthThreshold?: number; // bytes/sec per client — warn when lifetime avg exceeds (default: 1MB/s)
  onDiagnostic?: (event: DiagEvent) => void;
  onConsole?: (lines: string[]) => void;
};

/** Pressure monitor API — tracks broadcast payload sizes and per-client bandwidth. */
export type PressureMonitorAPI = {
  onBroadcast(clientId: string, bytes: number): void;
  onClientDisconnect(clientId: string): void;
  getBytesPerSec(clientId: string): number;
  destroy(): void;
};

/** Create a pressure monitor that detects large payloads, high broadcast rates, and bandwidth spikes. */
export function createPressureMonitor(
  config: PressureMonitorConfig,
): PressureMonitorAPI {
  const payloadThreshold = config.payloadThreshold ?? DEFAULT_PAYLOAD_THRESHOLD;
  const rateThreshold = config.rateThreshold ?? DEFAULT_RATE_THRESHOLD;
  const bandwidthThreshold = config.bandwidthThreshold ??
    DEFAULT_BANDWIDTH_THRESHOLD;
  const lastConsoleEmit = new Map<string, number>();
  const _clientBandwidth = new Map<
    string,
    { startedAt: number; totalBytes: number }
  >();

  let _broadcastCount = 0;

  const log = config.onConsole ?? ((lines: string[]) => {
    if (lines.length === 1) {
      console.warn(lines[0]);
    } else {
      console.group(lines[0]);
      for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
      console.groupEnd();
    }
  });

  function emit(event: DiagEvent, throttleKey: string): void {
    // Timer-driven: a throwing user hook must not kill the process.
    try {
      config.onDiagnostic?.(event);
    } catch (e) {
      console.error(`[aio:vitals] onDiagnostic hook threw — ${e}`);
    }

    const now = Date.now();
    const lastEmit = lastConsoleEmit.get(throttleKey) ?? 0;
    if (now - lastEmit >= THROTTLE_MS) {
      lastConsoleEmit.set(throttleKey, now);
      // Throttle keys are per-CLIENT (`payload:<uuid>`), so on a long-running
      // server this map would otherwise keep one entry per client that ever
      // tripped a threshold. An entry older than the window can never suppress
      // anything again — drop it. Swept only when the map is large, so the
      // common case costs nothing.
      if (lastConsoleEmit.size > THROTTLE_KEYS_MAX) {
        for (const [k, at] of lastConsoleEmit) {
          if (now - at >= THROTTLE_MS) lastConsoleEmit.delete(k);
        }
      }
      log(formatDiagEvent(event));
    }
  }

  function onBroadcast(clientId: string, bytes: number): void {
    _broadcastCount++;

    // Track per-client bandwidth
    const now = Date.now();
    const bw = _clientBandwidth.get(clientId);
    if (bw) {
      bw.totalBytes += bytes;
      const elapsedSec = (now - bw.startedAt) / 1000;
      if (elapsedSec >= 1) { // need ≥1s of data before checking
        const bps = bw.totalBytes / elapsedSec;
        if (bps >= bandwidthThreshold) {
          const mbps = (bps / 1_048_576).toFixed(2);
          emit({
            kind: "pressure",
            severity: "likely",
            summary: `PRESSURE — client ${
              clientId.slice(0, 8)
            } averaging ${mbps} MB/s`,
            detail: {
              bytesPerSec: Math.round(bps),
              trigger: clientId,
              hint:
                "reduce state size, raise syncIntervalMs, or use cell-level ui filters",
            },
            timestamp: now,
          }, `bandwidth:${clientId}`);
        }
        // AIO-271: reset window after check to prevent averaging forever
        bw.startedAt = now;
        bw.totalBytes = 0;
      }
    } else {
      _clientBandwidth.set(clientId, { startedAt: now, totalBytes: bytes });
    }

    if (bytes >= payloadThreshold) {
      const kb = (bytes / 1024).toFixed(0);
      emit({
        kind: "pressure",
        severity: "possible",
        summary: `PRESSURE — broadcast payload ${kb}KB to client ${
          clientId.slice(0, 8)
        }`,
        detail: {
          payloadBytes: bytes,
          trigger: clientId,
          hint: "large state delta — check cell sizes at /__aio/vitals",
        },
        timestamp: now,
      }, `payload:${clientId}`);
    }
  }

  function onClientDisconnect(clientId: string): void {
    _clientBandwidth.delete(clientId);
  }

  function getBytesPerSec(clientId: string): number {
    const bw = _clientBandwidth.get(clientId);
    if (!bw) return 0;
    const elapsedSec = (Date.now() - bw.startedAt) / 1000;
    if (elapsedSec < 0.001) return 0;
    return Math.round(bw.totalBytes / elapsedSec);
  }

  // Tumbling 1s window for rate detection
  const _rateTimer = setInterval(() => {
    if (_broadcastCount >= rateThreshold) {
      emit({
        kind: "pressure",
        severity: "possible",
        summary:
          `PRESSURE — ${_broadcastCount} broadcasts/sec (threshold: ${rateThreshold}/sec)`,
        detail: {
          drainRate: _broadcastCount,
          hint: "high dispatch frequency — debounce or batch actions",
        },
        timestamp: Date.now(),
      }, "rate");
    }
    _broadcastCount = 0;
  }, 1000);

  return {
    onBroadcast,
    onClientDisconnect,
    getBytesPerSec,
    destroy() {
      clearInterval(_rateTimer);
      _clientBandwidth.clear();
    },
  };
}
