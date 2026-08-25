// In the test surface, an absent boolean must not be a callable.
//
// From a field report (a chat-app field report, #6): asserting that a checkbox
// starts unchecked —
//
//   assertEquals(page["one-lan-toggle"].checked, false);
//   // AssertionError: Actual: [Function: callable]  Expected: false
//
// `checked` was serialised onto the element info ONLY when true, and the
// handle's proxy turns an unknown property into a lazy callable (so un-awaited
// sequences can target UI a queued action will create). Both are reasonable
// alone; together the natural assertion for "off" was unwritable and the failure
// pointed at neither cause.
//
// Pinned here: the four state booleans (`checked`, `disabled`, `readonly`,
// `required`) are ALWAYS serialised — false included — for any element that has
// that state; the element handle always answers them with a real boolean; the
// SAME fields reach a live app through `am surface`; and the lazy callable that
// makes un-awaited action sequences work is untouched (it just stopped being
// anonymous).
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { getSerializedSurfaces } from "../src/air/ui-remote.ts";
import type { UIElementInfo, UISurfaceNode } from "../src/air/ui-surface.ts";

const form = cell("surface-bools", {
  state: { lan: false, sent: false, modal: false },
  methods: {
    setLan(s: { lan: boolean }, v: boolean) {
      s.lan = v;
    },
    openModal(s: { modal: boolean }) {
      s.modal = true;
    },
    send(s: { sent: boolean }) {
      s.sent = true;
    },
  },
});

function Modal() {
  return <button t="confirm" onClick={() => form.send()}>Confirm</button>;
}

function App() {
  return (
    <div>
      <input
        t="one-lan-toggle"
        type="checkbox"
        checked={form.lan}
        onChange={(e) =>
          form.setLan((e.target as unknown as { checked: boolean }).checked)}
      />
      <button t="go" onClick={() => form.openModal()}>Go</button>
      <button t="locked" disabled onClick={() => {}}>Locked</button>
      <input t="name" placeholder="Name" onInput={() => {}} />
      <input t="pinned" readOnly required value="x" onInput={() => {}} />
      {form.modal ? <Modal /> : null}
    </div>
  );
}

/** Find an element on a serialized surface tree by its `t` handle. */
function findEl(node: UISurfaceNode, name: string): UIElementInfo | undefined {
  const hit = node.elements.find((e) => e.name === name);
  if (hit) return hit;
  for (const c of node.children) {
    const deep = findEl(c, name);
    if (deep) return deep;
  }
  return undefined;
}

Deno.test("an unchecked box asserts as checked === false (not a callable)", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  // The field report's assertion, verbatim.
  assertEquals(ui["one-lan-toggle"].checked, false);
  assertEquals(ui.App["one-lan-toggle"].checked, false);
  // …and it tracks the real state.
  await ui["one-lan-toggle"].check();
  assertEquals(ui["one-lan-toggle"].checked, true);
  assertEquals(form.lan, true);
  await ui["one-lan-toggle"].uncheck();
  assertEquals(ui["one-lan-toggle"].checked, false);
});

Deno.test("disabled / readonly / required always answer with a boolean", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  assertEquals(ui.go.disabled, false);
  assertEquals(ui.locked.disabled, true);
  assertEquals(ui.name.readonly, false);
  assertEquals(ui.name.required, false);
  assertEquals(ui.pinned.readonly, true);
  assertEquals(ui.pinned.required, true);
  // A control with no checked state answers false, never a callable.
  assertEquals(ui.go.checked, false);
});

Deno.test("the four booleans are serialised (false included) for tests and for am surface", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  for (
    const surface of [
      ui.surface() as UISurfaceNode, // what a test reads
      getSerializedSurfaces()[0]!, // what `am surface` sends a live client
    ]
  ) {
    const box = findEl(surface, "one-lan-toggle")!;
    assert(box, "the checkbox is on the surface");
    assertEquals(box.checked, false, "checked is present and false");
    assertEquals(box.disabled, false);
    assertEquals(box.readonly, false);
    assertEquals(box.required, false);

    const locked = findEl(surface, "locked")!;
    assertEquals(locked.disabled, true);

    const pinned = findEl(surface, "pinned")!;
    assertEquals(pinned.readonly, true);
    assertEquals(pinned.required, true);

    // A plain <button> has no checked/readonly/required state — those stay
    // absent rather than lying with a false.
    const go = findEl(surface, "go")!;
    assertEquals(go.checked, undefined);
    assertEquals(go.readonly, undefined);
    assertEquals(go.required, undefined);
  }
});

Deno.test("a not-yet-rendered element still resolves at use time (queued actions unregressed)", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  assert(ui.absent("Modal"), "the modal is not rendered yet");
  // No awaits: the second action targets UI the first one will create. This is
  // exactly what the lazy callable exists for.
  ui.go.click();
  ui.Modal.confirm.click();
  await ui.expectCell(form, (f: { sent: boolean }) => f.sent === true);
  assert(ui.present("Modal"));
});

Deno.test("a missing property on a missing element fails loud, and an unresolved handle names itself", async () => {
  await using ui = await testUI(App as never);
  await ui.settle();

  // The reporter's real situation — asking a name that is not there. It must
  // throw the aio listing, never hand back a callable that reads as a value.
  const err = assertThrows(() => ui.App["no-such-toggle"].checked) as Error;
  assert(
    /no element or component named "no-such-toggle" under App/.test(
      err.message,
    ),
    `names the miss: ${err.message}`,
  );
  assert(/available:/.test(err.message), "lists what IS there");

  // An unresolved chain is still callable (queued-action ergonomics) — but it
  // now says what it is when it lands in an assertion diff, instead of the
  // anonymous `[Function: callable]` that pointed at neither cause.
  const pending = ui.App["no-such-toggle"].frobnicate;
  assertEquals(typeof pending, "function");
  const shown = Deno.inspect(pending);
  assert(shown.includes("frobnicate"), `self-describing: ${shown}`);
  assert(shown.includes("aio testUI"), `self-describing: ${shown}`);
  // …and invoking it still fails with the aio message, not a bare TypeError.
  assertThrows(() => (pending as () => void)());
});
