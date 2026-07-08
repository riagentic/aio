import { assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { connectAioDevTools } from "../src/diagnostics/devtools.ts";
import type { RenderEvent } from "../src/diagnostics/devtools.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

Deno.test({
  name: "devtools: records signal name in render event",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    const devtools = connectAioDevTools();
    const count = signal(0, { name: "count" });

    function Counter() {
      return h("div", null, String(count.value));
    }

    const handle = mount(root, Counter);
    assertEquals(root.innerHTML, "<div>0</div>");

    count.set(1);
    handle._flush();
    assertEquals(root.innerHTML, "<div>1</div>");

    const renders = devtools.renders;
    const signalRender = renders.find(
      (r: RenderEvent) =>
        r.trigger === "signal" && r.signalNames?.includes("count"),
    );
    assertExists(signalRender);

    devtools.disconnect();
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "devtools: unnamed signal shows as anonymous",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    const devtools = connectAioDevTools();
    const val = signal("hello");

    function App() {
      return h("div", null, val.value);
    }

    const handle = mount(root, App);
    val.set("world");
    handle._flush();

    const renders = devtools.renders;
    const lastRender = renders[renders.length - 1];
    assertExists(lastRender);
    assertEquals(lastRender.trigger, "signal");
    // Should have signalNames with "anonymous"
    assertExists(lastRender.signalNames);
    assertEquals(lastRender.signalNames!.includes("anonymous"), true);

    devtools.disconnect();
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "signal: debug name is stored and accessible",
  async fn() {
    const named = signal(42, { name: "mySignal" });
    assertEquals(named._name, "mySignal");

    const unnamed = signal(0);
    assertEquals(unnamed._name, undefined);
  },
});
