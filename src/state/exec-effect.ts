// exec-effect.ts — the one effect whose payload is not the executor's to copy.
//
// Every effect is structured-cloned on its way out of a reduce (twice: once
// inside `produce`, while the draft is alive — cell-compose-reduce.ts — and
// once more generically in dispatch.ts), so an effect can never carry a revoked
// Immer draft or be mutated by the reducer that built it. `cell:__exec` is the
// exception: it carries the CALLER'S ARGUMENTS, which are what the async method
// is called with, not a payload the framework owns.
//
// Structured-cloning them made an async method a different function from its
// sync twin. A function argument could not be cloned, so the whole effect was
// DROPPED — the method never ran and its caller's `await` resolved `undefined`
// (or waited out the call ceiling), with one ERROR line naming an internal
// effect nobody wrote — and a class instance arrived as a plain object with its
// prototype gone. A sync method receives the raw value, and
// docs/state/methods.md promises "in-process callers always get the raw value".
// JSON applies at the network boundary, and is guarded there.

import type { Msg } from "./cell-types.ts";

/** `cell:__exec` — the effect that runs an async method's body. */
export function isExecEffect(eff: unknown): eff is Msg {
  const type = (eff as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.endsWith(":__exec");
}

/** Clone an `__exec` effect for dispatch, EXCEPT its `_args`: everything the
 *  framework put in the envelope is copied like any other effect, and the
 *  arguments pass through `detachArgs` (identity by default) — the caller's
 *  values by reference, exactly as a sync method receives them. */
export function cloneExecEffect(
  eff: Msg,
  detachArgs: (args: unknown[]) => unknown = (a) => a,
): Msg {
  const payload = (eff as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== "object") {
    return structuredClone(eff);
  }
  const { _args, ...rest } = payload as Record<string, unknown>;
  const { payload: _p, ...envelope } = eff as Msg & { payload?: unknown };
  return {
    ...structuredClone(envelope),
    payload: {
      ...structuredClone(rest),
      _args: Array.isArray(_args) ? detachArgs(_args) : structuredClone(_args),
    },
  } as Msg;
}
