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
