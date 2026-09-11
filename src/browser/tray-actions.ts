// tray-actions.ts — what a tray menu item does when clicked.
//
// The tray lives in Electron's main process; the app's cells do not. So a
// click is relayed to the renderer as `{ method, args, route }`, and the
// renderer dispatches it through the SAME door every button uses — acks,
// validation, the offline queue, all of it. A second dispatch path from the
// main process would be a second thing to keep honest.
import { send } from "../state/state-transport.ts";
import { navigateTo } from "./desktop-notify.ts";

/** What the shell sends for a clicked item (see `ui.tray.menu`). */
export type TrayAction = {
  /** `"cell:method"` — dispatched with `args`. */
  method?: string;
  args?: unknown[];
  /** A route to navigate to. */
  route?: string;
};

export function runTrayAction(a: TrayAction): void {
  if (!a || typeof a !== "object") return;
  if (typeof a.method === "string" && a.method.includes(":")) {
    send({
      type: a.method,
      payload: { args: Array.isArray(a.args) ? a.args : [] },
    });
  }
  if (typeof a.route === "string" && a.route) navigateTo(a.route);
}

/** Listen for tray clicks through the shell bridge, when there is one. A
 *  browser tab and an Android WebView have none; nothing to bind, nothing
 *  to say. */
export function bindShellTray(): void {
  const shell = (globalThis as {
    __aioShell?: { onTray?: (fn: (item: TrayAction) => void) => void };
  }).__aioShell;
  shell?.onTray?.(runTrayAction);
}
