// A field report from t2v (a Deno/Electron app: two prompt stages, an embedded
// inference engine, ~250 tests) after a full UI redesign. Rated the state and
// testing model 7/10 and took a point off for "reactivity rules that are not
// written down" and "a test-surface resolver that answers a different question
// than the one it appears to".
//
// Each block below is one of its findings, pinned. Two of the seven turned out
// to be misdiagnoses of a real trap sitting next to them — those are pinned as
// what actually happens, so the next reader does not re-derive it.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { cell } from "../mod.ts";
import { _resetForwardedHandles } from "../src/air/ui-surface.ts";
import { computed, signal } from "../src/state/signal.ts";
import { testCell } from "../src/testing/cell-test.ts";
import { testUI } from "../src/testing/ui-test.ts";

// ── #6 "One signal read API" ────────────────────────────────────────
//
//   "signal(0) gives .value to read, .set() to write and .peek() to read
//    untracked — but no .get(). I wrote now.get(), got a type error, tried
//    now(), got another, and landed on now.value by reading another
//    component's source."

Deno.test("signal: .get() is the tracked read, mirroring .set()", () => {
  const n = signal(1);
  assertEquals(n.get(), 1);
  n.set(5);
  assertEquals(n.get(), 5);
  assertEquals(n.get(), n.value);
  // …and it TRACKS (that is what separates it from peek): a computed built on
  // .get() must recompute when the source moves.
  const double = computed(() => n.get() * 2);
  assertEquals(double.get(), 10);
  n.set(7);
  assertEquals(double.get(), 14);
  assertEquals(double.value, 14);
});

Deno.test("signal: .get() re-renders a component exactly as .value does", async () => {
  const zoomG = signal(1);
  function App() {
    return (
      <div>
        <span t="z">{String(zoomG.get())}</span>
        <button t="up" onClick={() => zoomG.set(zoomG.get() + 1)}>+</button>
      </div>
    );
  }
  await using ui = await testUI(App);
  assertEquals(ui.z.text, "1");
  await ui.up.click();
  assertEquals(ui.z.text, "2");
});

// ── #2 "Cells leak state between tests" ─────────────────────────────
//
//   "testCell/testUI share the module-level cell, so a test that sets
//    orientation: landscape changes the meaning of a later test that assumed
//    the default. It shows up as an order-dependent failure that passes under
//    --filter, which is the worst way to find it."
//
// CELL state was already hermetic — the harness resets it per test. The half
// that was NOT is the state that lives beside a cell: a module-level
// `signal()`, which from a test is indistinguishable from a cell and which
// nothing restored. These two pairs must therefore BOTH pass in file order and
// under --filter, which is the whole point.

const shot = cell("t2v-shot", {
  state: { orientation: "portrait" },
  methods: {
    setOrientation(s: { orientation: string }, o: string) {
      s.orientation = o;
    },
  },
});
// Module-level UI state — the shape every real app has beside its cells.
const zoom = signal(1);
const panel = signal({ open: false, tab: "prompt" });

testCell(shot, "A: leaves the cell dirty", async (t) => {
  await t.send.setOrientation("landscape");
  t.expect.state((s) => s.orientation === "landscape");
});

testCell(shot, "B: still starts from the declared initial", (t) => {
  t.expect.state((s) => s.orientation === "portrait");
});

function ZoomApp() {
  return (
    <div>
      <span t="zoom">{String(zoom.value)}</span>
      <span t="tab">{panel.value.tab}</span>
      <span t="ori">{shot.orientation}</span>
      <button t="bump" onClick={() => zoom.set(zoom.value + 1)}>+</button>
      <button t="tabB" onClick={() => panel.set({ open: true, tab: "video" })}>
        tab
      </button>
      <button t="land" onClick={() => shot.setOrientation("landscape")}>
        o
      </button>
    </div>
  );
}

testUI(ZoomApp, "A: leaves module signals AND the cell dirty", async (ui) => {
  await ui.bump.click();
  await ui.tabB.click();
  await ui.land.click();
  assertEquals(ui.zoom.text, "2");
  assertEquals(ui.tab.text, "video");
  assertEquals(ui.ori.text, "landscape");
});

testUI(ZoomApp, "B: every kind of state starts pristine", (ui) => {
  assertEquals(ui.zoom.text, "1", "module-level signal was restored");
  assertEquals(ui.tab.text, "prompt", "…including an object initial");
  assertEquals(ui.ori.text, "portrait", "cell state was restored");
});

