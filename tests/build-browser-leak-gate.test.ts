// A STATIC server-only import in the client graph must FAIL the build.
//
// The stub the plugin substitutes for `@std/*` / `node:*` is correct for the
// DYNAMIC form — `await import("node:sqlite")` inside a method body is dead
// code in the browser. Statically imported at the top of a module the client
// reaches, the same stub turns every use into a throw at first access, and the
// symptom is a blank page with "1 module error", nowhere near the cause.
//
// A production consumer shipped exactly that: a cell value-imported a module
// touching `node:sqlite`, the client bundle broke in prod, and their entire
// test suite stayed green because tests render SERVER-side where `node:sqlite`
// exists. They ended up writing their own test to police aio's bundler. This
// is that check, upstream.
import { assert, assertEquals } from "@std/assert";
import {
  _resetServerOnlyStatic,
  aioBrowserPlugin,
  serverOnlyDynamic,
  serverOnlyStatic,
} from "../src/build/esbuild-plugin.ts";

/** A minimal stand-in for esbuild's plugin host: collects the onResolve
 *  handlers, then lets a test push resolutions through them. */
function host() {
  const resolvers: Array<
    // deno-lint-ignore no-explicit-any
    { filter: RegExp; fn: (a: any) => unknown }
  > = [];
  const build = {
    // deno-lint-ignore no-explicit-any
    onResolve(opts: { filter: RegExp }, fn: (a: any) => unknown) {
      resolvers.push({ filter: opts.filter, fn });
    },
    onLoad() {},
  };
  aioBrowserPlugin().setup(build);
  return (path: string, kind: string, importer: string) => {
    for (const r of resolvers) {
      if (r.filter.test(path)) return r.fn({ path, kind, importer });
    }
    return undefined;
  };
}

Deno.test("bundle gate: a STATIC node:/@std: import is recorded, with its importer", () => {
  _resetServerOnlyStatic();
  const resolve = host();
  resolve("node:sqlite", "import-statement", "/app/src/db.ts");
  resolve("@std/path", "import-statement", "/app/src/util.ts");
  assertEquals(
    [...(serverOnlyStatic["node:sqlite"] ?? [])],
    ["/app/src/db.ts"],
    'the IMPORTER is the whole answer to "which file?"',
  );
  assertEquals([...(serverOnlyStatic["@std/path"] ?? [])], [
    "/app/src/util.ts",
  ]);
});

Deno.test("bundle gate: the DYNAMIC form is the documented pattern, not a leak", () => {
  _resetServerOnlyStatic();
  const resolve = host();
  resolve("node:sqlite", "dynamic-import", "/app/src/cell.ts");
  resolve("@std/path", "dynamic-import", "/app/src/cell.ts");
  assertEquals(
    Object.keys(serverOnlyStatic).length,
    0,
    "`await import(...)` inside a method is server-side and stays out of the " +
      "client graph — flagging it would break the sanctioned escape hatch",
  );
});

Deno.test("bundle gate: both forms still resolve to the stub namespace", () => {
  _resetServerOnlyStatic();
  const resolve = host();
  for (const kind of ["import-statement", "dynamic-import"]) {
    const r = resolve("node:fs", kind, "/app/src/x.ts") as {
      namespace?: string;
    };
    assertEquals(
      r?.namespace,
      "aio-server-only",
      "recording must not change what the bundle contains",
    );
  }
});

Deno.test("bundle gate: one specifier reached from two files names both", () => {
  _resetServerOnlyStatic();
  const resolve = host();
  resolve("node:sqlite", "import-statement", "/app/src/a.ts");
  resolve("node:sqlite", "import-statement", "/app/src/b.ts");
  const importers = [...(serverOnlyStatic["node:sqlite"] ?? [])].sort();
  assertEquals(importers, ["/app/src/a.ts", "/app/src/b.ts"]);
});

Deno.test("bundle gate: a reset clears the previous build's findings", () => {
  _resetServerOnlyStatic();
  const resolve = host();
  resolve("node:sqlite", "import-statement", "/app/src/a.ts");
  assert(Object.keys(serverOnlyStatic).length > 0);
  _resetServerOnlyStatic();
  assertEquals(Object.keys(serverOnlyStatic).length, 0);
});

Deno.test("bundle gate: a STATIC *.server.ts import is recorded too", () => {
  // The suffix convention is load-bearing and this was its one silent hole —
  // a wallet's field report (RIS-8.2) blank-screened the whole app on a
  // static import chain while typecheck, lint AND the suite stayed green.
  _resetServerOnlyStatic();
  const resolve = host();
  resolve("./io.server.ts", "import-statement", "/app/src/cell.ts");
  assertEquals(
    [...(serverOnlyStatic["./io.server.ts"] ?? [])],
    ["/app/src/cell.ts"],
  );
});

