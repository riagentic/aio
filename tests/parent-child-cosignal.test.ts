// Regression: a child component inside a keyed .map() that re-renders on its OWN
// signal, WHILE the parent also re-renders on a DIFFERENT signal in the same
// flush, must still have its DOM updated. This mirrors risoto: NavigatorPanel
// (reads `nav`) wraps NavigatorItem rows (read `balances`) in a keyed map; an
// airdrop changes BOTH cells at once, and the balance row froze at its
// mount-time value while its body demonstrably re-rendered with the new value.

import { assertEquals } from "jsr:@std/assert";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Window } from "happy-dom";

function dom() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root, cleanup: () => win.happyDOM.close() };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("child re-renders correctly when parent co-re-renders on another signal", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);

  const bal = signal(58); // "balances" — read by the child
  const navMsg = signal("ready"); // "nav" — read by the parent only

  const Row = (props: { id: string }) =>
    h("div", { id: props.id }, `${bal.value}.000000000 SOL`);

  const Panel = () => {
    void navMsg.value; // parent subscribes to nav
    const items = ["a", "b", "c"];
    return h(
      "div",
      null,
      items.map((k) =>
        h("div", { key: k }, h(Row as never, { id: "row-" + k }))
      ),
    );
  };

  const handle = mount(root, Panel);
  assertEquals(
    root.querySelector("#row-a")?.textContent,
    "58.000000000 SOL",
    "initial",
  );

  // The airdrop moment: BOTH cells change (child's signal + parent's signal).
  bal.set(59);
  navMsg.set("Requesting airdrop…");
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#row-a")?.textContent,
    "59.000000000 SOL",
    "after co-change 1",
  );

  // Again — confirms it's not a one-shot.
  bal.set(60);
  navMsg.set("ready");
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#row-a")?.textContent,
    "60.000000000 SOL",
    "after co-change 2",
  );

  // Child-only change (parent quiet).
  bal.set(61);
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#row-a")?.textContent,
    "61.000000000 SOL",
    "child-only change",
  );

  _unmount(handle);
  await cleanup();
});
