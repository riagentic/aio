// Which shape did `getHealth` return? Decided on the VALUES, never on a name.
//
// `ServerConfig.getHealth` is typed `() => unknown` and two shapes are
// accepted: the full health document (`{ status, version, pid, cells, … }`)
// and a bare cells map (a host supplying its own). Telling them apart was a
// guess on a key NAME, and both spellings of that guess have been wrong:
//
//   • keyed on `cells` — a health document for an app with NO composed cells
//     has no `cells` key, so the document was read as the map and
//     `status`/`version`/`pid` became cell rows (fixed once, this way);
//   • keyed on `status` — a bare cells map for an app with a cell NAMED
//     `status` is read as a document, `doc.cells` is undefined, and EVERY cell
//     row vanishes from the scrape. Silently: a Prometheus target with no cell
//     series is indistinguishable from an app that has no cells.
//
// A cell called `status` is an ordinary name, so the second one is not exotic.
// Values decide it now: a cells map's values are all rows (`{enabled,errors}`),
// a document's top-level values never are.
import { assertEquals } from "@std/assert";
import { healthCells } from "../src/server/server-metrics.ts";

Deno.test("health shape: a document hands back its cells", () => {
  assertEquals(
    healthCells({
      status: "healthy",
      version: "1.0.0",
      pid: 1,
      cells: {
        todo: { enabled: true, errors: 0 },
        user: { enabled: false, errors: 2 },
      },
    }),
    // Literals on the expected side, deliberately: a helper on BOTH sides is
    // an assertion that holds for any implementation returning its input.
    { todo: { enabled: true, errors: 0 }, user: { enabled: false, errors: 2 } },
  );
});

Deno.test("health shape: a document with NO cells yields none", () => {
  // The first wrong guess: this must not read as a cells map, or `status`,
  // `version` and `pid` become cell rows.
  assertEquals(
    healthCells({ status: "healthy", version: "1.0.0", pid: 1 }),
    undefined,
  );
});

Deno.test("health shape: a bare cells map is recognised", () => {
  assertEquals(
    healthCells({
      todo: { enabled: true, errors: 0 },
      user: { enabled: true, errors: 1 },
    }),
    { todo: { enabled: true, errors: 0 }, user: { enabled: true, errors: 1 } },
  );
});

Deno.test("health shape: a cell NAMED status keeps every row", () => {
  // The second wrong guess: keyed on `status`, this whole map was read as a
  // document and every row disappeared from the scrape without a word.
  assertEquals(
    healthCells({
      status: { enabled: true, errors: 0 },
      todo: { enabled: true, errors: 3 },
    }),
    // NOT compared against the input object: `healthCells` returns its
    // argument for a map, so `assertEquals(f(map), map)` would hold for a
    // function that does nothing at all.
    {
      status: { enabled: true, errors: 0 },
      todo: { enabled: true, errors: 3 },
    },
  );
});

Deno.test("health shape: nothing, and nonsense, yield no rows", () => {
  for (const v of [undefined, null, 42, "x", [], {}]) {
    assertEquals(
      healthCells(v),
      undefined,
      `${JSON.stringify(v) ?? "undefined"}`,
    );
  }
  // A half-shaped value is not a cells map either — a row needs both keys.
  assertEquals(healthCells({ todo: { enabled: true } }), undefined);
  assertEquals(healthCells({ todo: { errors: 0 } }), undefined);
});
