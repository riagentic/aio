// deno-lint-ignore-file
// cell() and aio stub — browser-side action creator factories.

import { registerCell } from "../state/cell-reactive.ts";
import { isAsyncFunction } from "../state/cell-impl.ts";
import type { CellDef } from "../state/cell-types.ts";
import { normalizeSyncConfig } from "../sync/types.ts";
// The SERVER's normalizers, not copies of them. `__aio.ui` and `__aio.selectors`
// are both read by bindCellReactive — the binder the browser bundle runs — so a
// stub that stores the raw config instead of the normalized shape is a
// divergence only production can see. `tests/browser-cell-stub-parity.test.ts`
// pins every `__aio` key the browser reads against this file.
import {
  normalizeUiFilter,
  resolveVisibility,
  scopeSelectors,
} from "../state/cell-helpers.ts";

// deno-lint-ignore no-explicit-any
type _Creators = Record<string, (...args: any[]) => any>;

/** Per-selector dep lists (deps-form only) — the browser twin of the map
 *  cell-methods-factory builds. */
function selectorDepsOf(
  selectors: unknown,
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  if (!selectors || typeof selectors !== "object") return out;
  for (const [key, def] of Object.entries(selectors)) {
    if (def && typeof def === "object" && Array.isArray((def as any).deps)) {
      out[key] = (def as any).deps;
    }
  }
  return out;
}

/** `s.$do` exists on every method draft (alpha52). During an optimistic
 *  REPLAY the effects already ran on the server — re-firing them here would
 *  double them — so the replay serves a swallow-everything $do. A thin
 *  forwarding proxy, same shape as the server's withDraftDo (cell-impl.ts). */
function withReplayDo<S extends object>(draft: S): S {
  return new Proxy(draft, {
    get: (t, p) => (p === "$do" ? _noopDo : Reflect.get(t, p, t)),
    set: (t, p, v) => Reflect.set(t, p, v, t),
    has: (t, p) => p === "$do" || Reflect.has(t, p),
  });
}
function _noopDo(): void {}

