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

/** How deep sibling bodies may NEST on the stack.
 *
 *  A cycle (`a` calls `b` calls `a`) is a real mistake someone will make, and
 *  without a cap it arrives as a bare RangeError naming a stack frame in the
 *  proxy — a message about aio's internals for a bug in the app's own two
 *  methods. Generous enough that no honest composition reaches it.
 *
 *  What it counts is SYNCHRONOUS nesting: sibling bodies that are on the stack
 *  at once, which is exactly what a cycle piles up before it overflows. It used
 *  to count calls whose promise had not settled yet, and those are not nested
 *  at all — `await Promise.all(ids.map((id) => s.$call.fetchOne(id)))` over 33
 *  ids was refused as "almost always a cycle" with no cycle anywhere. An async
 *  body is on the stack only until its first `await`, so a cycle that recurses
 *  before awaiting is caught by that count. A cycle that recurses AFTER an
 *  `await` is bounded by {@link MAX_CALL_CHAIN} instead. */
export const MAX_CALL_DEPTH = 32;

/** How long a CHAIN of sibling calls may get across `await`s.
 *
 *  A cycle that recurses after an `await` never grows the stack, so the stack
 *  count alone let it run forever: `async a(s) { await x; return s.$call.b() }`
 *  and its mirror chained microtasks with no macrotask in between — no timer,
 *  no I/O, no shutdown ever ran again, and RSS climbed past 3 GB. So the chain
 *  is counted too: each sibling body is handed a view of the draft whose
 *  `$call` knows how it was reached (`load → a → b → a …`), which survives an
 *  `await` because it is the body's own `s`, not a global. Parallel siblings
 *  share one link of the chain (they are all one step below their caller), so
 *  a fan-out is still depth 1 however wide it is.
 *
 *  It is a SEPARATE, much higher limit than the stack's, because across an
 *  `await` the same shape is also honest recursion: a paginated
 *  `async fetchPage(s, p) { … await s.$call.fetchPage(p + 1) }` over 40 pages
 *  was refused at 32 as "almost always a cycle", with pages 1–32 already
 *  written. Nothing a program can see tells the two apart — both repeat the
 *  same name with the same argument shape, and both may write state each step
 *  (a counter in a cycle is "progress" too). Refusing only chains with no
 *  macrotask between links would need a probe timer in the isomorphic core,
 *  would decide by event-loop timing (a fast I/O settling before a 0 ms timer
 *  or not), and would still never bound a cycle that yields to a timer. So the
 *  bound is a count, sized by what the worst case COSTS, measured: an
 *  infinite microtask-only cycle is refused after 10 000 links with ~40 ms of
 *  event-loop stall and a ~28 MB heap peak (under 3 KB a link — the link, its
 *  view, the one caller it used, the pending promise), the same on a 2-method
 *  and a 50-method cell, all released with the rejection. A cycle that awaits
 *  a 0 ms timer between links is refused after ~10 s, with timers and I/O
 *  running the whole time (~34 MB peak). */
export const MAX_CALL_CHAIN = 10_000;

/** One step of a `$call` chain — the method a body runs as, and how it was
 *  reached. Children are cached per name, so every call of one sibling from
 *  one body shares one view (and `s === s` holds across a fan-out). */
interface ChainLink {
  readonly name: string;
  readonly parent: ChainLink | undefined;
  readonly depth: number;
  readonly children: Map<string, ChainLink>;
  table?: Record<string, (...args: unknown[]) => unknown>;
  /** The callers this link's body actually used, built on first read. */
  callers?: Map<string, (...args: unknown[]) => unknown>;
  view?: unknown;
}

/** Symbol a chain view answers with the draft it stands in for — so a body
 *  that returns its own `s` from a sibling is still recognised as returning
 *  the draft. */
const CALL_VIEW_TARGET = Symbol("aio.callViewTarget");

/** The draft behind a `$call` chain view, or the value itself. @internal */
export function unwrapCallView(v: unknown): unknown {
  if (v !== null && typeof v === "object") {
    const t = (v as Record<symbol, unknown>)[CALL_VIEW_TARGET];
    if (t !== undefined) return t;
  }
  return v;
}

