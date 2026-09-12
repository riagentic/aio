// `uiRects` — geometry, keyed by the same names everything else uses.
//
// happy-dom measures everything 0×0. That hid two security-relevant defects in
// a wallet behind 1546 passing tests: a dApp origin running off the edge of the
// approval card, and that dialog opening scrolled past the origin (report 1
// §19.1/§22.2, report 6 §10.1). A harness that answers "0×0" to "where is
// this?" does not merely fail to help — it makes a layout assertion PASS.
//
// So the rule this pins is the one that makes geometry trustworthy: an
// UNMEASURED element is absent, never reported at the origin with no size. A
// missing key fails an assertion loudly; a plausible zero passes one.
import { assert, assertEquals } from "@std/assert";
import { uiRects } from "../src/cell-test.ts";

// deno-lint-ignore no-explicit-any
type D = any;

const surface = (elements: D[], children: D[] = []) => ({
  component: "App",
  path: "App",
  text: "",
  elements,
  children,
});

Deno.test("it keys rects by the path am trigger takes", () => {
  const roots = [surface([
    {
      name: "Card",
      tag: "div",
      events: [],
      text: "",
      path: "App:Card",
      rect: { x: 0, y: 0, w: 400, h: 200 },
    },
    {
      name: "Origin",
      tag: "span",
      events: [],
      text: "",
      path: "App:Origin",
      rect: { x: 8, y: 8, w: 520, h: 20 },
    },
  ])];
  const box = uiRects(roots);
  assertEquals(Object.keys(box).sort(), ["App:Card", "App:Origin"]);
  // The wallet's actual defect, as an assertion someone can write.
  assert(
    box["App:Origin"]!.w > box["App:Card"]!.w,
    "this fixture IS the overflow — the point is that it is now expressible",
  );
});

Deno.test("an UNMEASURED element is absent, never 0×0 at the origin", () => {
  // The whole reason this is worth having. Reporting an unmeasured element as
  // `{x:0,y:0,w:0,h:0}` makes `assert(box.X.w <= box.Y.w)` pass for two
  // elements nobody measured.
  const box = uiRects([surface([
    { name: "A", tag: "div", events: [], text: "", path: "App:A" },
    {
      name: "B",
      tag: "div",
      events: [],
      text: "",
      path: "App:B",
      rect: { x: 1, y: 2, w: 3, h: 4 },
    },
  ])]);
  assertEquals(Object.keys(box), ["App:B"]);
  assertEquals(box["App:A"], undefined);
});

Deno.test("it descends, and a surface with nothing measured is empty", () => {
  const roots = [surface([], [
    surface([{
      name: "X",
      tag: "div",
      events: [],
      text: "",
      path: "App/Row:X",
      rect: { x: 0, y: 0, w: 10, h: 10 },
    }]),
  ])];
  assertEquals(Object.keys(uiRects(roots)), ["App/Row:X"]);
  assertEquals(uiRects([surface([])]), {});
  // A single root, not an array, gives the SAME answer — the trojan returns
  // one shape and `am surface --json` another, and a helper that handled only
  // one of them would work in a test and not against a live app.
  assertEquals(Object.keys(uiRects(roots[0])), ["App/Row:X"]);
});

Deno.test("the harness's own DOM is NOT the source", async () => {
  // happy-dom answers every getBoundingClientRect with zeros, so a `ui.box()`
  // that read the harness's DOM would be a confident wrong answer. `uiRects`
  // reads a surface a REAL client measured — which is why it takes roots and
  // not a `ui`.
  const src = await Deno.readTextFile(
    new URL("../src/testing/ui-test.ts", import.meta.url),
  );
  const fn = src.slice(src.indexOf("export function uiRects"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assertEquals(
    /getBoundingClientRect|document|ownerDocument/.test(body),
    false,
    "uiRects must not measure anything itself — it reads what a real client " +
      "already measured",
  );
});