// ── #3/#5 "present()/absent() answer a question you did not ask" ─────
//
//   <NegativePrompt t="image-negative" … />   // a switch, and the field only when on
//   ui.absent("image-negative")               // false — the SWITCH is showing
//
// The report blamed substring matching ("toggle-image-negative contains
// image-negative"). It is not that — every name match in the surface is `===`.
// It is that `t` on a COMPONENT is a component handle (a rename-proof alias),
// so a component that also forwards `t` down to an element makes one string
// name two different things.

const neg = cell("t2v-neg", {
  state: { on: false },
  methods: {
    toggle(s: { on: boolean }) {
      s.on = !s.on;
    },
  },
});

function NegativePrompt({ t }: { t: string }) {
  return (
    <div>
      <button t={`toggle-${t}`} onClick={() => neg.toggle()}>switch</button>
      {neg.on ? <input t={t} value="" /> : null}
    </div>
  );
}

function NegApp() {
  return <NegativePrompt t="image-negative" />;
}

testUI(
  NegApp,
  "present/absent: kind pins WHICH thing is being asked about",
  async (ui) => {
    // The reporter's exact assertion, now answerable: the FIELD is not in the DOM.
    assert(ui.absent("image-negative", "element"), "the field is not rendered");
    assertEquals(ui.present("image-negative", "element"), false);
    // …and the component genuinely is showing something (the switch), which is
    // what the bare form answers. Asking for it on purpose is unambiguous.
    assert(ui.present("image-negative", "component"), "the switch is showing");

    // Turn the field on: now an element of that name IS live, and it wins over
    // the component for the bare question.
    await ui["toggle-image-negative"].click();
    await ui.settle();
    assert(
      ui.present("image-negative", "element"),
      "the field is rendered now",
    );
    assert(ui.present("image-negative"), "an element on screen wins");
  },
);

// The ambiguity is not an app-authoring mistake to scold about: aio's OWN kit
// forwards `t` to the element it renders (`<Button t="Home">`,
// `<Input t="who">`), so every app built on `aio/ui` has names that address a
// component and an element at once. Answering must therefore be deterministic
// (element first, frame-local — never "what a previous render happened to
// show"), and the ONE frame where the two answers differ is explained rather
// than returned bare. Explained precisely: a component handle that names
// nothing else must stay silent, or the warning is noise and gets ignored.
async function warningsWhile(fn: () => Promise<void> | void): Promise<string> {
  const orig = console.warn;
  const out: string[] = [];
  console.warn = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return out.join("\n");
}

Deno.test("the ambiguous frame is explained — and only that frame", async () => {
  _resetForwardedHandles();

  // A pure component handle (nothing else is called "Advice"): unambiguous.
  function AdviceBody() {
    return <div>stranded placement</div>;
  }
  function AdviceApp() {
    return <AdviceBody t="Advice" />;
  }
  const quiet = await warningsWhile(async () => {
    await using ui = await testUI(AdviceApp);
    assert(ui.present("Advice"), "the component is showing");
  });
  assertEquals(quiet, "", `a plain component handle must be silent: ${quiet}`);

  // Now the forwarding shape. With the field ON, the element answers and there
  // is nothing to explain.
  const onFrame = await warningsWhile(async () => {
    await using ui = await testUI(NegApp);
    await ui["toggle-image-negative"].click();
    await ui.settle();
    assert(ui.present("image-negative"), "the element is on screen");
  });
  assertEquals(onFrame, "", `the unambiguous frame must be silent: ${onFrame}`);

  // Field OFF: the component still shows the switch, so the bare question
  // answers "true" about a component while the element is gone. That is the
  // frame that misleads, and the only one that speaks.
  const offFrame = await warningsWhile(async () => {
    await using ui = await testUI(NegApp);
    assert(ui.present("image-negative"), "…as a component");
    assert(
      ui.present("image-negative"),
      "repeat: explained once, not per call",
    );
  });
  assertStringIncludes(offFrame, "image-negative");
  assertStringIncludes(offFrame, 'ui.absent("image-negative", "element")');
  assertEquals(
    offFrame.split("[aio:testUI]").length - 1,
    1,
    `once per mount, not per call: ${offFrame}`,
  );

  // …and asking on purpose is silent, either way.
  const pinned = await warningsWhile(async () => {
    await using ui = await testUI(NegApp);
    assert(ui.absent("image-negative", "element"));
    assert(ui.present("image-negative", "component"));
  });
  assertEquals(pinned, "", `an explicit kind must be silent: ${pinned}`);
});

