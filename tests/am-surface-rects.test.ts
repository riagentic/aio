// `am surface --rects` — geometry, and the refusal to fake it.
//
// From a field report (report 6 §10.2): `am surface` said what was on screen
// and never how big it was, so "the app looks fine" could not be turned into
// "the Stage is 6886 px tall". A rect per element closes that.
//
// THE HARD PART IS NOT THE MEASUREMENT. `getBoundingClientRect()` answers
// everywhere — happy-dom has it, every SSR shim has it — and with no layout
// engine behind it, it answers `0,0 0x0` for every element. A grid of zeroes
// is a plausible-looking wrong answer that reads as a real measurement of a
// collapsed UI, which is precisely the bug someone reaching for `--rects` is
// hunting. So the counts travel with the rects, the CLI exits 1 rather than
// let them read as data, and the server-side render refuses outright.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";
import { measureSurface, type UISurfaceNode } from "../src/air/ui-surface.ts";
import { rectsVerdict } from "../src/am/am-cmd-inspect.ts";
import { getMeasuredSurfaces } from "../src/air/ui-remote.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";
import { VERB_FLAGS } from "../src/am/am-flags.ts";

/** A surface node holding elements with the DOM refs `measureSurface` reads. */
function nodeWith(
  boxes:
    ({ left: number; top: number; width: number; height: number } | null)[],
): UISurfaceNode {
  return {
    component: "App",
    path: "App",
    text: "",
    children: [],
    elements: boxes.map((b, i) => ({
      name: `E${i}`,
      tag: "div",
      events: ["click"],
      text: "",
      path: `App:E${i}`,
      _el: b === null ? undefined : ({
        getBoundingClientRect: () => b as unknown as DOMRect,
      } as unknown as Element),
    })),
  };
}

Deno.test("measureSurface: a real box becomes a rect, and is counted", () => {
  const n = nodeWith([{ left: 12.4, top: 7.6, width: 300.2, height: 6886 }]);
  const m = measureSurface(n);
  assertEquals(m, { measurable: 1, laidOut: 1 });
  // Rounded: a CLI column of 300.19999999999993 is unreadable, and sub-pixel
  // precision answers no question anyone asks of this command.
  assertEquals(n.elements[0]!.rect, { x: 12, y: 8, w: 300, h: 6886 });
});

Deno.test("measureSurface: an all-zero read is counted as NOT laid out", () => {
  // The headless shape. The rect is still attached — the caller may want to
  // see the zeroes — but `laidOut` is what says whether they mean anything.
  const n = nodeWith([
    { left: 0, top: 0, width: 0, height: 0 },
    { left: 0, top: 0, width: 0, height: 0 },
  ]);
  const m = measureSurface(n);
  assertEquals(m, { measurable: 2, laidOut: 0 });
  assertEquals(n.elements[0]!.rect, { x: 0, y: 0, w: 0, h: 0 });
});

Deno.test("measureSurface: an element with no DOM ref is not measurable", () => {
  const m = measureSurface(
    nodeWith([null, { left: 1, top: 2, width: 3, height: 4 }]),
  );
  assertEquals(m, { measurable: 1, laidOut: 1 });
});

Deno.test("measureSurface: it descends", () => {
  const root = nodeWith([{ left: 0, top: 0, width: 10, height: 10 }]);
  root.children = [nodeWith([{ left: 0, top: 0, width: 20, height: 20 }])];
  assertEquals(measureSurface(root), { measurable: 2, laidOut: 2 });
  assertEquals(root.children[0]!.elements[0]!.rect!.w, 20);
});

Deno.test("the verdict refuses to let a grid of zeroes read as a measurement", () => {
  // The whole point of the feature's honesty. `ok:false` is what makes the CLI
  // exit 1, so a script cannot mistake the zeroes for data.
  const bad = rectsVerdict({ measurable: 12, laidOut: 0 });
  assertEquals(bad.ok, false);
  assertStringIncludes(bad.note!, "12 elements measured 0x0");
  assert(
    bad.note!.includes("no layout") && bad.note!.includes("collapsed"),
    `it must name BOTH readings — the reader cannot act on one of them: ${bad.note}`,
  );

  // A real measurement is silent.
  assertEquals(rectsVerdict({ measurable: 12, laidOut: 3 }), { ok: true });

  // Nothing measurable is a note, not a failure: a server-only surface
  // genuinely has no elements, and exiting 1 there would be crying wolf.
  const none = rectsVerdict({ measurable: 0, laidOut: 0 });
  assertEquals(none.ok, true);
  assertStringIncludes(none.note!, "measured nothing");
  assertEquals(rectsVerdict(undefined).ok, true);
});

