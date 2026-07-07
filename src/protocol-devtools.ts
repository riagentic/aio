// deno-lint-ignore-file
// Redux DevTools integration.

import type { DevToolsConnection } from "./protocol-types.ts";
import {
  _getState as _coreGetState,
  isInitialStateReceived as _coreHasState,
} from "./state-core.ts";

export let _devtools: DevToolsConnection | null = null;
export let _devtoolsConnected = false;

function _initDevTools(): void {
  if (_devtoolsConnected) return;
  const ext =
    (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__;
  if (!ext) return;

  try {
    _devtools = (ext as { connect: () => DevToolsConnection }).connect();
    if (_devtools) {
      _devtoolsConnected = true;
      _devtools.subscribe((msg) => {
        if (msg.type === "DISPATCH") {
          const payload = msg.payload as { type?: string } | undefined;
          if (
            payload?.type === "JUMP_TO_STATE" ||
            payload?.type === "JUMP_TO_ACTION"
          ) {
            console.debug(
              "[aio] DevTools time-travel: use Ctrl+. panel for client-side state navigation",
            );
          }
        }
      });
      if (_coreHasState()) {
        _devtools.init(_coreGetState());
      }
    }
  } catch {
    // DevTools not available or failed to connect
  }
}

export function _sendDevTools(
  action: { type: string; payload?: unknown },
  state: unknown,
): void {
  if (_devtools && _devtoolsConnected) {
    try {
      _devtools.send(action, state);
    } catch {
      _devtoolsConnected = false;
    }
  }
}

/**
 * Connect state changes to the Redux DevTools browser extension (state tree,
 * action history, diffs). No-op when the extension is not installed.
 */
export function connectDevTools(): void {
  _initDevTools();
  if (_devtools && _coreHasState()) {
    try {
      _devtools.init(_coreGetState());
    } catch { /* ignore */ }
  }
}

/** Disconnect from the Redux DevTools extension. */
export function disconnectDevTools(): void {
  if (_devtools) {
    try {
      _devtools.disconnect();
    } catch { /* ignore */ }
    _devtools = null;
    _devtoolsConnected = false;
  }
}

export function _resetDevTools(): void {
  _devtools = null;
  _devtoolsConnected = false;
}
