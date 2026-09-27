// A click whose handler asks `confirm()` did nothing under testUI, silently.
//
// happy-dom has no dialogs, so a component's `confirm("Delete?")` reached
// Deno's own confirm(): with no terminal on stdin it answers false without a
// word (the click was a no-op and the test went on as if the button were
// broken), and ON a terminal it blocks the whole test on a y/N prompt. The
// same test hung at a desk and passed-by-doing-nothing in CI. A native dialog
// under testUI now throws, naming the dialog and how to answer it; a test that
// answers it (`globalThis.confirm = () => true`) gets its answer.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

const guarded = cell("native-dialog", {
  state: { removed: 0 },
  methods: {
    remove(s: { removed: number }) {
      s.removed++;
    },
  },
});

function App() {
  return (
    <button
      type="button"
      onClick={() => {
        if (confirm("Delete it?")) guarded.remove();
      }}
    >
      Delete
    </button>
  );
}

Deno.test("testUI: a confirm() in a click handler fails loud — never a silent no-op, never a terminal prompt", async () => {
  await using ui = await testUI(App);
  ui.DeleteButton.click();
  const e = await assertRejects(() => ui.settle());
  assertStringIncludes(String(e), "confirm");
  assertStringIncludes(String(e), "Delete it?");
  assertEquals(guarded.removed, 0);
});

Deno.test("testUI: a test that answers confirm() gets its answer", async () => {
  await using ui = await testUI(App);
  const before = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    ui.DeleteButton.click();
    await ui.settle();
    assertEquals(guarded.removed, 1);
  } finally {
    globalThis.confirm = before;
  }
});

Deno.test("testUI: a confirm() answered BEFORE testUI mounts keeps its answer", async () => {
  const before = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    await using ui = await testUI(App);
    const n = guarded.removed;
    ui.DeleteButton.click();
    await ui.settle();
    assertEquals(guarded.removed, n + 1);
  } finally {
    globalThis.confirm = before;
  }
});

function WindowApp() {
  return (
    <button
      type="button"
      onClick={() => {
        if (globalThis.window.confirm("Remove it?")) guarded.remove();
      }}
    >
      Remove
    </button>
  );
}

Deno.test("testUI: window.confirm() is the same dialog — refused by name, answered by the global stub", async () => {
  await using ui = await testUI(WindowApp);
  ui.RemoveButton.click();
  const e = await assertRejects(() => ui.settle());
  assertStringIncludes(String(e), 'confirm("Remove it?")');
  const before = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    const n = guarded.removed;
    ui.RemoveButton.click();
    await ui.settle();
    assertEquals(guarded.removed, n + 1);
  } finally {
    globalThis.confirm = before;
  }
});

Deno.test("testUI: overlapping mounts — disposing the first keeps the refusal for the second, the last hands Deno's back", async () => {
  const native = globalThis.confirm;
  const first = await testUI(App);
  const second = await testUI(WindowApp);
  await first[Symbol.asyncDispose]();
  second.RemoveButton.click();
  await assertRejects(() => second.settle());
  await second[Symbol.asyncDispose]();
  assertEquals(globalThis.confirm, native);
});