Deno.test("the trojan REFUSES --rects on a server-side render", async () => {
  const dir = await tempDir("rects-trojan-");
  const port = freePort();
  const c = cell("rectcell", { state: { n: 0 }, methods: {} } as never);
  const app = await aio.run({
    cells: [c],
    appId: `rects-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    const r = await fetch(
      `http://127.0.0.1:${port}/__aio/trojan/surface/server?rects=1`,
      { headers: { "x-aio": "1" } },
    );
    const body = await r.text();
    assert(
      r.status !== 200,
      `a server render answered --rects with a body — every rect in it is 0x0 ` +
        `and indistinguishable from a collapsed UI: ${body}`,
    );
    assertStringIncludes(body, "no layout");
    assertStringIncludes(
      body,
      "am open",
      "the refusal has to name the thing that CAN answer, or it is a dead end",
    );
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});

Deno.test("--rects is a declared flag of `surface`, and only of `surface`", () => {
  // The flag table is what rejects a typo with a suggestion instead of
  // silently ignoring it — a flag the parser does not know about is accepted
  // and dropped.
  assert(
    VERB_FLAGS.surface?.includes("--rects"),
    `surface does not declare --rects: ${VERB_FLAGS.surface?.join(" ")}`,
  );
  let others = 0;
  for (const [verb, flags] of Object.entries(VERB_FLAGS)) {
    if (verb === "surface") continue;
    assertEquals(
      (flags as readonly string[]).includes("--rects"),
      false,
      `${verb} must not claim --rects`,
    );
    others++;
  }
  // Otherwise an empty table passes this having checked nothing.
  assertEquals(
    others,
    Object.keys(VERB_FLAGS).length - 1,
    "the loop did not visit every other verb",
  );
  assert(others > 5, `only ${others} other verbs in the table`);
});

Deno.test("am help says what --rects is FOR, and what it needs", async () => {
  const help = await Deno.readTextFile(
    new URL("../src/am/am-help-text.ts", import.meta.url),
  );
  assertStringIncludes(help, "surface --rects");
  assert(
    /--rects[\s\S]{0,240}client/.test(help),
    "the help must say it needs a real client — that is the one thing that " +
      "turns a confusing all-zero answer into an understood one",
  );
});

Deno.test("the live-client path actually attaches rects to a mounted surface", async () => {
  // The unit tests above drive `measureSurface` directly. This one goes
  // through the function the BROWSER calls, on a real mount, because a
  // correctly-written measurer wired to nothing passes every test above.
  const App = () =>
    h(
      "div",
      { class: "root" },
      h("button", { type: "button" }, "Save"),
      h("input", { "aria-label": "Title" }),
    );
  await using ui = await testUI(App);
  await ui.settle();

  const { roots, measured } = getMeasuredSurfaces();
  assert(roots.length > 0, "nothing mounted");
  const rects: unknown[] = [];
  const walk = (n: { elements: { rect?: unknown }[]; children: unknown[] }) => {
    for (const e of n.elements) rects.push(e.rect);
    for (const c of n.children) walk(c as never);
  };
  for (const r of roots) walk(r as never);
  assert(
    rects.length >= 2,
    `expected the button and the input to be measured, got ${rects.length}`,
  );
  assertEquals(
    rects.filter((r) => r === undefined),
    [],
    "an element on the surface came back with no rect — the measurement did " +
      "not reach the serialized reply, which is the only place a caller sees it",
  );
  assertEquals(
    measured.measurable,
    rects.length,
    "the count and the attached rects disagree — two producers of one fact",
  );

  // happy-dom has no layout engine, so this is the honest-zero case, and it is
  // exactly what the verdict exists for.
  assertEquals(measured.laidOut, 0);
  assertEquals(rectsVerdict(measured).ok, false);

  // …and the plain path is unchanged: no rects unless asked.
  const { getSerializedSurfaces } = await import("../src/air/ui-remote.ts");
  const plain: unknown[] = [];
  for (const r of getSerializedSurfaces()) {
    const w = (n: { elements: { rect?: unknown }[]; children: unknown[] }) => {
      for (const e of n.elements) plain.push(e.rect);
      for (const c of n.children) w(c as never);
    };
    w(r as never);
  }
  assertEquals(
    plain.filter((x) => x !== undefined),
    [],
    "the default surface grew a rect field — --rects must cost nothing when " +
      "it is not asked for",
  );
});
