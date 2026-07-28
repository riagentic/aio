// llama.md, second update — two small ergonomics that both remove a
// stringly-typed test:
//
//  #5 (wishlist) "I want 'this component is not rendered'. Today I write
//      assert(!ui.html().includes('placement-advice')), which is stringly-typed
//      and passes for the wrong reason if I rename a class."
//  #4 (friction) "find('Name') couples a test to a component NAME. Renaming
//      CtxPresets → CtxControls broke a test" — a refactor, not a behaviour
//      change. `t` is already how elements get a stable handle.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

const ui_ = cell("absent-ui", {
  state: { showAdvice: false },
  methods: {
    toggle(s: { showAdvice: boolean }) {
      s.showAdvice = !s.showAdvice;
    },
  },
});

// The component is addressed by `t`, so this rename-proof handle survives the
// function being called anything at all.
function PlacementAdviceV2() {
  return <div class="placement-advice">stranded CPU-only placement</div>;
}

function App() {
  return (
    <div>
      <button t="toggle" onClick={() => ui_.toggle()}>toggle</button>
      {ui_.showAdvice ? <PlacementAdviceV2 t="Advice" /> : null}
    </div>
  );
}

Deno.test("absent(): a component that isn't rendered, without string matching", async () => {
  await using ui = await testUI(App);
  assert(ui.absent("Advice"), "not rendered yet");
  assertEquals(ui.present("Advice"), false);

  await ui.toggle.click();
  await ui.settle();
  assert(ui.present("Advice"), "rendered after the toggle");
  assertEquals(ui.absent("Advice"), false);

  await ui.toggle.click();
  await ui.settle();
  assert(ui.absent("Advice"), "gone again");
});

Deno.test("absent(): composes with waitFor", async () => {
  await using ui = await testUI(App);
  await ui.toggle.click();
  await ui.waitFor(() => ui.present("Advice"), "advice appears");
  await ui.toggle.click();
  await ui.waitFor(() => ui.absent("Advice"), "advice disappears");
});

Deno.test("t handle: a component is addressable independently of its name", async () => {
  await using ui = await testUI(App);
  await ui.toggle.click();
  await ui.settle();
  // `t="Advice"` — NOT the function name `PlacementAdviceV2`. Renaming the
  // function must not break a test that addresses the component.
  // Addressable by the handle the author chose…
  assert(ui.find("Advice"), "found by its t handle");
  assert(ui.present("Advice"));
  // …and still by its function name. The handle is ADDITIVE on purpose: `t` is
  // also a legitimate data prop that components forward to inner elements (this
  // repo's own toolbar fixture does exactly that), so overriding the name would
  // break sibling de-duplication and ordinal access for everyone else.
  assert(ui.find("PlacementAdviceV2"), "the real name keeps working");
});

Deno.test("absent(): an unknown name is absent, not an error", async () => {
  await using ui = await testUI(App);
  assert(ui.absent("NoSuchThingAnywhere"));
});

// llama-master, re-probed unchanged a round later: a component that renders
// `null` still has a surface node — it ran, it just produced nothing — and
// `absent()` called that "present". The reporter's exact probe:
//
//   betterPlacement() → null        // nothing to advise
//   DOM contains "placement-advice" → false
//   absent("PlacementAdvice")  → false   ← wrong
//
// "Present" has to mean SHOWING, or the assertion answers a question nobody
// asked — and the docstring's own worked example was the failing case.
const advice = cell("absent-null", {
  state: { show: false },
  methods: {
    toggle(s: { show: boolean }) {
      s.show = !s.show;
    },
  },
});

function PlacementAdvice() {
  // Renders NOTHING when there is nothing to advise — the common shape.
  return advice.show
    ? <div class="placement-advice">stranded placement</div>
    : null;
}

function NullApp() {
  return (
    <div>
      <button t="advise" onClick={() => advice.toggle()}>advise</button>
      <PlacementAdvice />
    </div>
  );
}

Deno.test("absent(): a component that rendered null is ABSENT", async () => {
  await using ui = await testUI(NullApp);
  assert(
    ui.absent("PlacementAdvice"),
    "it rendered nothing, so nothing is on screen — regardless of the node " +
      "still being in the surface tree",
  );
  assertEquals(ui.present("PlacementAdvice"), false);

  await ui.advise.click();
  await ui.settle();
  assert(ui.present("PlacementAdvice"), "now it shows something");
  assertEquals(ui.absent("PlacementAdvice"), false);

  await ui.advise.click();
  await ui.settle();
  assert(ui.absent("PlacementAdvice"), "and it is absent again");
});

Deno.test("absent(): a component showing only TEXT counts as present", async () => {
  function Note() {
    return <span>saved</span>;
  }
  function App2() {
    return (
      <div>
        <Note />
      </div>
    );
  }
  await using ui = await testUI(App2);
  assert(
    ui.present("Note"),
    "text is on screen even with no interactive element",
  );
});
