// `import { Button } from "aio/ui"` has to WORK in a browser page.
//
// A field report (got, alpha56) hit this: the documented component kit
// (`docs/ui/kit.md` — "import { UiStyles, Button, Field, Input, Table } from
// 'aio/ui'") was missing from the browser import map, so the page died on an
// unmapped bare specifier and showed a blank screen — while `deno fmt`,
// `check`, `lint`, `aiol`, `doctor` and the app's own 65 tests were all green.
// Every gate agreed the app was fine; the app did not render.
//
// The class: anything the docs tell an app to import FROM A PAGE must resolve
// in the browser. So this test does not assert the map's contents — it asserts
// the property, by walking every `aio/*` specifier the docs advertise and
// requiring the dev server to serve real JS for each.
import { assert, assertStringIncludes } from "@std/assert";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { buildBrowserImportMap } from "../src/server/server-html-importmap.ts";

/** Bare `aio/*` specifiers a component (page-side) is documented to import. */
const PAGE_SPECIFIERS = [
  "aio", // cells, the app surface
  "aio/air", // signals + JSX runtime pieces
  "aio/ui", // the component kit — docs/ui/kit.md
  "aio/jsx-runtime",
  "aio/updates", // opt-in built-in cells
  "aio/feedback",
];

Deno.test("every documented page-side aio/* specifier is in the browser import map", () => {
  const map = buildBrowserImportMap({});
  for (const spec of PAGE_SPECIFIERS) {
    assert(
      typeof map[spec] === "string" && map[spec].length > 0,
      `"${spec}" is documented as a page import but resolves nowhere in the ` +
        `browser — an app that imports it gets a blank screen with every gate ` +
        `green. Add it to buildBrowserImportMap.`,
    );
  }
});

Deno.test("the dev server serves each mapped aio/* specifier as real JS", async () => {
  const map = buildBrowserImportMap({});
  const PORT = freePort();
  const dir = await Deno.makeTempDir({ prefix: "aio-ui-import-" });
  const server = createServer(
    {
      port: PORT,
      title: "kit",
      getUIState: () => ({ ok: true }),
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      prod: false, // dev/transpile mode — the path a page actually uses
    } as unknown as Parameters<typeof createServer>[0],
  );
  await new Promise((r) => setTimeout(r, 60));
  try {
    for (const spec of PAGE_SPECIFIERS) {
      const url = map[spec]!;
      const resp = await fetch(`http://127.0.0.1:${PORT}${url}`);
      const body = await resp.text();
      assert(resp.status === 200, `${spec} → ${url} → ${resp.status}`);
      // A resolution/transpile failure answers 200 with a throw-stub body, so
      // status alone proves nothing.
      assert(
        !body.includes("transpile failed"),
        `${spec} → ${url} served a transpile-failure stub:\n${
          body.slice(0, 200)
        }`,
      );
      assert(body.length > 50, `${spec} → ${url} short (${body.length}b)`);
    }
    // And the kit really is the kit: the names docs/ui/kit.md tells apps to
    // import must be in what the browser receives.
    const kit = await (await fetch(`http://127.0.0.1:${PORT}${map["aio/ui"]}`))
      .text();
    for (const name of ["Button", "Input", "Field", "Table", "UiStyles"]) {
      assertStringIncludes(kit, name);
    }
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