// deno-lint-ignore no-explicit-any
export function cell(
  name: string,
  config: {
    state?: any;
    scope?: "client";
    /** CRDT sync config — routed through the client engine when set. */
    sync?: true | false | Record<string, unknown>;
    methods?: Record<string, unknown>;
    generators?: Record<string, unknown>;
    effects?: _Creators;
    machine?: any;
    selectors?: any;
    /** Client-read visibility. bindCellReactive enforces it on EVERY client
     *  read; dropping it here meant a `ui.exclude`d field read as a plain
     *  `undefined` in the browser (no throw in dev, no warning in prod) while
     *  standalone/testUI threw — the "undefined as data" trap the tripwire
     *  exists to stop, live only where nobody was testing. Resolved through
     *  resolveVisibility — the SAME decider the server factory uses — so
     *  `visible:` (alpha52) and the deprecated `ui:` alias mean the same
     *  thing in both runtimes. */
    visible?: any;
    ui?: any;
  },
): Record<string, unknown> {
  const prefix = name;
  // deno-lint-ignore no-explicit-any
  const buildCat = (creators: _Creators): Record<string, any> => {
    const cat: Record<string, unknown> = {};
    for (const key of Object.keys(creators)) {
      const label = `${prefix}:${key}`;
      const fn = Object.assign(
        (...args: unknown[]) => ({
          type: label,
          payload: creators[key]!(...args) ?? {},
        }),
        { type: label },
      );
      // `.action` self-reference — the server catalog guarantees it
      // (cell-catalog.ts buildCatalog); the browser stub silently lacked it,
      // so `someAction.action` was undefined only in the browser.
      (fn as unknown as Record<string, unknown>).action = fn;
      cat[key] = fn;
    }
    return cat;
  };
  // Methods style — the ONE style, exactly like the server factory
  // (cell-create.ts): an empty or omitted methods map is valid; the legacy
  // actions/machine/reduce/execute style was removed with it (alpha52).
  const methods = (config.methods ?? {}) as Record<string, unknown>;
  {
    const allKeys = [
      ...Object.keys(methods),
      ...Object.keys(config.generators ?? {}),
    ];
    const cat: Record<string, unknown> = {};
    for (const key of allKeys) {
      const label = `${prefix}:${key}`;
      const fn = Object.assign(
        (...args: unknown[]) => ({ type: label, payload: { args } }),
        { type: label },
      );
      // `.action` self-reference — parity with the server catalog shape.
      (fn as unknown as Record<string, unknown>).action = fn;
      cat[key] = fn;
    }
    // deno-lint-ignore no-explicit-any
    const eCat = buildCat((config.effects ?? {}) as any);
    // Return-value transport: the browser must know which methods are async so
    // bindCellReactive tags their dispatch with `_callId` — the correlation id
    // the server resolves with the method's RETURN value.
    //
    // It uses the SERVER'S classifier, not a copy of half of it. All three
    // sites here used to test `constructor.name === "AsyncFunction"` only,
    // while `isAsyncFunction` also honours the `markAsync` symbol — the
    // documented escape hatch for minifiers that rewrite constructor names,
    // i.e. precisely the browser bundle this file exists for. A `markAsync`ed
    // method was therefore classified SYNC here: its dispatch carried no
    // `_callId`, so `await cell.method()` resolved undefined instead of the
    // return value, and optimistic rebase "replayed" it by calling an async
    // function synchronously and dropping the promise.
    const asyncMethods = new Set<string>();
    for (const [key, fn] of Object.entries(methods)) {
      if (typeof fn === "function" && isAsyncFunction(fn)) {
        asyncMethods.add(key);
      }
    }
    const def: Record<string, unknown> = {
      __aio: {
        state: config.state ?? {},
        machine: config.machine ?? false,
        // Normalized, never raw: the DEPS form (`{ deps, fn }`) is an object,
        // and bindCellReactive calls whatever sits here — so a raw deps-form
        // selector threw `selectorFn is not a function` in the browser bundle
        // and nowhere else.
        selectors: scopeSelectors(prefix, config.selectors),
        // Which selectors are deps-form — bindCellReactive routes their calls
        // (full state + args) differently from plain parameterized ones
        // (alpha52 tuple form). Mirrors cell-methods-factory.
        selectorDeps: selectorDepsOf(config.selectors),
        ui: normalizeUiFilter(resolveVisibility(name, config)),
        actionKeys: allKeys,
        effectKeys: Object.keys(config.effects ?? {}),
        id: prefix,
        actions: cat,
        effects: eCat,
        asyncMethods,
        // `long: ["method"]` — mirrored because the browser resolves the SAME
        // call ceiling the server does (`longMethodKeys` in state/cell-impl).
        // A booted app also gets these on the `cfg` frame as `timeout: 0`, but
        // a client-scope cell never asks a server anything: without this key
        // its long method would give up at 30s in the browser and nowhere
        // else — the client/server divergence this file's parity gate exists
        // to catch.
        longMethods: (config as { long?: string[] }).long,
        bound: false,
      },
    };
    // AIO-5.1: client-scoped cells run their sync methods locally against the
    // cell signal — mark the def so bindCellReactive takes the client branch
    // instead of wiring server dispatch (parity with cell-create.ts).
    if (config.scope === "client") {
      for (const [key, fn] of Object.entries(methods)) {
        if (typeof fn === "function" && isAsyncFunction(fn)) {
          throw new Error(
            `[${name}] client-scoped cells support sync methods only (no ` +
              `server round-trip exists); do async work in the component and ` +
              `call sync methods with results — '${key}' is async`,
          );
        }
      }
      (def.__aio as Record<string, unknown>).scope = "client";
      (def.__aio as Record<string, unknown>).clientMethods = methods;
    }
    // A sync cell needs two extras for the client CRDT engine: the normalized
    // config (which cells route through the engine) and a replayable reducer
    // for optimistic rebase — built from the SYNC methods (CRDT ops must be
    // deterministic; async methods can't replay and are skipped — their outcome
    // arrives via the server's state broadcast).
    //
    // This is exposed as a closure, not run inline, because `localFirst` decides
    // on the SERVER at compose time: the browser learns which cells run locally
    // only after this def exists. Handing the engine a `syncConfig` without the
    // matching reducer would give it a cell it can stamp ops for but never
    // replay — the failure would look like "my optimistic updates vanish", from
    // a place nobody would think to look. One function, one place, both callers.
    (def.__aio as Record<string, unknown>).enableSync = (
      sync: true | Record<string, unknown>,
    ): void => {
      if ((def.__aio as Record<string, unknown>).syncConfig) return;
      (def.__aio as Record<string, unknown>).syncConfig = normalizeSyncConfig(
        sync as true | Record<string, unknown>,
      );
      const syncMethods: Record<string, unknown> = {};
      for (const [key, fn] of Object.entries(methods)) {
        if (typeof fn !== "function" || !isAsyncFunction(fn)) {
          syncMethods[key] = fn;
        }
      }
      (def.__aio as Record<string, unknown>).reduce = (
        draft: Record<string, unknown>,
        msg: { type: string; payload?: unknown },
      ) => {
        const key = String(msg.type).slice(prefix.length + 1);
        const m = syncMethods[key];
        if (typeof m === "function") {
          const args = (msg.payload as { args?: unknown[] })?.args ?? [];
          // $do served as a no-op: the server already ran the effects; a
          // replay must be state-deterministic and re-fire nothing.
          m(withReplayDo(draft), ...args);
        }
      };
    };
    if (config.sync === false) {
      (def.__aio as Record<string, unknown>).syncOptOut = true;
    } else if (config.sync) {
      ((def.__aio as Record<string, unknown>).enableSync as (
        s: true | Record<string, unknown>,
      ) => void)(config.sync as true | Record<string, unknown>);
    }
    for (const [key, value] of Object.entries(cat)) {
      def[key] = value;
    }
    registerCell(def as unknown as CellDef);
    return def;
  }
}

// deno-lint-ignore no-explicit-any
export const aio: Record<string, any> = {
  run() {
    return Promise.resolve();
  },
};
