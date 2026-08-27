// Event wiring defects the delegated path had fixed and the other paths did
// not — two questions with two answers where there should be one.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, doc, root };
}

// `_wrappedListeners` is a GLOBAL element→handler map with no record of which
// delegation root registered an entry. Mount a second root into a container
// that sits INSIDE a live root — which `island()` does by construction — and
// both roots' listeners walked the same composedPath and both found the inner
// element's handler: every inner click fired TWICE.
Deno.test({
  name: "delegation: a root nested inside another root does not double-fire",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);

    let inner = 0;
    let outerOnHost = 0;

    // Outer app renders a host element that an inner root will mount into.
    const Outer = () =>
      h("section", { onClick: () => outerOnHost++ }, h("div", { id: "host" }));
    const outerHandle = mount(root, Outer);
    const host = root.querySelector("#host") as HTMLElement;

    const Inner = () =>
      h("button", { onClick: () => inner++, t: "b" }, "click me");
    const innerHandle = mount(host, Inner);

    const btn = host.querySelector("button") as HTMLElement;
    btn.dispatchEvent(
      // deno-lint-ignore no-explicit-any
      new (doc.defaultView as any).Event("click", {
        bubbles: true,
        composed: true,
      }),
    );

    assertEquals(inner, 1, "the inner handler fires exactly once");
    // The outer root still sees the bubbling event on its OWN element.
    assertEquals(outerOnHost, 1, "outer ancestors still receive the event");

    _unmount(innerHandle);
    _unmount(outerHandle);
    await win.happyDOM.close();
  },
});

// A throwing handler is CONTAINED and reported on the delegated path
// (vdom-events.ts). On the non-delegated path — focus, blur, scroll,
// mouseenter/leave, wheel, composition, every media event — it was not wrapped
// at all: the throw went into the browser with nothing naming it, and in a test
// it surfaced (if at all) as an unrelated failure somewhere later.
Deno.test({
  name: "non-delegated handlers: a throw is contained and reported",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);

    const errs: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));

    try {
      let after = 0;
      const App = () =>
        h(
          "div",
          null,
          h("input", {
            "aria-label": "f",
            onFocus: () => {
              throw new Error("handler blew up");
            },
          }),
          h("span", { onMouseEnter: () => after++ }, "x"),
        );
      const handle = mount(root, App);
      const input = root.querySelector("input") as HTMLElement;
      const span = root.querySelector("span") as HTMLElement;

      // Must NOT throw out of dispatchEvent.
      input.dispatchEvent(
        // deno-lint-ignore no-explicit-any
        new (doc.defaultView as any).Event("focus", {}),
      );
      assertEquals(
        errs.some((e) => e.includes("event handler error (onfocus)")),
        true,
        `expected a contained report, got ${JSON.stringify(errs)}`,
      );

      // ...and the page keeps working.
      span.dispatchEvent(
        // deno-lint-ignore no-explicit-any
        new (doc.defaultView as any).Event("mouseenter", {}),
      );
      assertEquals(after, 1);
      _unmount(handle);
    } finally {
      console.error = origError;
    }
    await win.happyDOM.close();
  },
});
