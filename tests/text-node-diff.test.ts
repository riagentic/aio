// Regression: adjacent dynamic text children where a LEADING child is an empty
// string must still diff the following text nodes on re-render. risoto renders
//   <div>{pending ? "~" : ""}{sol.toFixed(9)} SOL</div>
// → h("div", null, "" , "61.000000000", " SOL"). When `pending` stays false the
// leading child is always "", and a signal-driven number change (61→62) was not
// reflected in the DOM (frozen one value behind) — the electron balance bug.

import { assertEquals } from "jsr:@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";

function dom() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root, cleanup: () => win.happyDOM.close() };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("adjacent text children with leading empty string update on signal change", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const sol = signal(61);
  const pending = signal(false);
  // Exactly risoto's shape: {pending?"~":""}{number}" SOL"
  const App = () =>
    h(
      "div",
      { id: "bal" },
      pending.value ? "~" : "",
      `${sol.value}.000000000`,
      " SOL",
    );
  const handle = mount(root, App);
  assertEquals(
    root.querySelector("#bal")?.textContent,
    "61.000000000 SOL",
    "initial",
  );

  sol.set(62); // pending stays false → leading child stays ""
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#bal")?.textContent,
    "62.000000000 SOL",
    "number must update even with a leading empty-string sibling",
  );

  sol.set(63);
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#bal")?.textContent,
    "63.000000000 SOL",
    "second update",
  );

  _unmount(handle);
  await cleanup();
});

Deno.test("leading empty→nonempty transition keeps the number correct", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const sol = signal(61);
  const pending = signal(false);
  const App = () =>
    h(
      "div",
      { id: "bal" },
      pending.value ? "~" : "",
      `${sol.value}.000000000`,
      " SOL",
    );
  const handle = mount(root, App);
  // Optimistic: number bumps AND pending flips on (the airdrop moment)
  sol.set(62);
  pending.set(true);
  await tick();
  await tick();
  assertEquals(
    root.querySelector("#bal")?.textContent,
    "~62.000000000 SOL",
    "optimistic pending",
  );
  _unmount(handle);
  await cleanup();
});
