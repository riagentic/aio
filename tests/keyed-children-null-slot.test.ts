// A `null` child is the ABSENCE of a sibling, not a sibling missing a key.
//
// This is the most ordinary conditional JSX there is:
//
//   <span key="cat" class="tag">{x.category}</span>
//   {x.sex ? <span key="sex" class="tag">{x.sex} only</span> : null}
//
// and it warned "Mixed keyed and unkeyed children", naming `(no text)` as the
// offending sibling. The reporting app silenced it by rendering a hidden
// placeholder element — worse code than the warning prevented, which is the
// tell that the warning was wrong. A `_Null` slot carries no identity, so there
// is nothing a key could say about it.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, mount, setDevMode } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

function setup() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  setDevMode(true);
  return {
    root,
    cleanup: () => {
      setDevMode(false);
      return closeWindow(win);
    },
  };
}

/** Capture console warnings across a render AND the re-render it schedules.
 *
 *  The keyed-children checks live in `_diffChildren`, which a FIRST mount never
 *  reaches — it builds the tree with `createDom`. A test that only mounts
 *  therefore passes whatever the rule says, which is the vacuous-assertion
 *  shape this project treats as a defect in the test. Every case here mutates a
 *  signal so the second render is a real diff. */
async function warningsDuring(fn: () => void): Promise<string[]> {
  const out: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => out.push(String(a[0]));
  try {
    fn();
    await new Promise((r) => setTimeout(r, 5));
  } finally {
    console.warn = orig;
  }
  return out;
}

Deno.test({
  name: "keys: a null slot beside keyed siblings is not 'mixed keyed'",
  async fn() {
    const { root, cleanup } = setup();
    const tick = signal(0);
    const warns = await warningsDuring(() => {
      mount(root, () =>
        h(
          "div",
          null,
          h("span", { key: "cat" }, `Infectious${tick.get()}`),
          null,
          h("span", { key: "age" }, "Adult"),
        ));
      tick.set(1);
    });
    assertEquals(
      warns.filter((w) => w.includes("Mixed keyed")),
      [],
      "the conditional branch that rendered nothing is not an unkeyed sibling",
    );
    await cleanup();
  },
});

Deno.test({
  name: "keys: a genuinely unkeyed sibling still warns",
  async fn() {
    const { root, cleanup } = setup();
    const tick = signal(0);
    const warns = await warningsDuring(() => {
      // In ONE list (an array expression): a literal unkeyed sibling beside
      // keyed ones is positionally stable and no longer warns — see
      // tests/mixed-keys-literal-siblings-around-list.test.tsx.
      mount(root, () =>
        h("div", null, [
          h("span", { key: "cat" }, `Infectious${tick.get()}`),
          h("span", null, "no key here"),
        ]));
      tick.set(1);
    });
    assertEquals(
      warns.some((w) => w.includes("Mixed keyed")),
      true,
      "a real element with no key is the case the rule exists for",
    );
    await cleanup();
  },
});

Deno.test({
  name: "keys: null slots do not push a list over the missing-keys threshold",
  async fn() {
    const { root, cleanup } = setup();
    // Two real unkeyed children plus two absent ones. The rule wants THREE
    // real array children before it speaks; counting the nulls would make it
    // speak about a two-item list.
    const tick = signal(0);
    const warns = await warningsDuring(() => {
      mount(root, () =>
        h("div", null, [
          h("span", null, `a${tick.get()}`),
          null,
          h("span", null, "b"),
          null,
        ]));
      tick.set(1);
    });
    assertEquals(
      warns.filter((w) => w.includes("children without keys")),
      [],
      "two real children are not a list that needs keys",
    );
    await cleanup();
  },
});
