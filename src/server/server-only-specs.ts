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

/** aio's own browser-reachable entry files, by the tail of their path. The
 *  bundler names the RESOLVED file, not the specifier the author wrote. */
const ENTRY_FOR_FILE: ReadonlyArray<[string, string]> = [
  ["src/server-entry.ts", "aio/server"],
  ["src/db/mod.ts", "aio/db"],
  ["src/cell-test.ts", "aio/testing"],
  ["src/cli.ts", "aio/cli"],
  ["src/build.ts", "aio/build"],
  ["src/build/ship.ts", "aio/ship"],
];

/**
 * The bundler's "no matching export" error, said in aio's words.
 *
 * A component that does `import { route } from "aio/server"` — the single most
 * likely mistake a new author makes, because the API they want IS on that
 * entry — got esbuild's own sentence:
 *
 *     No matching export in "../../../../../../home/x/.aio/versions/v1.0.0-
 *     alpha72/src/server-entry.ts" for import "route"
 *
 * which names the rule nowhere, the fix nowhere, and a path with seven `../`
 * in it. The browser build maps `aio/server` to a browser-safe SUBSET, so the
 * import resolves and only the NAME is missing — which is why the server-only
 * specifier check never sees it and why the message that reaches the author is
 * the bundler's.
 *
 * Returns null for any error this does not recognise, so an unrelated failure
 * keeps its own words.
 */
export function explainServerOnlyImport(
  text: string,
  file?: string,
  line?: number,
): string | null {
  const m = /No matching export in "([^"]+)" for import "([^"]+)"/.exec(text);
  if (!m) return null;
  const resolved = m[1]!.replaceAll("\\", "/");
  const name = m[2]!;
  const hit = ENTRY_FOR_FILE.find(([tail]) => resolved.endsWith(tail));
  if (!hit) return null;
  const spec = hit[1];
  // esbuild sometimes THROWS an aggregate ("Build failed with 1 error:\n
  // src/App.tsx:2:9: ERROR: …") instead of returning structured errors, and
  // that string is all the caller has. The location is in it either way.
  if (!file) {
    const loc = /(^|\n)\s*([^\s:]+\.[jt]sx?):(\d+):\d+:/.exec(text);
    if (loc) {
      file = loc[2];
      line = Number(loc[3]);
    }
  }
  const at = file ? `${file}${line ? `:${line}` : ""}` : "a browser file";
  return `\`${name}\` is a SERVER API, and this is the browser bundle.\n` +
    `  ${at} imports { ${name} } from "${spec}", which a page cannot run — ` +
    `it needs the filesystem, workers or SQLite.\n` +
    `  • Server work belongs in a cell METHOD or the app entry; a component ` +
    `reads the result from cell state.\n` +
    `  • The documented escape hatch is a DYNAMIC import inside a method: ` +
    `\`await import("${spec}")\` — a static import from a component is not.\n` +
    `  • "${spec}" resolves in the browser build to the subset that CAN run ` +
    `there, which is why the file resolved and only the name did not.`;
}
