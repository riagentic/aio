// An effect must never be able to un-render the tree that scheduled it.
//
// From a field report (feedback/llama-master.md #5): a theme toggle wrote the
// chosen theme onto `document` from `afterRender`; under `testUI` there is no
// global `document`, the callback threw — and the reporter found THE BUTTON
// THAT TOGGLES THE THEME missing from the surface, two debug cycles away from
// the cause, because the symptom (an element that is not there) is nowhere near
// an effect that threw after that element was already rendered.
//
// Every user callback the render pipeline invokes is pinned here: afterRender,
// onMount, onCleanup, and — the one that really could abandon a commit —
// a callback `ref`, which runs INSIDE createDom/diff. Each must (a) keep the
// committed render and (b) report loudly, NAMING the component, since a
// contained failure nobody can locate is only half-contained.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { afterRender, onCleanup, onMount } from "../src/air/aio-renderer.ts";
import { Transition } from "../src/air/transition-component.ts";
import { testUI } from "../src/testing/ui-test.ts";

/** Collect console.error output for the duration of `fn`. */
async function captureErrors(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines.join("\n");
}

const boom = () => {
  // The field report's line, verbatim in spirit: no global document here.
  (document as unknown as {
    documentElement: { dataset: Record<string, string> };
  })
    .documentElement.dataset.theme = "dark";
};

const theme = cell("hook-containment-theme", {
  state: { mode: "dark" },
  methods: {
    toggle(s: { mode: string }) {
      s.mode = s.mode === "dark" ? "light" : "dark";
    },
  },
});

Deno.test("afterRender that throws keeps the committed render (and names the component)", async () => {
  function ThemeBar() {
    afterRender(boom);
    return (
      <div>
        <h1>Title</h1>
        <button t="theme" onClick={() => theme.toggle()}>{theme.mode}</button>
      </div>
    );
  }
  const App = () => (
    <div>
      <ThemeBar />
      <span>after</span>
    </div>
  );

  let logs = "";
  logs = await captureErrors(async () => {
    await using ui = await testUI(App as never);
    await ui.settle();
    // (a) the render survived the effect: the toggle EXISTS and works.
    assertEquals(ui.theme.text, "dark");
    await ui.theme.click();
    assertEquals(ui.theme.text, "light");
    assertStringIncludes(ui.html(), "after");
  });
  // (b) it was reported, named, and said the render was kept.
  assertStringIncludes(logs, "afterRender callback error");
  assertStringIncludes(logs, "<ThemeBar>");
  assertStringIncludes(logs, "KEPT");
});

Deno.test("callback ref that throws does not abandon the mount", async () => {
  function Panel() {
    return (
      <div>
        <button t="theme" ref={boom} onClick={() => theme.toggle()}>
          {theme.mode}
        </button>
        <span>sibling</span>
      </div>
    );
  }
  const App = () => (
    <div>
      <Panel />
      <button t="other" onClick={() => {}}>other</button>
    </div>
  );

  const logs = await captureErrors(async () => {
    // Pre-fix this threw out of mount() itself — testUI never returned.
    await using ui = await testUI(App as never);
    await ui.settle();
    assertStringIncludes(ui.html(), "sibling");
    assertEquals(ui.theme.text, "dark");
    assertEquals(ui.other.text, "other");
  });
  assertStringIncludes(logs, "ref callback error");
  assertStringIncludes(logs, "<button>");
});

Deno.test("callback ref that throws on re-render still commits the re-render", async () => {
  let armed = false;
  function Row() {
    return (
      <div>
        <button
          t="theme"
          ref={() => {
            if (armed) boom();
          }}
          onClick={() => theme.toggle()}
        >
          {theme.mode}
        </button>
      </div>
    );
  }
  const App = () => (
    <div>
      <Row />
      <span t="mirror">{theme.mode}</span>
    </div>
  );

  const logs = await captureErrors(async () => {
    await using ui = await testUI(App as never);
    await ui.settle();
    armed = true;
    await ui.theme.click();
    // Pre-fix the throw aborted the diff mid-commit: the DOM stayed frozen at
    // "dark" while the state said "light" — a half-applied render.
    assertEquals(theme.mode, "light");
    assertEquals(ui.mirror.text, "light");
    assertEquals(ui.theme.text, "light");
  });
  assertStringIncludes(logs, "ref callback error");
});

Deno.test("onMount / onCleanup that throw are contained and named", async () => {
  function Mounty() {
    onMount(boom);
    onCleanup(boom);
    return (
      <button t="mounty" onClick={() => theme.toggle()}>{theme.mode}</button>
    );
  }
  const App = () => (
    <div>
      <Mounty />
      <span t="mirror2">{theme.mode}</span>
    </div>
  );

  const logs = await captureErrors(async () => {
    await using ui = await testUI(App as never);
    await ui.settle();
    assert(ui.present("Mounty"), "the component still rendered");
    await ui.mounty.click(); // re-render → body-level onCleanup runs and throws
    assertEquals(ui.mirror2.text, theme.mode);
  });
  assertStringIncludes(logs, "onMount callback error");
  assertStringIncludes(logs, "<Mounty>");
  assertStringIncludes(logs, "onCleanup callback error");
});

Deno.test("exit transition that throws does not abort the removal diff", async () => {
  const list = cell("hook-containment-list", {
    state: { show: true },
    methods: {
      hide(s: { show: boolean }) {
        s.show = false;
      },
    },
  });
  const App = () => (
    <div>
      <Transition
        exit={() => {
          // A real exit fn reaches for layout — with no DOM it throws
          // SYNCHRONOUSLY, straight through onBeforeRemove into removeDom.
          boom();
          return { duration: 0 };
        }}
      >
        {list.show ? <span t="panel">panel</span> : null}
        {null}
      </Transition>
      <button t="hide" onClick={() => list.hide()}>hide</button>
    </div>
  );

  const logs = await captureErrors(async () => {
    await using ui = await testUI(App as never);
    await ui.settle();
    assert(ui.present("panel"));
    await ui.hide.click();
    // Pre-fix the throw escaped removeDom and aborted the diff that was
    // removing the node: the panel stayed on screen forever.
    await ui.waitFor(() => ui.absent("panel"), "the panel is removed anyway");
    assert(ui.present("hide"), "the rest of the tree is untouched");
  });
  assertStringIncludes(logs, "exit-transition callback error");
});
