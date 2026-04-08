// deno-lint-ignore-file
// browser-air-commands: Server command routing for AIR transport.
// Routes __-prefixed control messages (snapshots, interact, time-travel, diag).

import { handleTTMessage } from "./time-travel-panel.ts";
import { interact } from "./dom-interact.ts";
import { snapshotDOM } from "./dom-snapshot.ts";
import type { InteractCommand } from "./dom-inspector-types.ts";
import { _w } from "./browser-protocol.ts";

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

  if (line.startsWith("__vitals:")) return true;
  return true; // consumed but unrecognized
}
