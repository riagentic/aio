// contexts.ts — THE execution-context vocabulary. Every surface that tells a
// person WHERE their code is running — an error, a lint finding, `am where`,
// the docs — names the context from this table and nowhere else.
//
// Why one module, and why here. aio has one syntax and six places it executes,
// and almost nothing in a source file says which one you are in. That
// invisibility is what makes the framework pleasant to write, and it is where
// the expensive bugs live: a `Deno.*` call in a module the browser links, a
// `visible.exclude` read in a reducer that replays client-side, a static
// `*.server.ts` import. A reader survives that only by building a map — and a
// map cannot be built from a vocabulary that changes per file.
//
// It changed per file. The same idea — "the side your UI runs on" — was
// spelled `browser`, `renderer`, `standalone`, `isolate` and `client context`
// across `src/`, and one message named three of them in a single sentence
// ("enforced on ALL client reads (browser and standalone/electron alike)").
// Each of those words ALSO has a legitimate narrow meaning — a build target, a
// log tag, an Electron process, a thread — so the fix is not a rename. It is
// this: when a message means THE CONTEXT, it says the context's name from
// here; when it means the browser specifically, it still says browser.
//
// It lives in `diagnostics/` for the same reason `fmt.ts` does — the folder
// every other folder may already import (scripts/check-boundaries.ts). A copy
// anywhere else is how one surface keeps teaching the old words.
//
// Everything here is DATA and pure functions over it, so the docs table, the
// `am where` verdicts and the error strings are three renderings of one fact
// rather than three claims that happen to agree today.

/** The two SIDES. Every context below is on exactly one of them, and this is
 *  the word for it — `client context` won because it is the only one of the
 *  five that says what it means without naming a runtime. */
export const SIDE = {
  client: "client context",
  server: "server context",
} as const;

export type Side = keyof typeof SIDE;

/** One execution context: what runs there, and what is true of it. */
export type ContextSpec = {
  /** THE name. Used verbatim in every error, lint finding and doc row. */
  readonly name: string;
  /** Which side it runs on. */
  readonly side: Side;
  /** How you get there — the "reached by" column. */
  readonly reachedBy: string;
  /** Are `Deno.*`, `@std/*`, the filesystem and the network available? */
  readonly deno: boolean;
  /** Can it read fields `visible.exclude` hides? */
  readonly hiddenFields: boolean;
  /** Does a signal read here subscribe the caller? */
  readonly tracked: boolean;
  /** The one thing that surprises people, in a clause. */
  readonly surprise: string;
};

/** THE six. Order is the reading order of the table in
 *  `docs/basics/where-code-runs.md`, which is generated from this. */
export const CONTEXTS: readonly ContextSpec[] = Object.freeze(
  [
    {
      name: "a component body",
      side: "client",
      reachedBy: "AIR renders it",
      deno: false,
      hiddenFields: false,
      tracked: true,
      surprise: "the only window where a read subscribes",
    },
    {
      name: "an event handler",
      side: "client",
      reachedBy:
        "a click, a lifecycle hook, a timer, anything after an `await`",
      deno: false,
      hiddenFields: false,
      tracked: false,
      surprise: "reads here do not subscribe — the body already returned",
    },
    {
      name: "a sync method",
      side: "server",
      reachedBy: "`cell.method()`",
      deno: false,
      hiddenFields: false,
      tracked: false,
      surprise:
        'under `sync`/`localFirst`/`scope:"client"` it ALSO runs in the browser',
    },
    {
      name: "an async method",
      side: "server",
      reachedBy: "`await cell.method()`",
      deno: true,
      hiddenFields: true,
      tracked: false,
      surprise: "a call ceiling; `serialize` holds a per-cell mutex",
    },
    {
      name: "a `*.server.ts` module",
      side: "server",
      reachedBy: "`await import()` from server code only",
      deno: true,
      hiddenFields: true,
      tracked: false,
      surprise: "a STATIC import of one is refused, loudly",
    },
    {
      name: "a worker isolate",
      side: "server",
      reachedBy: "a method on a `worker: true` cell",
      deno: true,
      hiddenFields: true,
      tracked: false,
      surprise: "its own isolate — no shared module state, no peer cells",
    },
  ] as const,
);

/** Look one up by name. Throws rather than returning undefined: a caller
 *  naming a context that does not exist is a typo in a message, and a typo in
 *  a message is exactly what this module exists to make impossible. */
export function context(name: string): ContextSpec {
  const hit = CONTEXTS.find((c) => c.name === name);
  if (!hit) {
    throw new Error(
      `[aio] internal: "${name}" is not one of the execution contexts — ` +
        `use one of: ${CONTEXTS.map((c) => c.name).join(", ")} ` +
        `(src/diagnostics/contexts.ts). This is an aio bug, not yours.`,
    );
  }
  return hit;
}

/** ⚠️ There is deliberately NO `youAreIn(name)` helper.
 *
 *  One existed for a day. It rendered *you are in X (side)* from a context's
 *  DECLARED side — and the first refusal to use it was the hidden-read guard
 *  for a sync method REPLAYING in the browser, where the declared side
 *  (server) is precisely the wrong answer. It told a reader "server context"
 *  at the one moment the whole problem was that they were in client context.
 *
 *  A context's declared side is not always the side it is running on. Any
 *  helper that hides that distinction will be reached for exactly where it
 *  does the most damage, so the refusal names the side it OBSERVED
 *  (`SIDE.client` / `SIDE.server`) and the context by name. §4.2's one-shape
 *  goal is served by that pairing, not by a wrapper that guesses the half it
 *  cannot see.
 */

/** A context and its caveat, as ONE clause — the only supported way to put a
 *  `surprise` into a sentence.
 *
 *  Every `surprise` is written from inside its OWN context ("reads here do not
 *  subscribe", "it ALSO runs in the browser"), so interpolating one after a
 *  lead-in that already names a context produces a line that contradicts or
 *  repeats itself. Both shipped, in the same afternoon, in two different files:
 *
 *    a read subscribes ONLY in a component body — reads here do not subscribe
 *    a sync method of a `sync` cell under `sync`/`localFirst` it ALSO runs …
 *
 *  Reading the code did not catch either; running the command did. So the raw
 *  field is off limits outside this module — `tests/context-vocabulary.test.ts`
 *  enforces that — and this renders the one shape that always reads. */
export function contextNote(name: string): string {
  const c = context(name);
  return `${c.name} — ${c.surprise}`;
}

/** The one line pointing at the map. Every context refusal ends with it, so a
 *  reader who wants the whole table always knows it exists. */
export const WHERE_DOC = "docs/basics/where-code-runs.md";
export const WHERE_HINT =
  `which context is this? ${WHERE_DOC} — or run \`am where <file>\``;
