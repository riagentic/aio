// Two style-object spellings where SSR and the client disagreed.
//
// - `width: NaN` (an unguarded `a / b` with b = 0): the client's
//   `setProperty("width", "NaNpx")` is an invalid value the CSSOM drops, so a
//   mounted element has no width — while SSR shipped `width:NaNpx`. A NaN is
//   "no declaration" on both sides now.
// - `cssFloat` is the CSSOM's name for `float` (`float` was reserved in old
//   JS), and React accepts it. Kebabed blindly it became `css-float`, a
//   property no browser has, on BOTH sides: the float silently did nothing.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import { _diff, _render } from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";

async function streamed(v: ReturnType<typeof h>): Promise<string> {
  let html = "";
  for await (const c of renderToStream(v)) html += c;
  return html;
}

Deno.test("style: NaN is no declaration in SSR, as on the client", async () => {
  for (const style of [{ width: NaN }, { opacity: NaN }]) {
    const v = h("div", { style });
    assertEquals(renderToString(v), "<div></div>");
    assertEquals(await streamed(v), "<div></div>");
  }
  assertEquals(
    renderToString(h("div", { style: { width: NaN, height: 2 } })),
    '<div style="height:2px"></div>',
  );
});

Deno.test("style: cssFloat is float, in SSR and on the client", async () => {
  const v = h("div", { style: { cssFloat: "left" } });
  assertEquals(renderToString(v), '<div style="float:left"></div>');
  assertEquals(await streamed(v), '<div style="float:left"></div>');

  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  try {
    const host = doc.createElement("main");
    _render(host, v, null, { doc });
    const el = host.firstChild as HTMLElement;
    assertEquals(el.style.getPropertyValue("float"), "left");
    // …and a later diff that drops it removes the real property.
    _diff(host, h("div", { style: {} }), v, { doc });
    assertEquals(el.style.getPropertyValue("float"), "");
  } finally {
    await closeWindow(win);
  }
});
