// Every `aio/*` entry this framework publishes is on exactly one side of a
// line: the browser can resolve it, or it cannot run there at all.
//
// Nothing checked that, and the middle is where the bugs live. Twice now:
//   `aio/ui` — docs told every app to `import { Button } from "aio/ui"`, the
//   symbol existed, the specifier resolved nowhere in the browser, and the
//   page died on an unmapped bare import. fmt, check, lint, aiol, doctor and
//   the whole suite stayed green while a field report hit a blank screen.
//   `aio/db` — the entry the docs name for SQLite, absent from the browser
//   map ON PURPOSE, and absent from all three copies of the server-only list,
//   so a component importing it was told to add a package that does not exist.
//
// The existing doc-imports gate cannot catch either: it asks whether a symbol
// EXISTS in the entry, which was true in both cases. This asks the other
// question. Adding an entry to deno.json now forces a decision here.
import { assertEquals } from "@std/assert";
import { parse } from "@std/jsonc";
import { buildBrowserImportMap } from "../src/server/server-html-importmap.ts";
import { SERVER_ONLY_SPECS } from "../src/server/server-only-specs.ts";
import { aioModuleUrl } from "../src/server/server-static.ts";

/** Entries that are neither browser-resolvable nor refused, each with the
 *  reason it sits in the middle. A name here is a decision someone made, not
 *  a gap nobody noticed — which is the whole difference. */
const ACKNOWLEDGED: Record<string, string> = {
  "aio/extras":
    "pulls parseCli/instances (server), but a bundler can tree-shake an app " +
    "down to the part that works — refusing it would break working builds",
  "aio/sync":
    "the ENTRY pulls server-handler.ts; the browser reaches the sync engine " +
    "through browser-sync.ts instead, never through this specifier",
};

Deno.test("every published aio entry is browser-mapped, server-only, or named", () => {
  const deno = parse(Deno.readTextFileSync("deno.json")) as {
    exports?: Record<string, string>;
  };
  const browser = buildBrowserImportMap({});
  const unclassified: string[] = [];
  for (const key of Object.keys(deno.exports ?? {})) {
    // "." → "aio", "./air" → "aio/air"
    const spec = key === "." ? "aio" : "aio/" + key.slice(2);
    if (browser[spec]) continue;
    if (SERVER_ONLY_SPECS.has(spec)) continue;
    if (spec in ACKNOWLEDGED) continue;
    unclassified.push(spec);
  }
  assertEquals(
    unclassified,
    [],
    `unclassified entry — a page importing it dies on an unmapped specifier, ` +
      `and the framework has no category error to explain why. Add it to the ` +
      `browser import map, to SERVER_ONLY_SPECS, or to ACKNOWLEDGED with the ` +
      `reason: ${unclassified.join(", ")}`,
  );
});

Deno.test("no acknowledged gap has quietly been fixed", () => {
  // A reason that has stopped being true is worse than no reason: it reads as
  // a considered decision while describing a world that no longer exists.
  // `aio/air/compat` sat here saying it could not be served without a second
  // copy of AIR — which turned out to be false, because these routes transpile
  // rather than bundle. It is mapped now; the note had to go with it.
  const browser = buildBrowserImportMap({});
  const stale = Object.keys(ACKNOWLEDGED).filter((s) =>
    browser[s] || SERVER_ONLY_SPECS.has(s)
  );
  assertEquals(stale, [], "acknowledged as a gap, but no longer a gap");
});

Deno.test("every framework module the map points at actually resolves", () => {
  // A typo in the map is a blank page with a 404 behind it, which looks
  // exactly like the unmapped case it was added to fix.
  const browser = buildBrowserImportMap({});
  const broken = Object.entries(browser)
    .filter(([, url]) => url.startsWith("/__aio/") && url.endsWith(".ts"))
    .filter(([, url]) => !aioModuleUrl(url.slice("/__aio/".length)))
    .map(([spec, url]) => `${spec} -> ${url}`);
  assertEquals(broken, [], "mapped to a path the server will 404");
});

Deno.test("an entry is never on both sides of the line", () => {
  const browser = buildBrowserImportMap({});
  const both = [...SERVER_ONLY_SPECS].filter((s) => browser[s]);
  assertEquals(both, [], "server-only, yet served to the browser");
});

Deno.test("the server-only list has ONE spelling", () => {
  // graph-validator.ts, lint.ts and server-html-classify.ts each declared
  // their own copy, each with a comment naming the other two.
  for (
    const f of ["graph-validator.ts", "lint.ts", "server-html-classify.ts"]
  ) {
    const src = Deno.readTextFileSync(`src/server/${f}`);
    assertEquals(
      /(SERVER_ONLY_SPECS|AIO_SERVER_SPECS)\s*(:[^=]+)?=\s*new Set/.test(src),
      false,
      `${f} declares its own server-only set again`,
    );
  }
});

Deno.test("the entries the docs name for SQLite and shipping are refused in a page", () => {
  // The concrete regression: these are what an app is told to import, and
  // each one dying in a browser is a category the framework must name.
  for (const spec of ["aio/db", "aio/build", "aio/ship", "aio/testing"]) {
    assertEquals(
      SERVER_ONLY_SPECS.has(spec),
      true,
      `${spec} fell off the list`,
    );
  }
});
