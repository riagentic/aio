// Repro: input DOM identity must survive a re-render when siblings are a
// mix of keyed and unkeyed nodes (dialogs with a <select> + inputs).
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { signal } from "../src/state/signal.ts";
import { testComponent } from "../src/testing/test-component.ts";

Deno.test("mixed keyed/unkeyed: input node identity survives re-render", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const name = signal("");
  // structure mirrors JobDlg: a select, an unkeyed input (name), then a
  // keyed .map() of inputs — all siblings of one parent.
  const App = () =>
    h(
      "div",
      null,
      h("select", null, h("option", { key: "o0" }, "a")),
      h("input", { value: name.value, onInput: () => {} }), // unkeyed "name"
      [0, 1, 2].map((i) => h("input", { key: i, value: String(i) })),
    );
  const t = testComponent(App, { document: doc });
  const before = doc.querySelectorAll("input")[0];
  name.set("H"); // typing fires onInput → state change → re-render
  // flush microtasks
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const after = doc.querySelectorAll("input")[0];
      assertEquals(
        after === before,
        true,
        "name input was replaced (focus would be lost)",
      );
      assertEquals((after as HTMLInputElement).value, "H");
      t.unmount();
      win.happyDOM.close();
      resolve();
    }, 10);
  });
});
