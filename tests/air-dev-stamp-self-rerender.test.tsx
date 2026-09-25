// Round 3 (air): the opt-in dev stamp `data-component` (`setDevMode(true)`)
// was written only on the mount/diff path (`afterSubtree`). A component that
// re-renders on its OWN signal takes `_rerenderComponent`, which never went
// through that hook — so when the re-render produced a NEW root element (one
// view giving way to the next), the new root carried no stamp, and the
// devtools/`am surface` lookup it exists for lost the component.
import { assert, assertEquals } from "@std/assert";
import { _setDocument, mount, setDevMode } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";

(globalThis as Record<string, unknown>).__aioDev = true;

const settle = () => new Promise((r) => setTimeout(r, 20));

Deno.test("air: data-component is re-stamped when a self re-render swaps the root element", async () => {
  const view = signal<"list" | "detail">("list");
  function Panel() {
    return view.value === "list"
      ? (
        <ul class="list">
          <li>a</li>
        </ul>
      )
      : <section class="detail">d</section>;
  }
  const Page = () => (
    <main>
      <Panel />
    </main>
  );
  const win = new Window();
  // deno-lint-ignore no-explicit-any
  _setDocument(win.document as any);
  try {
    setDevMode(true);
    const root = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(root as never);
    mount(root, Page);
    assert(
      root.innerHTML.includes('<ul class="list" data-component="Panel"'),
      root.innerHTML,
    );
    view.set("detail");
    await settle();
    const section = root.querySelector("section");
    assert(section, root.innerHTML);
    assertEquals(
      section.getAttribute("data-component"),
      "Panel",
      root.innerHTML,
    );
    view.set("list");
    await settle();
    assertEquals(
      root.querySelector("ul")?.getAttribute("data-component"),
      "Panel",
      root.innerHTML,
    );
  } finally {
    setDevMode("auto");
    _setDocument(undefined);
    await closeWindow(win);
  }
});
