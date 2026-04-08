// deno-lint-ignore-file
// Browser-side aio module — bundled into dist/app.js for prod builds
// DOM types provided via compilerOptions.lib in deno.json
// Dev mode uses the AIO_UI_JS string in server.ts instead (served at /__aio/ui.js)

// ── Protocol re-exports (public API surface only) ─────────────────
export {
  aio,
  bridge,
  cell,
  client,
  connectDevTools,
  disconnectDevTools,
  ensureConnected,
  log,
  matchPath,
  navigate,
  routePath,
  routeSearch,
} from "./browser-protocol.ts";
export type { LinkProps, RouteProps, RouteState } from "./browser-protocol.ts";

// ── Shared utilities ──────────────────────────────────────────────
export { actions, effects, msg, schedule } from "./browser-shared.ts";

// ── Time travel ───────────────────────────────────────────────────
export { useTimeTravel } from "./time-travel-react.ts";

// ── Transport (connection, send, reset) ───────────────────────────
// Import triggers side-effects: wires _setConnectFn, _setSubscribeTriggers,
// _setTeardownFn, and _setClientSend on the protocol layer.
import {
  _resetTransport,
  _send,
  _setFiberCallbacks,
} from "./browser-transport.ts";

/** Resets module state — for testing only */
export function _reset(): void {
  _resetTransport();
}

// Re-export _send for consumers that need the raw send function
export { _send };

// ── Fiber tree walker (dev mode) ──────────────────────────────────
import { _handleClick, _walkReactTree } from "./browser-fiber.ts";

// Wire fiber callbacks into transport so __getState / __click: commands work
_setFiberCallbacks(
  () => _walkReactTree(),
  (cmd: string) => _handleClick(cmd),
);

// ── React hooks ───────────────────────────────────────────────────
export {
  memo,
  page,
  useAio,
  useCell,
  useConnected,
  useLocal,
  useProjection,
} from "./browser-hooks.ts";

// ── Router components ─────────────────────────────────────────────
export {
  Link,
  NavLink,
  Outlet,
  Redirect,
  Route,
  useNavigate,
  useRoute,
} from "./browser-router.ts";
