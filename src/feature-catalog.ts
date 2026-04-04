// feature-catalog.ts — catalog building and feature binding

import type { Creators, FeatureDef, Msg } from "./feature-types.ts";
import { checkReservedKeys } from "./feature-types.ts";
import { registerCall } from "./feature-impl.ts";

/** Build a prefixed action/effect catalog from creator functions — maps keys to typed dispatchers. */
export function buildCatalog(
  prefix: string,
  creators: Creators,
): { catalog: Record<string, unknown>; typeToKey: Map<string, string> } {
  const catalog: Record<string, unknown> = {};
  const typeToKey = new Map<string, string>();

  for (const key of Object.keys(creators)) {
    const label = `${prefix}:${key}`;
    const fn = Object.assign( // A.increment(5) = { type, payload }
      (...args: unknown[]) => ({
        type: label,
        payload: creators[key]!(...args) ?? {},
      }),
      { type: label }, // A.increment.type = 'counter:increment'
    );
    catalog[key] = fn;
    typeToKey.set(label, key);
  }

  return { catalog, typeToKey };
}

/** Flatten action creators + string constants from catalog directly onto a feature def object.
 *  Throws if any key collides with a reserved property or a selector. */
export function flattenOnto(
  target: Record<string, unknown>,
  catalog: Record<string, unknown>,
  selectorKeys: Set<string>,
  featureName: string,
): void {
  // Validate all keys — checkReservedKeys throws with clear explanation
  checkReservedKeys(featureName, Object.keys(catalog), "action");
  for (const [key, value] of Object.entries(catalog)) {
    if (selectorKeys.has(key)) {
      throw new Error(
        `[${featureName}] action '${key}' collides with selector of same name`,
      );
    }
    target[key] = value;
  }
}

/** Bind a feature to a live app — replaces action creators with dispatch wrappers,
 *  selectors with bound state readers. Called by aio.run() after compose.
 *  All bound methods return a Promise — sync methods return Promise<void> (dispatch completion),
 *  async methods return Promise<T> (method return value). */
export function bindFeature(
  f: FeatureDef,
  dispatch: (action: Msg) => Promise<void>,
  getState: () => Record<string, unknown>,
): void {
  if (f.__aio.bound) {
    throw new Error(
      `[${f.__aio.id}] already bound — features can only bind to one app`,
    );
  }

  // Bind action creators: wrap with dispatch
  for (const key of f.__aio.actionKeys) {
    const creator = (f.__aio.actions as Record<string, unknown>)[key];
    if (typeof creator !== "function") continue;

    const isAsync = f.__aio.asyncMethods?.has(key);
    if (isAsync) {
      // Async methods: dispatch with _callId, return Promise that resolves with the method's return value
      const fn = (...args: unknown[]) => {
        const callId = crypto.randomUUID();
        const promise = registerCall(callId);
        const action = (creator as (...a: unknown[]) => Msg)(...args);
        dispatch({
          ...action,
          payload: { args, _callId: callId },
          _source: "Effect" as const,
        });
        return promise;
      };
      (fn as unknown as Record<string, unknown>).type =
        (creator as unknown as { type: string }).type;
      (f as Record<string, unknown>)[key] = fn;
    } else {
      // Sync methods: dispatch and return Promise<void> — resolves after reduce + effects
      const fn = (...args: unknown[]) =>
        dispatch((creator as (...a: unknown[]) => Msg)(...args));
      (fn as unknown as Record<string, unknown>).type =
        (creator as unknown as { type: string }).type;
      (f as Record<string, unknown>)[key] = fn;
    }
  }

  // Bind selectors: wrap with getState
  for (const [key, selectorFn] of Object.entries(f.__aio.selectors)) {
    (f as Record<string, unknown>)[key] = () => selectorFn(getState());
  }

  (f.__aio as Record<string, unknown>).bound = true;
}
