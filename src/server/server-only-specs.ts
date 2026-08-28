// server-only-specs.ts — THE list of aio's own entries that cannot run in a
// browser, and the reason each one is on it.
//
// Three files carried their own copy of this set: graph-validator.ts
// (`SERVER_ONLY_SPECS`), lint.ts and server-html-classify.ts. Each copy had a
// comment naming the other two, which is the repo admitting a fact was spelled
// three times rather than fixing it. They agreed on `aio/server` and on
// nothing else, because nothing else was ever there.
//
// What that cost: `aio/db` is the entry the docs tell every app to use for
// SQLite (`import { createDB } from "aio/db"`), it is absent from the browser
// import map on purpose, and it was on none of the three lists. So a component
// importing it fell through to the generic advice — "add `npm:aio/db` to
// deno.json" — which is the exact advice the comment beside each list calls
// actively harmful: that package does not exist, so the user edits deno.json,
// restarts, and lands on the same blank page. `aio/build`, `aio/ship` and
// `aio/testing` had the same gap.
//
// Membership means one thing: importing this from a browser-reachable file is
// a CATEGORY error the framework can name exactly, not a missing dependency.
// The documented dynamic escape hatch (`await import("aio/server")` inside a
// cell method) is unaffected — only a STATIC import from an eagerly-reachable
// file is reported.
//
// Deliberately NOT here: `aio/extras` and `aio/sync`. Both entries pull server
// code (`parseCli`/`instances`, `server-handler.ts`), so importing either from
// a page is a mistake — but a bundler may tree-shake an app down to the part
// that does work, and turning today's working build into a refusal is not a
// fix. `tests/entry-classification.test.ts` holds them as a named, deliberate
// gap rather than letting them sit in an unwatched middle.

/** aio's own entries that cannot resolve — or cannot run — in a browser. */
export const SERVER_ONLY_SPECS: ReadonlySet<string> = new Set([
  "aio/server", // SQLite, workers, the filesystem
  "aio/db", // createDB — the SQLite worker
  "aio/build", // esbuild, deno compile
  "aio/ship", // release signing, the filesystem
  "aio/cli", // Deno.stdin/stdout, a terminal — never a page
  "aio/testing", // the test harness, which boots servers
  // CLI entrypoints. Meant for `deno run`, not for an import at all — but a
  // browser cannot run any of them, and "this is a server entry" is the right
  // thing to say to whoever tries. Cheaper than a third category that would
  // differ from this one only in prose.
  "aio/build-all",
  "aio/dev-android",
  "aio/android-install",
  "aio/electron-install",
  "aio/am",
  "aio/amui",
  "aio/doctor",
  "aio/aiol",
]);