Deno.test("bundle gate: the DYNAMIC *.server.ts form stays the escape hatch", () => {
  _resetServerOnlyStatic();
  const resolve = host();
  const r = resolve("./io.server.ts", "dynamic-import", "/app/src/cell.ts") as {
    external?: boolean;
  };
  assertEquals(r?.external, true, "externalized, exactly as before");
  assertEquals(Object.keys(serverOnlyStatic).length, 0);
});

// A STANDALONE APK has no Deno runtime (R-13). The dynamic
// `await import("./x.server.ts")` that is correct on every other target — a
// cell method runs server-side, so the import deliberately stays out of the
// browser graph — is, there, the half of the app that does the work silently
// not shipping. the remote-desktop agent (screenrecord, `wm size`, FFI) built to 3.2 MB,
// printed BUILD SUCCESSFUL, installed, launched, rendered its panel, and every
// switch did nothing; the Windows build of the same entry is 180 MB because it
// carries a runtime. Discovering that after installing on a phone is the
// expensive kind of failure.
Deno.test("android: server-only reach is recorded separately from a static leak", () => {
  _resetServerOnlyStatic();
  const resolve = host();

  // The sanctioned pattern: dynamic, from a method. NOT a static leak…
  resolve("./link.server.ts", "dynamic-import", "/app/src/cell.ts");
  assertEquals(
    Object.keys(serverOnlyStatic).length,
    0,
    "dynamic is not a leak",
  );
  // …but it IS server-only REACH, which is what a standalone APK must refuse:
  // there is no Deno runtime in a WebView to run the module behind it.
  assertEquals(Object.keys(serverOnlyDynamic), ["./link.server.ts"]);
  assert(serverOnlyDynamic["./link.server.ts"]!.has("/app/src/cell.ts"));

  // A dynamic node: import counts the same way — same reason, same absence.
  resolve("node:sqlite", "dynamic-import", "/app/src/db.ts");
  assert(serverOnlyDynamic["node:sqlite"]!.has("/app/src/db.ts"));
  assertEquals(Object.keys(serverOnlyStatic).length, 0);

  // A STATIC one stays what it always was: a leak, on every target.
  resolve("node:sqlite", "import-statement", "/app/src/cell.ts");
  assert(serverOnlyStatic["node:sqlite"]!.has("/app/src/cell.ts"));

  _resetServerOnlyStatic();
  assertEquals(Object.keys(serverOnlyDynamic).length, 0, "reset clears both");
});

// …and the artifact must be GONE when it does (R-13, fourth pass).
//
// The three refusals above all happen after esbuild has written `dist/app.js`
// and before the build records its inputs — the one window in which an
// artifact exists that no gate has passed. A bare `Deno.exit()` anywhere in
// that window leaves it on disk, newer than every input, for the next run of
// the same command to report as `cached` and ship. That is not a thing to
// remember at each new refusal site; every exit in the window goes through
// `refuseBundle()`, which discards first, and this holds the next one to it.
Deno.test("bundle refusal: no exit inside the rebuild window skips the discard", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/build/build-bundle.ts", import.meta.url),
  );
  // The window opens where esbuild WRITES the artifact. Before that point
  // dist/ has already been cleaned, so a refusal there (e.g. a bad `share`)
  // leaves nothing behind — that half is pinned separately below.
  const start = src.indexOf("const bundleFresh = await isBundleFresh(cfg);");
  const from = src.indexOf("const result = await esbuild.build({", start);
  const to = src.indexOf("await writeBundleInputs(", from);
  assert(
    start > 0 && from > start && to > from,
    "the rebuild window moved — re-anchor this gate",
  );
  const before = src.slice(start, from);
  const cleaned = before.indexOf(
    "await Deno.remove(dist, { recursive: true })",
  );
  const firstExit = before.search(/Deno\.exit\(/);
  assert(
    cleaned > 0 && (firstExit < 0 || firstExit > cleaned),
    "a refusal before esbuild must come AFTER dist/ is cleaned, or a stale " +
      "dist/app.js survives it",
  );
  const window = src.slice(from, to);
  assert(
    window.includes("await refuseBundle("),
    "the window must still refuse through the discarding path",
  );
  assertEquals(
    window.match(/Deno\.exit\(/g),
    null,
    "a refusal between esbuild and writeBundleInputs leaves an unvalidated " +
      "dist/app.js the next build calls fresh — use refuseBundle()",
  );
});
