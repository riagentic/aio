// deno-lint-ignore-file
// browser-air-commands: Server command routing for AIR transport.
// Routes server-initiated control frames (surfaces, triggers, time-travel,
// diag, acks, vitals) — v2 envelope, one decoded frame in, one reply out.

import { handleTTMessage } from "../air/time-travel-panel.ts";
import { getSerializedSurfaces, runUITrigger } from "../air/ui-remote.ts";
import { _vitalsTransportProbe, _w } from "./browser-protocol.ts";
import { _rejectAck, _resolveAck } from "../protocol/browser-ack.ts";
import { type AckPayload, enc, type Frame } from "../protocol/envelope.ts";
import type { VitalsPong } from "../vitals/transport-probe.ts";

/** Route server-initiated command frames. Returns true if consumed. */
export function routeCommand(
  f: Frame,
  sendRaw: (msg: string) => void,
): boolean {
  switch (f.t) {
    case "ui-surface":
      try {
        // `full` lifts the text cap (`am surface --full`).
        sendRaw(enc(
          "ui-surface-result",
          getSerializedSurfaces(
            (f.d as { full?: boolean } | undefined)?.full === true,
          ),
        ));
      } catch (e) {
        sendRaw(enc("ui-surface-result", { error: String(e) }));
      }
      return true;

    case "ui-trigger":
      // Reply async — the trigger settles the app before responding.
      (async () => {
        try {
          const result = await runUITrigger(
            f.d as Parameters<typeof runUITrigger>[0],
          );
          sendRaw(enc("ui-trigger-result", result));
        } catch (e) {
          sendRaw(enc("ui-trigger-result", { ok: false, error: String(e) }));
        }
      })();
      return true;

    case "tt-state":
      handleTTMessage(f.d as object);
      return true;

    case "diag":
      try {
        if (_w && typeof _w._aioDiag === "function") {
          _w._aioDiag(f.d as Record<string, unknown>);
        }
      } catch { /* ignore malformed diag */ }
      return true;

    // AIO-2.2: per-action ack — settles the Promise returned by an awaited
    // cell method (registered in browser-ack).
    case "ack": {
      const { cid, ok, value, error } = (f.d ?? {}) as AckPayload;
      if (typeof cid === "string") {
        if (ok) _resolveAck(cid, value);
        else _rejectAck(cid, new Error(error ?? "server rejected action"));
      }
      return true;
    }

    // Vitals pong — forward to the transport probe so RTT/staleness stays
    // fresh in AIR/IPC mode (the WS handler in browser-transport-ws.ts
    // never sees these frames).
    case "vitals-pong":
      try {
        if (_vitalsTransportProbe) {
          _vitalsTransportProbe.processPong(f.d as VitalsPong);
        }
      } catch { /* ignore malformed pong */ }
      return true;

    default:
      return false;
  }
}
