// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { Fragment, h } from "../src/vdom.ts";
import { signal } from "../src/signal.ts";
import { testComponent } from "../src/test-component.ts";

function txt(doc: any) {
  return (doc.querySelector("#r") as any).textContent;
}

// reorder a keyed list of fragments (each fragment = 2 nodes)
Deno.test("frag: keyed list reorder keeps order", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const order = signal([0, 1, 2, 3]);
  const App = () =>
    h(
      "div",
      { id: "r" },
      order.value.map((i) =>
        h(Fragment, { key: i }, h("b", null, `${i}`), h("i", null, `${i}`))
      ),
    );
  const t = testComponent(App, { document: doc });
  assertEquals(txt(doc), "0011223 3".replace(" ", ""));
  order.set([3, 1, 0, 2]);
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(txt(doc), "33110022");
  t.unmount();
  win.happyDOM.close();
});

// add + remove fragments from a keyed list
Deno.test("frag: add/remove in keyed list", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const items = signal([0, 1, 2]);
  const App = () =>
    h(
      "div",
      { id: "r" },
      items.value.map((i) => h(Fragment, { key: i }, h("b", null, `${i}`))),
    );
  const t = testComponent(App, { document: doc });
  assertEquals(txt(doc), "012");
  items.set([0, 2]);
  await new Promise((r) => setTimeout(r, 5)); // remove 1
  assertEquals(txt(doc), "02");
  items.set([0, 2, 3, 4]);
  await new Promise((r) => setTimeout(r, 5)); // add 3,4
  assertEquals(txt(doc), "0234");
  items.set([4, 0, 2, 3]);
  await new Promise((r) => setTimeout(r, 5)); // reorder
  assertEquals(txt(doc), "4023");
  t.unmount();
  win.happyDOM.close();
});

// nested fragments in a map
Deno.test("frag: nested fragments interleave correctly", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const s = signal(0);
  const App = () =>
    h(
      "div",
      { id: "r" },
      [0, 1].map((i) =>
        h(
          Fragment,
          { key: i },
          h(Fragment, null, h("b", null, `${i}a`)),
          h("i", null, `${i}b-${s.value}`),
        )
      ),
    );
  const t = testComponent(App, { document: doc });
  assertEquals(txt(doc), "0a0b-01a1b-0");
  s.set(9);
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(txt(doc), "0a0b-91a1b-9");
  t.unmount();
  win.happyDOM.close();
});

// fragment with a conditional (variable child count)
Deno.test("frag: variable child count via conditional", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const show = signal(true);
  const App = () =>
    h(
      "div",
      { id: "r" },
      h(
        Fragment,
        null,
        h("b", null, "x"),
        show.value ? h("i", null, "y") : null,
        h("u", null, "z"),
      ),
    );
  const t = testComponent(App, { document: doc });
  assertEquals(txt(doc), "xyz");
  show.set(false);
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(txt(doc), "xz");
  show.set(true);
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(txt(doc), "xyz");
  t.unmount();
  win.happyDOM.close();
});
