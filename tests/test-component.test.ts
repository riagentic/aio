// AIO-393: public testComponent + setDocument harness (symmetry with testCell).
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/vdom.ts";
import { onMount, useRef } from "../src/renderer-lifecycle.ts";
import { testComponent } from "../src/test-component.ts";

Deno.test("testComponent: mounts, exposes html, unmounts", () => {
  const win = new Window({ url: "https://localhost" });
  const App = () => h("div", null, "hi");
  const t = testComponent(App, {
    document: win.document as unknown as Document,
  });
  assertEquals(t.html(), "<div>hi</div>");
  t.unmount();
  win.happyDOM.close();
});

Deno.test("testComponent: ref + onMount work through the public harness", () => {
  const win = new Window({ url: "https://localhost" });
  let tag: string | null = null;
  const App = () => {
    const ref = useRef<HTMLElement>(null!);
    onMount(() => {
      tag = ref.current ? ref.current.nodeName : null;
    });
    return h("canvas", { ref });
  };
  const t = testComponent(App, {
    document: win.document as unknown as Document,
  });
  assertEquals(tag, "CANVAS");
  t.unmount();
  win.happyDOM.close();
});

Deno.test("testComponent: throws a clear error without a document", () => {
  let msg = "";
  try {
    testComponent(() => h("div", null), {});
  } catch (e) {
    msg = (e as Error).message;
  }
  assertEquals(msg.includes("no document"), true);
});
