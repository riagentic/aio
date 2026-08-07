// route-effect.ts — ONE exhaustive router over the framework-effect union.
//
// Three runtimes execute effects — the server dispatch loop
// (server/aio-dispatch.ts), the standalone/Android loop (standalone-air.ts)
// and the worker-cell host (server/cell-worker-host.ts) — and each used to
// hand-write the same classifier chain (`isScheduleEffect` → `isOwnEffect` →
// app effect). Three copies of one decision meant a NEW framework effect kind
// compiled clean everywhere and was silently treated as an app effect by
// whichever runtime nobody remembered to update.
//
// This module makes that a COMPILE error instead:
//   • `FrameworkEffects` is the single registry of framework effect kinds.
//     Adding a kind there forces a new guard in `ROUTES` (required key, checked
//     here) AND a new handler at every `routeEffect` call site (required key in
//     `EffectHandlers`) — the type-checker walks you to all three runtimes.
//   • Each runtime keeps its own SEMANTICS as handler logic (e.g. the worker
//     host forwards schedule effects to the main isolate and splits app
//     effects by own-prefix); only the classification is shared.

import { isScheduleEffect, type ScheduleEffect } from "./schedule.ts";
import { isOwnEffect, type OwnEffect } from "./own.ts";

/** The framework effect kinds every runtime must route. THE registry — add a
 *  kind here and the compiler demands a guard below and a handler at every
 *  call site. */
export type FrameworkEffects = {
  schedule: ScheduleEffect;
  own: OwnEffect;
};

/** Union of all framework effects (what a reducer may emit beside app
 *  effects). */
export type FrameworkEffect = FrameworkEffects[keyof FrameworkEffects];

/** One handler per framework kind + the app-effect fallthrough. Every key is
 *  REQUIRED — that requirement is the compile-time exhaustiveness gate. */
export type EffectHandlers<E> =
  & { [K in keyof FrameworkEffects]: (effect: FrameworkEffects[K]) => void }
  & { app: (effect: E) => void };

/** Kind → type guard, complete by construction: a kind added to
 *  `FrameworkEffects` without a guard here fails to compile. Order matters
 *  only if guards ever overlap (they must not — each matches its own
 *  discriminant type tag). */
const ROUTES: {
  [K in keyof FrameworkEffects]: (e: unknown) => e is FrameworkEffects[K];
} = {
  schedule: isScheduleEffect,
  own: isOwnEffect,
};

const ROUTE_KEYS = Object.keys(ROUTES) as (keyof FrameworkEffects)[];

/** Route one effect: framework kinds to their handler, everything else to
 *  `app`. The single classifier for all three effect runtimes. */
export function routeEffect<E>(
  effect: E | FrameworkEffect,
  handlers: EffectHandlers<E>,
): void {
  for (const kind of ROUTE_KEYS) {
    if (ROUTES[kind](effect)) {
      (handlers[kind] as (e: FrameworkEffect) => void)(effect);
      return;
    }
  }
  handlers.app(effect as E);
}
