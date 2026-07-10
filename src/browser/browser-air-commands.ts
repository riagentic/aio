// deno-lint-ignore-file
// browser-air-commands: Server command routing for AIR transport.
// Routes __-prefixed control messages (snapshots, interact, time-travel, diag).

import { handleTTMessage } from "../air/time-travel-panel.ts";
import { interact } from "../air/dom-interact.ts";
import { snapshotDOM } from "../air/dom-snapshot.ts";
import type { InteractCommand } from "../air/dom-inspector-types.ts";
import { _vitalsTransportProbe, _w } from "./browser-protocol.ts";
import { _rejectAck, _resolveAck } from "../protocol/browser-ack.ts";

/** Route __-prefixed commands from server. Returns true if consumed. */
export function routeCommand(
  line: string,
  sendRaw: (msg: string) => void,
): boolean {
  if (!line.startsWith("__")) return false;

  if (line === "__ui:snapshot" || line === "__ui:snapshot:all") {
    const all = line.endsWith(":all");
    try {
      const tree = snapshotDOM(undefined, all);
      sendRaw("__ui:snapshot-result:" + JSON.stringify(tree));
    } catch (e) {
      sendRaw("__ui:snapshot-result:" + JSON.stringify({ error: String(e) }));
    }
    return true;
  }

  if (line.startsWith("__ui:interact:")) {
    try {
      const cmd: InteractCommand = JSON.parse(
        line.slice("__ui:interact:".length),
      );
      const result = interact(cmd);
      sendRaw("__ui:interact-result:" + JSON.stringify(result));
    } catch (e) {
      sendRaw(
        "__ui:interact-result:" + JSON.stringify({
          ok: false,
          selector: "",
          action: "",
          error: String(e),
        }),
      );
    }
    return true;
  }

  if (line.startsWith("__tt:")) {
    handleTTMessage(line.slice(5));
    return true;
  }

  if (line.startsWith("__diag:")) {
    try {
      const ev = JSON.parse(line.slice(7));
      if (_w && typeof _w._aioDiag === "function") _w._aioDiag(ev);
    } catch { /* ignore malformed diag */ }
    return true;
  }

  // AIO-2.2: per-action ack — `__ack:<cid>:<ok>`. Settles the Promise returned
  // by an awaited cell method (registered in browser-ack). Without this, awaited
  // dispatches never resolve and time out, because this router consumes every
  // `__`-prefixed line (see the catch-all `return true` below), so the ack would
  // otherwise be silently dropped before reaching the state handler.
  if (line.startsWith("__ack:")) {
    const rest = line.slice(6);
    const sep = rest.indexOf(":");
    if (sep > 0) {
      const cid = rest.slice(0, sep);
      if (rest.slice(sep + 1) === "1") _resolveAck(cid);
      else _rejectAck(cid, new Error("server rejected action"));
    }
    return true;
  }

  // Vitals pong — forward to the transport probe so RTT/staleness stays fresh.
  // The catch-all `__vitals:` consumption below would otherwise drop pongs in
  // AIR/IPC mode (the WS handler in browser-transport-ws.ts never sees them).
  if (line.startsWith("__vitals:pong:")) {
    try {
      const pong = JSON.parse(line.slice("__vitals:pong:".length));
      if (_vitalsTransportProbe) _vitalsTransportProbe.processPong(pong);
    } catch { /* ignore malformed pong */ }
    return true;
  }
  if (line.startsWith("__vitals:")) return true;
  return true; // consumed but unrecognized
}