/** `a → b → a`, the tail of a chain — what the refusal names. */
function describeChain(link: ChainLink, next: string): string {
  const names: string[] = [next];
  for (let l: ChainLink | undefined = link; l; l = l.parent) names.push(l.name);
  names.reverse();
  const TAIL = 8;
  return names.length > TAIL
    ? `${names[0]} → … → ${names.slice(-TAIL + 1).join(" → ")}`
    : names.join(" → ");
}

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
  const root: ChainLink = {
    name: caller,
    parent: undefined,
    depth: 0,
    children: new Map(),
  };
  // The names `$call` offers, read when a table is first used — an async
  // dispatch builds its table whether or not the body says `$call`. Framework
  // plumbing (`__set*` reducer synonyms, `__effects`, `__error`) is
  // dispatch-level machinery, not methods anyone wrote.
  let names: ReadonlySet<string> | undefined;
  const callable = (): ReadonlySet<string> =>
    names ??= new Set(Object.keys(methods).filter((n) => !n.startsWith("__")));
  // The view a sibling body receives as `s`: the caller's draft in every
  // respect except `$call`, which continues the chain from `link`. Every trap
  // forwards to the draft with the draft as receiver, exactly as a direct
  // access on it would.
  const viewOf = (link: ChainLink): unknown => {
    if (link.view !== undefined) return link.view;
    const d = draft();
    if (d === null || typeof d !== "object") return (link.view = d);
    let liveView: unknown;
    const view: object = new Proxy(d as object, {
      get(t, p) {
        if (p === "$call") return tableOf(link);
        if (p === CALL_VIEW_TARGET) return t;
        const v = Reflect.get(t, p, t);
        // `s.$live` is the same draft read another way — the chain goes with
        // it, or `s.$live.$call.a()` would restart the count at zero.
        if (p === "$live" && v !== null && typeof v === "object") {
          if (v === t) return view;
          return liveView ??= new Proxy(v, {
            get(lt, lp) {
              const lv = Reflect.get(lt, lp, lt);
              return lp === "$call" && lv !== undefined ? tableOf(link) : lv;
            },
          });
        }
        return v;
      },
      set: (t, p, v) => Reflect.set(t, p, v, t),
      has: (t, p) => Reflect.has(t, p),
      deleteProperty: (t, p) => Reflect.deleteProperty(t, p),
      ownKeys: (t) => Reflect.ownKeys(t),
      getOwnPropertyDescriptor: (t, p) =>
        Reflect.getOwnPropertyDescriptor(t, p),
      defineProperty: (t, p, desc) => Reflect.defineProperty(t, p, desc),
      getPrototypeOf: (t) => Reflect.getPrototypeOf(t),
      setPrototypeOf: (t, proto) => Reflect.setPrototypeOf(t, proto),
      isExtensible: (t) => Reflect.isExtensible(t),
      preventExtensions: (t) => Reflect.preventExtensions(t),
    });
    return (link.view = view);
  };
  const callerOf = (
    link: ChainLink,
    name: string,
  ): (...args: unknown[]) => unknown => {
    const callers = link.callers ??= new Map();
    const known = callers.get(name);
    if (known) return known;
    const fn = methods[name]!;
    const caller = (...args: unknown[]) => {
      if (sync && isAsyncFunction(fn)) {
        throw new Error(
          `[${prefix}:${link.name}] s.$call.${name}() — "${name}" is ASYNC ` +
            `and "${link.name}" is not, so there is no way to await it ` +
            `here.\n` +
            `  fix: make "${link.name}" async (\`async ${link.name}(s, …)\`), ` +
            `or call "${name}" the ordinary way — ${prefix}.${name}(…) — ` +
            `which dispatches it as its own method with its own draft.`,
        );
      }
      if (depth.n >= MAX_CALL_DEPTH) {
        throw new Error(
          `[${prefix}:${link.name}] s.$call.${name}() exceeded ` +
            `${MAX_CALL_DEPTH} nested sibling calls — this is almost always ` +
            `a cycle (a method that calls one that calls it back). $call ` +
            `runs the sibling's BODY inline, so a cycle recurses rather ` +
            `than queueing.\n  chain: ${describeChain(link, name)}`,
        );
      }
      if (link.depth >= MAX_CALL_CHAIN) {
        throw new Error(
          `[${prefix}:${link.name}] s.$call.${name}() exceeded ` +
            `${MAX_CALL_CHAIN} chained sibling calls — this is almost always ` +
            `a cycle that recurses after an \`await\` (a method that calls one ` +
            `that calls it back). If it is honest recursion that deep, write ` +
            `it as a loop in one method: every link of a $call chain stays ` +
            `alive until the whole chain settles.\n  chain: ` +
            describeChain(link, name),
        );
      }
      let child = link.children.get(name);
      if (!child) {
        child = {
          name,
          parent: link,
          depth: link.depth + 1,
          children: new Map(),
        };
        link.children.set(name, child);
      }
      depth.n++;
      try {
        const view = viewOf(child);
        const out = (fn as (s: unknown, ...a: unknown[]) => unknown)(
          view,
          ...args,
        );
        // A sibling that hands back its `s` hands back the caller's draft,
        // as it did before bodies got their own view. (An ASYNC sibling's
        // `return s` resolves to the view — unwrapping it would cost the
        // caller a microtask, which moves where the batcher cuts commits.)
        return out === view ? draft() : out;
      } finally {
        // Once, when the body leaves the stack — for an async sibling that
        // is its first `await`. Holding the count until the promise settled
        // made parallel siblings look nested; deciding "sync or async"
        // separately from "returned a promise" decremented twice for a plain
        // function that returns one, driving the count negative. The chain
        // depth above is what still bounds a cycle past an `await`.
        depth.n--;
      }
    };
    callers.set(name, caller);
    return caller;
  };
  // A table per link, and a link per step of a chain — so what a table costs
  // is what every step of a deep chain costs. It used to hold a caller for
  // EVERY method of the cell, built up front: ~10 KB a link on a 50-method
  // cell, where a body typically uses one. The table answers like the plain
  // object it was (own enumerable keys, `in`, `Object.keys` in a refusal) but
  // builds a caller only when one is read.
  const tableOf = (
    link: ChainLink,
  ): Record<string, (...args: unknown[]) => unknown> => {
    if (link.table) return link.table;
    const has = (p: string | symbol): p is string =>
      typeof p === "string" && callable().has(p);
    const table = new Proxy(
      {} as Record<string, (...args: unknown[]) => unknown>,
      {
        get: (t, p) => has(p) ? callerOf(link, p) : Reflect.get(t, p),
        has: (t, p) => has(p) || Reflect.has(t, p),
        ownKeys: () => [...callable()],
        getOwnPropertyDescriptor: (_t, p) =>
          has(p)
            ? {
              value: callerOf(link, p),
              writable: false,
              enumerable: true,
              configurable: true,
            }
            : undefined,
        // It was a plain object nobody wrote to; a write now would land on
        // the hidden target and be shadowed by the trap above — refuse it
        // rather than let it look like it worked.
        set: () => false,
        defineProperty: () => false,
        deleteProperty: () => false,
      },
    );
    // The root table is wrapped by the executor; a child is reached only from
    // a view, so it carries the same refusal for a typo'd name here.
    return (link.table = link === root
      ? table
      : withUnknownCallRefusal(prefix, link.name, table));
  };
  return tableOf(root);
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
      if (typeof p !== "string") return Reflect.get(t, p);
      // OWN keys only. `p in t` walks the prototype chain, so every name on
      // `Object.prototype` answered as if it were a sibling: `s.$call
      // .constructor()` returned `{}` and `s.$call.toString()` returned
      // "[object Object]" — silently, where a typo gets the excellent refusal
      // below. It also made the `constructor` line under it dead code, since
      // `"constructor" in t` was always true and returned `Object` rather
      // than the `undefined` this said it wanted.
      if (Object.hasOwn(t, p)) return Reflect.get(t, p);
      // A few well-known probes must stay silent: a thrown error from one of
      // these turns `await`, spread and logging into a crash.
      if (p === "then" || p === "toJSON" || p === "constructor") {
        return undefined;
      }
      // The REST of `Object.prototype` is coercion and inspection —
      // `toString`, `valueOf`, `hasOwnProperty`. Those must keep answering
      // with the inherited implementation or `${table}`, `console.log` and
      // every structural check on this object throw. They are not siblings,
      // and nobody reaches them meaning to call one.
      if (p in t) return Reflect.get(t, p);
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
