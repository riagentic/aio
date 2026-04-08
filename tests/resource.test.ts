import { assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/signal.ts";
import { h } from "../src/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";
import type { MountHandle } from "../src/aio-renderer.ts";
import { type Resource, resource } from "../src/resource.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

Deno.test({
  name: "resource: initial fetch populates value",
  async fn() {
    const userId = signal(1);
    const res = resource(
      () => userId.value,
      async (id) => ({ id, name: `User ${id}` }),
    );

    assertEquals(res.loading.value, true);
    assertEquals(res.value, undefined);

    await delay(10);

    assertEquals(res.loading.value, false);
    assertEquals(res.value, { id: 1, name: "User 1" });
    assertEquals(res.error.value, undefined);

    res.dispose();
  },
});

Deno.test({
  name: "resource: re-fetches when source signal changes",
  async fn() {
    const userId = signal(1);
    const res = resource(
      () => userId.value,
      async (id) => ({ id, name: `User ${id}` }),
    );

    await delay(10);
    assertEquals(res.value, { id: 1, name: "User 1" });

    userId.set(2);
    await delay(10);

    assertEquals(res.value, { id: 2, name: "User 2" });
    assertEquals(res.loading.value, false);

    res.dispose();
  },
});

Deno.test({
  name: "resource: .latest persists through refetch",
  async fn() {
    let resolveSecond: ((v: string) => void) | undefined;
    const src = signal("a");

    const res = resource(
      () => src.value,
      async (key) => {
        if (key === "a") return `result-a`;
        return new Promise<string>((r) => {
          resolveSecond = r;
        });
      },
    );

    await delay(10);
    assertEquals(res.value, "result-a");
    assertEquals(res.latest.value, "result-a");

    src.set("b");
    await delay(5);
    assertEquals(res.loading.value, true);
    // AIO-256: SWR — value keeps stale data during refetch instead of flashing undefined
    assertEquals(res.value, "result-a");
    assertEquals(res.latest.value, "result-a");

    resolveSecond!("result-b");
    await delay(10);
    assertEquals(res.value, "result-b");
    assertEquals(res.latest.value, "result-b");

    res.dispose();
  },
});

Deno.test({
  name: "resource: captures fetch errors in .error signal",
  async fn() {
    const src = signal("go");
    const res = resource(
      () => src.value,
      async () => {
        throw new Error("network fail");
      },
    );

    await delay(10);
    assertEquals(res.loading.value, false);
    assertEquals(res.value, undefined);
    assertExists(res.error.value);
    assertEquals((res.error.value as Error).message, "network fail");

    res.dispose();
  },
});

Deno.test({
  name: "resource: .mutate() clears error state",
  async fn() {
    const src = signal("go");
    const res = resource(
      () => src.value,
      async (): Promise<string> => {
        throw new Error("fail");
      },
    );

    await delay(10);
    assertExists(res.error.value);
    assertEquals(res.loading.value, false);

    res.mutate("recovered");
    assertEquals(res.value, "recovered");
    assertEquals(res.error.value, undefined);
    assertEquals(res.loading.value, false);

    res.dispose();
  },
});

Deno.test({
  name: "resource: .refetch() re-triggers fetch",
  async fn() {
    let calls = 0;
    const src = signal("x");
    const res = resource(
      () => src.value,
      async () => {
        calls++;
        return `call-${calls}`;
      },
    );

    await delay(10);
    assertEquals(res.value, "call-1");

    res.refetch();
    await delay(10);
    assertEquals(res.value, "call-2");

    res.dispose();
  },
});

Deno.test({
  name: "resource: .mutate() sets value locally without refetch",
  async fn() {
    let calls = 0;
    const src = signal("x");
    const res = resource(
      () => src.value,
      async () => {
        calls++;
        return `call-${calls}`;
      },
    );

    await delay(10);
    assertEquals(res.value, "call-1");
    assertEquals(calls, 1);

    res.mutate("optimistic");
    assertEquals(res.value, "optimistic");
    assertEquals(calls, 1);

    res.dispose();
  },
});

Deno.test({
  name: "resource: aborts in-flight fetch on source change",
  async fn() {
    let aborted = false;
    const src = signal("a");

    const res = resource(
      () => src.value,
      async (_key, { signal: abortSignal }) => {
        abortSignal.addEventListener("abort", () => {
          aborted = true;
        });
        await delay(50);
        return `result-${_key}`;
      },
    );

    await delay(5);
    src.set("b");
    await delay(5);
    assertEquals(aborted, true);

    await delay(60);
    assertEquals(res.value, "result-b");

    res.dispose();
  },
});

Deno.test({
  name: "resource: works with AIR renderer",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    // Create resource outside component (correct pattern — signals live outside render)
    const src = signal("x");
    const res = resource(
      () => src.value,
      async () => "data",
    );

    function App() {
      return h("div", null, res.loading.value ? "loading" : (res.value ?? ""));
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>loading</div>");

    await delay(10);
    handle._flush();
    assertEquals(root.innerHTML, "<div>data</div>");

    res.dispose();
    _unmount(handle);
    await cleanup();
  },
});
