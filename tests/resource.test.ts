import { assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import type { MountHandle } from "../src/air/aio-renderer.ts";
import { type Resource, resource } from "../src/air/resource.ts";

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

// dispose() aborted the fetch and left `loading` true forever — its
// continuations early-return on `disposed`, so nothing would ever clear it.
// Every `{r.loading.value ? <Spinner/> : …}` in the app then spun for good.
Deno.test("resource: dispose() clears loading", async () => {
  const r = resource(
    () => 1,
    () => new Promise<number>((res) => setTimeout(() => res(1), 1000)),
  );
  assertEquals(r.loading.value, true);
  r.dispose();
  assertEquals(r.loading.value, false, "a torn-down resource is not loading");
  await Promise.resolve();
});

// `value` and `latest` MUST be distinguishable, or one of them is dead weight
// and its documentation is unfalsifiable.
//
// They used to be the same signal in every reachable state: `value` kept the
// previous fetch's data during a refetch (AIO-256, deliberate) AND after a
// failure (not deliberate — the error branch simply never touched it). So the
// test above ("`.latest` persists through refetch") asserted something `value`
// did too, and an app rendering `{r.value ? <Rows/> : <Spinner/>}` showed stale
// rows beside a live error, indistinguishable from fresh ones.
//
// A failure is an ANSWER: there is no result, so `value` holds none, and
// `latest` is where the last good value stays.
Deno.test({
  name: "resource: a FAILED refetch clears .value and keeps .latest",
  async fn() {
    const src = signal("a");
    const res = resource(
      () => src.value,
      (key: string) =>
        key === "a"
          ? Promise.resolve("result-a")
          : Promise.reject(new Error("refetch failed")),
    );

    await delay(10);
    assertEquals(res.value, "result-a");
    assertEquals(res.latest.value, "result-a");

    src.set("b");
    await delay(10);
    assertEquals(res.loading.value, false);
    assertExists(res.error.value);
    assertEquals(
      res.value,
      undefined,
      "a failed fetch produced no result — `value` must not report the " +
        "previous one as if it were current",
    );
    assertEquals(
      res.latest.value,
      "result-a",
      "`latest` is the last SUCCESSFUL value — it survives the failure",
    );

    res.dispose();
  },
});

Deno.test({
  name: "resource: a successful refetch still shows stale data (AIO-256 SWR)",
  async fn() {
    // The other half of the contract, pinned beside it so a future change
    // cannot quietly turn the loading window into a flash of undefined.
    let release: ((v: string) => void) | undefined;
    const src = signal("a");
    const res = resource(
      () => src.value,
      (key: string) =>
        key === "a"
          ? Promise.resolve("result-a")
          : new Promise<string>((r) => (release = r)),
    );

    await delay(10);
    src.set("b");
    await delay(5);
    assertEquals(res.loading.value, true);
    assertEquals(res.value, "result-a", "stale-while-revalidate, not a flash");
    assertEquals(res.error.value, undefined);

    release!("result-b");
    await delay(10);
    assertEquals(res.value, "result-b");
    assertEquals(res.latest.value, "result-b");

    res.dispose();
  },
});