testUI(NegApp, "names match exactly — never by substring", (ui) => {
  // `toggle-image-negative` CONTAINS `image-negative`; asking for the element
  // must not find the switch.
  assertEquals(ui.present("image-negative", "element"), false);
  assert(ui.present("toggle-image-negative", "element"), "the switch, exactly");
  assert(ui.absent("mage-negativ", "element"), "a substring addresses nothing");
});

// ── #4 "Remounting a subtree mid-test breaks handle resolution" ──────
//
//   "ui['x'] throws element "App/AdvancedView/VideoStage/…:x" is not on the
//    current surface — while ui.html() contains that very element and
//    ui.present('x') returns true. settle() does not help. Three of the
//    framework's own APIs disagreed about whether the element existed."
//
// The name is the address; the path was only ever a tie-breaker between
// same-named siblings. A handle taken before a remount now survives it.

const stage = cell("t2v-stage", {
  state: { stage: "a" },
  methods: {
    go(s: { stage: string }, v: string) {
      s.stage = v;
    },
  },
});

function StageA() {
  return <input t="prompt" value="" />;
}
function StageB() {
  return (
    <div>
      <span>video</span>
      <input t="prompt" value="" />
    </div>
  );
}
function StageApp() {
  return (
    <div>
      <button t="toB" onClick={() => stage.go("b")}>b</button>
      {stage.stage === "a" ? <StageA /> : <StageB />}
    </div>
  );
}

testUI(
  StageApp,
  "a handle taken before a remount still resolves after it",
  async (ui) => {
    const prompt = ui.prompt; // resolved at App/StageA:prompt
    await ui.toB.click(); // …which no longer exists: it is App/StageB:prompt now
    await ui.settle();
    assert(ui.present("prompt", "element"), "present() says it is there…");
    await prompt.setValue("a cat"); // …and so does the handle, not a stale path
    assertEquals(ui.prompt.value, "a cat");
  },
);

// ── #5 "Exact-match handles, with ambiguity as an error" ────────────
//
//   "Exact match with an explicit startsWith option would be safer; at minimum
//    the ambiguity should be an error, not a silent first-match."
//
// Matching was already exact (pinned above). The "silent first-match" half was
// probed by MAKING it an error — and the kit's reachability fuzzer refused the
// change: same-named siblings are POSITIONAL by design (bare name = the first,
// `Name2` = the second — which is why the ordinal is 2-based, and what every
// miss listing teaches: "Button ×2 — use Button2 for the 2nd"). Erroring there
// made elements reachable only through an ordinal the author has no reason to
// know. Reverted; the contract is pinned here instead.
//
// One real gap survived the probe: "the first" had no explicit spelling, so a
// reader could not tell a deliberate first from an unconsidered one. `Name1`
// now says it.

const rows = cell("t2v-rows", {
  state: { items: ["a", "b", "c"], gone: [] as string[] },
  methods: {
    remove(s: { items: string[]; gone: string[] }, id: string) {
      s.items = s.items.filter((i) => i !== id);
      s.gone = [...s.gone, id];
    },
  },
});

function TodoRow({ id }: { id: string }) {
  return (
    <div>
      <span>{id}</span>
      <button t="del" onClick={() => rows.remove(id)}>x</button>
    </div>
  );
}
function RowsApp() {
  return <div>{rows.items.map((id) => <TodoRow id={id} key={id} />)}</div>;
}

testUI(
  RowsApp,
  "same-named siblings are positional, and 'first' is sayable",
  (ui) => {
    // The documented contract: bare name = the first, ordinals from 2 up.
    assertEquals(ui.TodoRow.text, "ax");
    assertEquals(ui.TodoRow2.text, "bx");
    assertEquals(ui.TodoRow3.text, "cx");
    // `Name1` says "the first" explicitly — the same instance as the bare name,
    // so a reader can tell a deliberate first from an unconsidered one, and a
    // loop over instances can use ONE spelling (`Name${n}`) for every n.
    assertEquals(ui.TodoRow1.text, "ax");
    // A key is the stable address when order can change.
    assertEquals(ui.find("TodoRow", "b").text, "bx");
    // A miss lists the scope's children annotated with their count and the
    // ordinal escape hatch — the listing that teaches the convention, so
    // nobody has to find it in the docs first.
    const err = assertThrows(() => ui.RowsApp.nope.value) as Error;
    assertStringIncludes(err.message, "TodoRow ×3");
    assertStringIncludes(err.message, "TodoRow2");
  },
);

