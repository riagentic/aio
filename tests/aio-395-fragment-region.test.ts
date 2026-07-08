// Repro: fragments inside .map() across re-renders — order must be stable
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { Fragment, h } from "../src/air/vdom.ts";
import { signal } from "../src/state/signal.ts";
import { testComponent } from "../src/testing/test-component.ts";

Deno.test("fragment-in-map keeps DOM order across re-renders", async () => {
  const win = new Window({ url: "https://localhost" });
  const flag = signal(false);
  const App = () =>
    h(
      "div",
      null,
      [0, 1, 2].map((i) =>
        h(
          Fragment,
          null,
          h("span", { key: `l${i}` }, `L${i}`),
          h("input", { key: i, disabled: flag.value && i > 0 }),
        )
      ),
    );
  const t = testComponent(App, {
    document: win.document as unknown as Document,
  });
  const order = () =>
    t.html().replace(/<div>|<\/div>/g, "").replace(/ disabled=""/g, "!")
      .replace(/<input!?>/g, (m: string) => m.includes("!") ? "D" : "I")
      .replace(/<span>(L\d)<\/span>/g, "$1,");
  assertEquals(order(), "L0,IL1,IL2,I");
  flag.set(true);
  await new Promise((r) => setTimeout(r, 20));
  console.log("after rerender:", t.html());
  assertEquals(order(), "L0,IL1,DL2,D");
  t.unmount();
  win.happyDOM.close();
});
