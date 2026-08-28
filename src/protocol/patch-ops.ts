// patch-ops.ts — the wire patch vocabulary: Immer's three ops plus `append`.
//
// A streamed reply is a string that GROWS. Immer can only describe growth as
// `replace` carrying the whole string, so every broadcast window re-sent the
// entire reply — quadratic in the reply's length, and measured at 33
// broadcasts/sec against aio's own 30/sec pressure threshold in three
// production apps. `append` carries the suffix instead: applying it is
// `base[path] = base[path] + value`.
//
// ONE decider, every consumer:
//   • decided in src/state/patch-compact.ts (`narrowStringPatches`) at patch
//     GENERATION — the last place the previous slice is in hand;
//   • applied by every peer that applies a `patches` frame through
//     `applyWirePatches` below: the browser (state-message.ts), the CLI/UDS
//     client (cli-client.ts) and the worker-cell host (cell-compose-reduce.ts).
//     A consumer that hands `append` to Immer directly throws — the op is
//     unknown to it — so a forgotten consumer fails loud, never silent.
//
// Protocol v3 (protocol-version.ts): a v2 peer cannot apply `append` and is
// refused at the handshake with the reason named.
//
// Browser-safe: pure functions, imports only immer.
import { applyPatches, type Patch } from "immer";

/** `append`: the string at `path` grew by `value` (old value is a prefix of
 *  the new one). Never emitted below `APPEND_MIN_LENGTH`. */
export type AppendPatch = {
  op: "append";
  path: (string | number)[];
  value: string;
};

/** Everything a `patches` frame may carry. */
export type WirePatch = Patch | AppendPatch;

/** A string shorter than this stays a `replace`: below it the op's own
 *  overhead outweighs the saving, and a tiny value is cheaper to overwrite
 *  than to reason about. Measured in UTF-16 code units (`String.length`) —
 *  the unit JSON.stringify's output length is compared in downstream. */
export const APPEND_MIN_LENGTH = 256;

/** Resolve `path` in `root`, or undefined if any hop is missing. */
function valueAt(root: unknown, path: readonly (string | number)[]): unknown {
  let cur = root;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/**
 * Rewrite every `append` in `ops` as the `replace` it stands for, against the
 * value the state holds at that path AS THE OPS APPLY — not against `base`
 * alone. A coalesced frame carries several dispatches: `remove items[0]` from
 * one and `append items[0].text` from the next. Resolved against `base`, that
 * append would extend the DELETED row's text — a plausible string, silently
 * wrong. So the Immer ops before each append are applied first (structurally
 * shared, so this is cheap) and the append reads the result.
 *
 * Throws when the value there is not a string: an append onto something else
 * means the two sides disagree about the state, which is a desync — every
 * caller already treats a throw here as "request a full resync".
 */
export function expandAppends(
  base: unknown,
  ops: readonly WirePatch[],
): Patch[] {
  let out: Patch[] | null = null;
  let state = base;
  let applied = 0; // ops[0..applied) are folded into `state`
  for (let i = 0; i < ops.length; i++) {
    const p = ops[i]!;
    if (p.op !== "append") {
      out?.push(p);
      continue;
    }
    out ??= ops.slice(0, i) as Patch[];
    if (applied < i) {
      state = applyPatches(state as object, out.slice(applied, i));
      applied = i;
    }
    const cur = valueAt(state, p.path);
    if (typeof cur !== "string") {
      throw new Error(
        `Cannot apply append at /${p.path.join("/")}: the state holds ${
          cur === undefined ? "nothing" : typeof cur
        }, not a string`,
      );
    }
    if (typeof p.value !== "string") {
      throw new Error(
        `Cannot apply append at /${p.path.join("/")}: value is ${typeof p
          .value}`,
      );
    }
    out.push({ op: "replace", path: p.path, value: cur + p.value });
  }
  return out ?? (ops as Patch[]);
}

/** Apply a `patches` frame — Immer ops and `append` alike — to `base`.
 *  The one function every consumer of a delta goes through. */
export function applyWirePatches<T>(base: T, ops: readonly WirePatch[]): T {
  return applyPatches(base as object, expandAppends(base, ops)) as T;
}
