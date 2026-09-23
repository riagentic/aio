// A Fragment streams — so a page under a root Provider streams.
//
// `renderToStream` used to BUFFER every Fragment whole: an empty Fragment
// must emit its `<!---->` anchor, and emptiness is only certain at the end.
// A Provider renders a Fragment, so a page wrapped in one at the root — the
// ordinary way to give an app its context — was computed in ONE pull. Nothing
// was streamed: the first byte waited for the last component, and two
// requests never interleaved. Silent, because the output was identical.
//
// Found by the SSR soak (tests/air-ssr-soak.test.ts): its first page shape
// had a root Provider, and a shared `<select>` stack went green through 40
// rounds because no two renders ever had a component in flight at once.

import { assert, assertEquals } from "@std/assert";
import { createContext, h, useContext } from "../src/air.ts";
import { Fragment, Portal } from "../src/air/vdom-types.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import type { VNode } from "../src/air/vdom-types.ts";

const Theme = createContext("none");

Deno.test("SSR stream: a page under a root Provider yields before its last component runs", async () => {
  const ran: string[] = [];
  const Part = (p: { n: number }) => {
    ran.push(`part ${p.n}`);
    return h("section", null, `${useContext(Theme)} ${p.n}`);
  };
  const App = () =>
    h(
      Theme.Provider,
      { value: "dark" },
      h(Part, { n: 1 }),
      h(Part, { n: 2 }),
      h(Part, { n: 3 }),
    );
  const gen = renderToStream(h(App, null) as VNode);
  const first = await gen.next();
  assert(!first.done);
  assert(
    !ran.includes("part 3"),
    `the first chunk waited for the whole page (ran: ${ran.join(", ")}) — ` +
      "a root Provider buffered the page instead of streaming it",
  );
  let html = first.value;
  for (;;) {
    const r = await gen.next();
    if (r.done) break;
    html += r.value;
  }
  assertEquals(ran, ["part 1", "part 2", "part 3"]);
  // …and the bytes are exactly what the string renderer writes.
  assertEquals(html, renderToString(h(App, null) as VNode));
});

Deno.test("SSR stream: two root-Provider pages interleave and keep their own <select>", async () => {
  const order: string[] = [];
  const Pick = (p: { v: string }) => {
    order.push(`pick ${p.v}`);
    return h(
      "select",
      { value: p.v },
      h("option", null, "red"),
      h("option", null, "blue"),
    );
  };
  const App = (p: { v: string }) =>
    h(Theme.Provider, { value: p.v }, h(Pick, { v: p.v }), h(Tail, { v: p.v }));
  const Tail = (p: { v: string }) => {
    order.push(`tail ${p.v}`);
    return h("p", null, p.v);
  };
  const a = renderToStream(h(App, { v: "red" }) as VNode);
  const b = renderToStream(h(App, { v: "blue" }) as VNode);
  let outA = "";
  let outB = "";
  for (;;) {
    const ra = await a.next();
    const rb = await b.next();
    if (!ra.done) outA += ra.value;
    if (!rb.done) outB += rb.value;
    if (ra.done && rb.done) break;
  }
  // They really INTERLEAVED — in the RENDERING, not just the chunk order: B's
  // <select> was computed while A still had a component to run (its Tail),
  // the one window a shared <select> stack could mark the wrong option in.
  // A buffered Provider computed A whole, Tail included, before B began.
  assert(
    order.indexOf("pick blue") < order.indexOf("tail red"),
    `the two pages did not interleave: ${order.join(", ")}`,
  );
  assertEquals(
    outA,
    `<select><option selected>red</option><option>blue</option></select><p>red</p>`,
  );
  assertEquals(
    outB,
    `<select><option>red</option><option selected>blue</option></select><p>blue</p>`,
  );
  assertEquals(order.filter((o) => o.startsWith("pick")), [
    "pick red",
    "pick blue",
  ]);
});

Deno.test("SSR stream: a Fragment that holds no node still streams its anchor", async () => {
  const drain = async (v: VNode) => {
    let out = "";
    for await (const c of renderToStream(v)) out += c;
    return out;
  };
  // Nothing at all, and only a Portal: zero nodes, so the anchor holds the slot.
  const empty = h("div", null, h(Fragment, null));
  const portal = h("div", null, h(Fragment, null, h(Portal, null, "x")));
  // An empty string is still a text node: no anchor.
  const text = h("div", null, h(Fragment, null, ""));
  for (const v of [empty, portal, text]) {
    assertEquals(await drain(v as VNode), renderToString(v as VNode));
  }
  assertEquals(await drain(empty as VNode), "<div><!----></div>");
  assertEquals(await drain(text as VNode), "<div></div>");
});
