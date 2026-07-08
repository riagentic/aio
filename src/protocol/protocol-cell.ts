// deno-lint-ignore-file
// cell(), bridge(), and aio stub — browser-side action creator factories.

import { registerCell } from "../state/cell-reactive.ts";
import type { CellDef } from "../state/cell-types.ts";

// deno-lint-ignore no-explicit-any
type _Creators = Record<string, (...args: any[]) => any>;

// deno-lint-ignore no-explicit-any
export function cell(
  name: string,
  config: {
    state?: any;
    scope?: "client";
    actions?: _Creators;
    methods?: Record<string, unknown>;
    generators?: Record<string, unknown>;
    effects?: _Creators;
    machine?: any;
    reduce?: any;
    execute?: any;
    selectors?: any;
  },
): Record<string, unknown> {
  const prefix = name;
  // deno-lint-ignore no-explicit-any
  const buildCat = (creators: _Creators): Record<string, any> => {
    const cat: Record<string, unknown> = {};
    for (const key of Object.keys(creators)) {
      const label = `${prefix}:${key}`;
      cat[key] = Object.assign(
        (...args: unknown[]) => ({
          type: label,
          payload: creators[key]!(...args) ?? {},
        }),
        { type: label },
      );
    }
    return cat;
  };
  if (config.methods) {
    const allKeys = [
      ...Object.keys(config.methods),
      ...Object.keys(config.generators ?? {}),
    ];
    const cat: Record<string, unknown> = {};
    for (const key of allKeys) {
      const label = `${prefix}:${key}`;
      cat[key] = Object.assign(
        (...args: unknown[]) => ({ type: label, payload: { args } }),
        { type: label },
      );
    }
    // deno-lint-ignore no-explicit-any
    const eCat = buildCat((config.effects ?? {}) as any);
    const def: Record<string, unknown> = {
      __aio: {
        state: config.state ?? {},
        machine: config.machine ?? false,
        selectors: config.selectors ?? {},
        actionKeys: allKeys,
        effectKeys: Object.keys(config.effects ?? {}),
        id: prefix,
        actions: cat,
        effects: eCat,
        bound: false,
      },
    };
    // AIO-5.1: client-scoped cells run their sync methods locally against the
    // cell signal — mark the def so bindCellReactive takes the client branch
    // instead of wiring server dispatch (parity with cell-create.ts).
    if (config.scope === "client") {
      for (const [key, fn] of Object.entries(config.methods)) {
        if (
          (fn as { constructor: { name: string } }).constructor.name ===
            "AsyncFunction"
        ) {
          throw new Error(
            `[${name}] client-scoped cells support sync methods only (no ` +
              `server round-trip exists); do async work in the component and ` +
              `call sync methods with results — '${key}' is async`,
          );
        }
      }
      (def.__aio as Record<string, unknown>).scope = "client";
      (def.__aio as Record<string, unknown>).clientMethods = config.methods;
    }
    for (const [key, value] of Object.entries(cat)) {
      def[key] = value;
    }
    registerCell(def as unknown as CellDef);
    return def;
  }
  const aCat = buildCat(config.actions ?? {});
  const def: Record<string, unknown> = {
    __aio: {
      state: config.state ?? {},
      machine: config.machine ?? false,
      selectors: config.selectors ?? {},
      actionKeys: Object.keys(config.actions ?? {}),
      effectKeys: Object.keys(config.effects ?? {}),
      id: prefix,
      actions: aCat,
      effects: buildCat(config.effects ?? {}),
      bound: false,
    },
  };
  for (const [key, value] of Object.entries(aCat)) {
    def[key] = value;
  }
  registerCell(def as unknown as CellDef);
  return def;
}

// deno-lint-ignore no-explicit-any
export function bridge(name: string, config: any): Record<string, unknown> {
  const channels = Object.keys(config.channels ?? {});
  // deno-lint-ignore no-explicit-any
  const actions: Record<string, (...args: any[]) => Record<string, unknown>> =
    {};
  for (const ch of channels) {
    actions[`${ch}Request`] = (...args: unknown[]) => ({
      ...(config.channels[ch]?.request?.(...args) ?? {}),
      _channel: ch,
    });
    actions[`${ch}Response`] = (...args: unknown[]) => ({
      ...(config.channels[ch]?.response?.(...args) ?? {}),
      _channel: ch,
    });
    actions[`${ch}Timeout`] = () => ({ _channel: ch });
  }
  return cell(name, { actions, machine: false, reduce: () => {} });
}

// deno-lint-ignore no-explicit-any
export const aio: Record<string, any> = {
  run() {
    return Promise.resolve();
  },
  middleware: {
    logger: () => () => null,
    devtools: () => () => null,
    perfBudget: () => () => null,
    validate: () => () => null,
    metrics: () => () => null,
    freeze: () => () => null,
    create: () => () => null,
  },
};