testUI(
  RowsApp,
  "…and the addressed instance is the one that acts",
  async (ui) => {
    await ui.TodoRow2.del.click();
    await ui.expectCell(
      rows,
      (r: { gone: string[] }) => r.gone.join() === "b",
      "row 2 was removed — not whichever came first",
    );
  },
);

// ── #7 "Error output is unreadable at scale" ────────────────────────
//
//   "A missing handle dumps every registered handle in the app — ~50 entries on
//    one line, several hundred characters each. Truncate to the nearest
//    matches and put the count behind a flag."

function BigApp() {
  return (
    <div>
      {Array.from(
        { length: 40 },
        (_, i) => <button t={`control-${i}`} key={i}>{i}</button>,
      )}
      <button t="orientation-picker">o</button>
    </div>
  );
}

testUI(
  BigApp,
  "a missing handle lists the closest names, not all of them",
  (ui) => {
    // A property read resolves eagerly (a queued action would fail at the next
    // drain point instead) — either way it is the same listing.
    const err = assertThrows(() =>
      ui.BigApp["orientation-pickr"].value
    ) as Error;
    const listed = /available: (.*)/.exec(err.message)?.[1] ?? "";
    const names = listed.split(", ");
    assert(names.length <= 8, `capped, got ${names.length}: ${listed}`);
    assertEquals(names[0], "orientation-picker", "the one they meant is first");
    assert(
      /closest \d+ of \d+ shown/.test(err.message),
      `says what was withheld: ${err.message}`,
    );
    assert(
      /AIO_TEST_NAMES=all/.test(err.message),
      "and how to see everything",
    );
  },
);

// ── #1 "Reactivity tracking has unwritten rules" ────────────────────
//
//   "This did not re-render when `card` changed" — an outer view ternary whose
//   else-branch is a fragment of two inner ternaries.
//
// Probed as reported: it re-renders. Reads of one cell share one signal, and
// dependencies are re-collected on every render, so a branch entered LATER
// still subscribes. Pinned in both orders (entering the branch on the first
// render, and only on a later one) because the mechanism the report guessed at
// — "the inner branch was evaluated once when the outer condition flipped" —
// is precisely what would break it. The rule itself is now written down:
// docs/ui/reactivity-tracking.md.

const studio = cell("t2v-studio", {
  state: { view: "simple", card: "image" },
  methods: {
    setView(s: { view: string }, v: string) {
      s.view = v;
    },
    setCard(s: { card: string }, c: string) {
      s.card = c;
    },
  },
});

function SimpleView() {
  return <div>SIMPLE</div>;
}
function ImageStage() {
  return <div>IMAGE-STAGE</div>;
}
function VideoStage() {
  return <div>VIDEO-STAGE</div>;
}

function StudioApp() {
  return (
    <div>
      <button t="adv" onClick={() => studio.setView("advanced")}>a</button>
      <button t="vid" onClick={() => studio.setCard("video")}>v</button>
      {studio.view === "simple" ? <SimpleView /> : (
        <>
          {studio.card === "image" ? <ImageStage /> : null}
          {studio.card === "video" ? <VideoStage /> : null}
        </>
      )}
    </div>
  );
}

testUI(
  StudioApp,
  "a nested ternary inside a fragment tracks its cell read",
  async (ui) => {
    // The read of `card` happens for the first time only on the SECOND render —
    // the one after the outer condition flipped. It still subscribes.
    await ui.adv.click();
    await ui.settle();
    assert(ui.html().includes("IMAGE-STAGE"), ui.html());
    await ui.vid.click();
    await ui.settle();
    assert(ui.html().includes("VIDEO-STAGE"), `stale DOM: ${ui.html()}`);
  },
);

testUI(
  StudioApp,
  "…and in the other order: the branch is live from the first render",
  { seed: { "t2v-studio": { view: "advanced" } } },
  async (ui) => {
    assert(ui.html().includes("IMAGE-STAGE"), ui.html());
    await ui.vid.click();
    await ui.settle();
    assert(ui.html().includes("VIDEO-STAGE"), `stale DOM: ${ui.html()}`);
  },
);
