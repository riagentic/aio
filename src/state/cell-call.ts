/**
 * @module
 * `s.$call.sibling(args)` — one cell method calling another, on the same draft.
 *
 * Three field reports reached for this and all three workarounds are wrong
 * (report 8 §6/§9, report 3 §6):
 *
 *   `this.bench(...)`     cannot type-check — the declared method takes the
 *                         draft, the callable one does not.
 *   `myCell.bench(...)`   a SECOND dispatch with its own draft: the caller's
 *                         uncommitted writes are invisible to it, and its
 *                         writes land in a different commit.
 *   a module-level helper works, and is the dangerous one. Moved out of the
 *                         cell, a post-await read is no longer analysed by
 *                         `aiol`, so the absence of a warning starts meaning
 *                         "not analysed" while still reading as "fine".
 *
 * So the sibling's body runs against the CALLER'S draft, in the caller's
 * commit, and returns what it returns. No dispatch, no second draft, no
 * journal entry — it is one method, spelled in two places.
 */
import { isAsyncFunction, type Method } from "./cell-impl.ts";

/** How deep a chain of sibling calls may go.
 *
 *  A cycle (`a` calls `b` calls `a`) is a real mistake someone will make, and
 *  without a cap it arrives as a bare RangeError naming a stack frame in the
 *  proxy — a message about aio's internals for a bug in the app's own two
 *  methods. Generous enough that no honest composition reaches it. */
export const MAX_CALL_DEPTH = 32;

/** Build the `$call` table for one invocation.
 *
 *  `draft()` is deferred because the table is built before the draft it binds
 *  to exists — the wrapper needs the table, the table needs the wrapper.
 *
 *  `sync` says whether the CALLER is a sync method. A sync method cannot
 *  await, so calling an async sibling from one is refused by name rather than
 *  left to float: an unawaited promise writing into the draft after the commit
 *  would land its changes in somebody else's tick, which is a data bug that
 *  presents as "sometimes it works". */
export function buildCallTable(
  prefix: string,
  caller: string,
  methods: Record<string, Method<Record<string, unknown>>>,
  draft: () => unknown,
  sync: boolean,
  depth: { n: number } = { n: 0 },
): Record<string, (...args: unknown[]) => unknown> {
  const table: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of Object.keys(methods)) {
    // Framework plumbing — `__set*` reducer synonyms, `__effects`, `__error`.
    // They are dispatch-level machinery, not methods anyone wrote.
    if (name.startsWith("__")) continue;
    const fn = methods[name]!;
    table[name] = (...args: unknown[]) => {
      if (sync && isAsyncFunction(fn)) {
        throw new Error(
          `[${prefix}:${caller}] s.$call.${name}() — "${name}" is ASYNC and ` +
            `"${caller}" is not, so there is no way to await it here.\n` +
            `  fix: make "${caller}" async (\`async ${caller}(s, …)\`), or ` +
            `call "${name}" the ordinary way — ${prefix}.${name}(…) — which ` +
            `dispatches it as its own method with its own draft.`,
        );
      }
      if (depth.n >= MAX_CALL_DEPTH) {
        throw new Error(
          `[${prefix}:${caller}] s.$call.${name}() exceeded ${MAX_CALL_DEPTH} ` +
            `nested sibling calls — this is almost always a cycle (a method ` +
            `that calls one that calls it back). $call runs the sibling's ` +
            `BODY inline, so a cycle recurses rather than queueing.`,
        );
      }
      depth.n++;
      try {
        const s = draft();
        const out = (fn as (s: unknown, ...a: unknown[]) => unknown)(
          s,
          ...args,
        );
        // An async sibling from an async caller: the depth has to survive the
        // await, or a chain of awaited calls never counts past one.
        if (out instanceof Promise) {
          return out.finally(() => {
            depth.n--;
          });
        }
        return out;
      } finally {
        // Sync path only — the async path decrements in its own `finally`, and
        // decrementing twice would make the cap meaningless.
        if (!isAsyncFunction(fn)) depth.n--;
      }
    };
  }
  return table;
}

/** The refusal for a name that is not a method of this cell.
 *
 *  Served from a Proxy rather than by omission: `s.$call.bnech(1)` on a plain
 *  object is `undefined is not a function`, which names neither the cell nor
 *  the typo nor what else was available. */
export function withUnknownCallRefusal(
  prefix: string,
  caller: string,
  table: Record<string, (...args: unknown[]) => unknown>,
): Record<string, (...args: unknown[]) => unknown> {
  return new Proxy(table, {
    get(t, p) {
      if (typeof p !== "string" || p in t) {
        return Reflect.get(t, p);
      }
      // A few well-known probes must stay silent: a thrown error from one of
      // these turns `await`, spread and logging into a crash.
      if (p === "then" || p === "toJSON" || p === "constructor") {
        return undefined;
      }
      throw new Error(
        `[${prefix}:${caller}] s.$call.${p}() — "${prefix}" has no method ` +
          `"${p}". Available: ${Object.keys(t).sort().join(", ") || "(none)"}`,
      );
    },
    has: (t, p) => Reflect.has(t, p),
    ownKeys: (t) => Reflect.ownKeys(t),
    getOwnPropertyDescriptor: (t, p) => Reflect.getOwnPropertyDescriptor(t, p),
  });
}
