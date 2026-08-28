// The user's `onStop` is AWAITED. The orchestrator budgets the hook phase (5 s
// teardown) precisely so arbitrary app code can finish; the bridge used to
// call the hook without awaiting it, so an async `onStop` — a flush, a handle
// to close, a child to wait for — was abandoned the moment it started, and the
// process exited ~ms later. Measured on a real app: a 4.5 s hook logged its
// first line and never its last, on every `am stop`.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

Deno.test({
  name: "onStop: an async hook finishes before app.close() resolves",
  async fn() {
    const name = `onstop-${crypto.randomUUID().slice(0, 8)}`;
    const c = cell(name, {
      state: { n: 0 },
      methods: {
        inc(s) {
          s.n++;
        },
      },
    });
    const events: string[] = [];
    const app = await aio.run({
      // deno-lint-ignore no-explicit-any
      cells: [c as any],
      appId: `onstop-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      logging: false,
      singleton: false,
      port: freePort(),
      baseDir: await Deno.makeTempDir(),
      appDir: await Deno.makeTempDir(),
      onStop: async () => {
        events.push("begin");
        await new Promise((r) => setTimeout(r, 400));
        events.push("end");
      },
    });
    const t0 = Date.now();
    await app.close();
    assertEquals(events, ["begin", "end"], "the hook must run to completion");
    assert(
      Date.now() - t0 >= 350,
      "close() resolved before the async onStop finished — the hook was not awaited",
    );
  },
});

Deno.test({
  name:
    "onStart: an async hook that rejects is reported, not an unhandled rejection",
  async fn() {
    const name = `onstart-${crypto.randomUUID().slice(0, 8)}`;
    const c = cell(name, {
      state: { n: 0 },
      methods: {
        inc(s) {
          s.n++;
        },
      },
    });
    let unhandled: unknown = null;
    const onUnhandled = (e: PromiseRejectionEvent) => {
      unhandled = e.reason;
      e.preventDefault();
    };
    addEventListener("unhandledrejection", onUnhandled);
    try {
      const app = await aio.run({
        // deno-lint-ignore no-explicit-any
        cells: [c as any],
        appId: `onstart-${crypto.randomUUID().slice(0, 8)}`,
        client: "server-only",
        persist: false,
        libraryMode: true,
        logging: false,
        singleton: false,
        port: freePort(),
        baseDir: await Deno.makeTempDir(),
        appDir: await Deno.makeTempDir(),
        onStart: async () => {
          await Promise.resolve();
          throw new Error("boom from an async onStart");
        },
      });
      // Let the rejection propagate through the microtask queue.
      await new Promise((r) => setTimeout(r, 50));
      await app.close();
    } finally {
      removeEventListener("unhandledrejection", onUnhandled);
    }
    assertEquals(
      unhandled,
      null,
      `an async onStart failure must go through the hook guard, got: ${unhandled}`,
    );
  },
});
