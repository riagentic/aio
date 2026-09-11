/**
 * @module
 * `import "aio/server-only"` — this file must never reach the browser.
 *
 * aio already has a convention: `*.server.ts` is server-only, the dev server
 * refuses to serve one, and the build refuses a bundle that reached one. The
 * convention is good and it has one hole — it is a FILENAME. A field report
 * (trading-app report §9.1) named the shape: you cannot always rename the file. It is
 * already imported by twenty places, it is a published module, it is generated,
 * or the name carries meaning the team relies on.
 *
 * This is the same statement, made in the file instead of in its name:
 *
 * ```ts
 * import "aio/server-only"
 *
 * export const db = new Database(Deno.env.get("DATABASE_URL")!)
 * ```
 *
 * Anything that reaches this module from the client graph is refused with the
 * importing file named, exactly as a `*.server.ts` leak is — the audit treats
 * the two identically, because they mean the same thing.
 *
 * It also throws if it is ever EVALUATED in a browser. That should be
 * unreachable (the build refuses the bundle first), and it is here for the
 * paths a build cannot see: a hand-assembled bundle, a `<script>` tag, a
 * published package someone re-bundled. A silent success there would mean a
 * database URL sitting in a file anyone can read.
 *
 * The mirror is {@linkcode module:client-only}.
 */

/** True when this isolate is a browser — no Deno, but a document and a window.
 *
 *  Deliberately NOT "has a document": aio renders server-side with happy-dom,
 *  where a document exists and the module is legitimately loaded. The absence
 *  of `Deno` is what separates the two. */
function inBrowser(): boolean {
  return typeof (globalThis as { Deno?: unknown }).Deno === "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined" &&
    typeof (globalThis as { window?: unknown }).window !== "undefined";
}

if (inBrowser()) {
  throw new Error(
    'aio/server-only: a module marked `import "aio/server-only"` was ' +
      "evaluated in a browser.\n" +
      "  Everything that module holds — keys, connection strings, queries — " +
      "is now readable by anyone with devtools.\n" +
      "  fix: import it dynamically from the cell method that needs it " +
      '(`const { db } = await import("./db.ts")`), never statically from ' +
      "client-reachable code.",
  );
}

/** Exported so the import is never tree-shaken away.
 *
 *  `import "aio/server-only"` with no binding is a side-effect import, and a
 *  minifier that proves the module has no side effects may drop the edge —
 *  taking the DECLARATION with it. A value the module exports keeps the edge
 *  in the graph, which is where the audit reads it. @internal */
export const SERVER_ONLY = true;
