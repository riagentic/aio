// dialog-host.ts — "which app window asked for this dialog?", answered once.
//
// `pickFile` / `pickDirectory` used to spawn a desktop tool (PowerShell,
// osascript, zenity) from the server process. On Windows that dialog belongs to
// a background `powershell.exe` with no relation to the app's window, so the
// foreground lock was free to leave it BEHIND the window the user had just
// clicked in — sometimes fully hidden, reading as a hung app (a field report,
// #10; #8 was the console window the same spawn used to open). No flag on the
// spawn fixes that class: the dialog has to be OWNED by the app's window.
//
// An Electron window of this app can own it. Its main process sits on the
// app's local socket (uds.ts) and, when it can open native dialogs, says so in
// a `type` frame (`caps: ["dialog"]`). The socket connection then gets a
// DialogHost: the server sends a `dialog` frame, the main process runs
// `dialog.showOpenDialog(win, …)` — parented, modal, no child process, on all
// three OSes — and answers with `dialog-result`.
//
// WHICH host serves a call is decided here and nowhere else:
//   1. the caller's own connection, when the call arrived over the socket
//      (uds.ts runs the action / serverFn inside `runWithDialogCaller`) — its
//      host, or `null` when that peer cannot open dialogs;
//   2. a caller that came over HTTP / WebSocket (`serverRequest()` is set) is
//      a browser or a script: no window of ours to parent to → `null`;
//   3. no caller at all (a schedule, a boot hook, a lost async context): the
//      app's window, when exactly ONE is connected — that is every packaged
//      desktop app. Two or more and there is no honest answer → `null`.
// `null` means the spawned-tool path, which stays for every client that is not
// an aio Electron window (and gives its Windows dialog a TopMost owner).

import { AsyncLocalStorage } from "node:async_hooks";
import { serverRequest } from "./auth-context.ts";

/** One dialog request, as it travels to the window (the `dialog` frame's
 *  payload minus its correlation id). Everything is resolved server-side —
 *  default title, `startIn` → a directory, bare extensions — so the window
 *  opens exactly what the spawned tools would have. */
export type DialogRequest = {
  kind: "file" | "files" | "directory";
  title: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
};

/** The window's answer (the `dialog-result` payload minus its id). */
export type DialogReply =
  | { canceled: boolean; paths: string[] }
  | { error: string };

/** A connected window that can open native dialogs for the server. */
export type DialogHost = {
  /** Human name for messages — `"Electron window (client 3)"`. */
  readonly label: string;
  /** Open one dialog; settles when the user closes it (no timeout — a human
   *  is choosing), or rejects when the window goes away first. */
  open(req: DialogRequest): Promise<DialogReply>;
};

const _hosts = new Set<DialogHost>();
const _caller = typeof AsyncLocalStorage === "function"
  ? new AsyncLocalStorage<DialogHost | null>()
  : null;

/** Framework-internal: a window announced it can open dialogs. Returns the
 *  disposer its connection's close runs. */
export function _registerDialogHost(host: DialogHost): () => void {
  _hosts.add(host);
  return () => {
    _hosts.delete(host);
  };
}

/** Framework-internal: run `fn` as a call from `host`'s connection — or, with
 *  `null`, from a socket peer that cannot open dialogs (the CLI client). */
export const runWithDialogCaller = <T>(
  host: DialogHost | null,
  fn: () => T,
): T => _caller ? _caller.run(host, fn) : fn();

/** The window that should own a dialog opened by the call in flight, or
 *  `null` for the spawned-tool path. The three rules are in this file's
 *  header. */
export function dialogHostForCall(): DialogHost | null {
  const own = _caller?.getStore();
  if (own !== undefined) return own;
  if (serverRequest() !== undefined) return null;
  if (_hosts.size !== 1) return null;
  return _hosts.values().next().value ?? null;
}
