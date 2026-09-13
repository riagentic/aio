// app-hook-async-rejection.test.ts — the APP's own `onAction` / `onEffect`
// that REJECTS is a HOOK_ERROR, the same as one that throws.
//
// The dispatch call site wrapped the hook in try/catch, which only sees a
// synchronous throw. `composeHooks` learned to guard a rejection for PLUGIN
// hooks, but with no plugins the app's hook is never composed, and the logger
// wrapper in the cells bridge dropped its return value on the floor. Measured
// on a booted app: an `async onAction` that threw for `c:inc` reached the crash
// handler as `unhandledrejection`, and one that threw for `c:__destroy` ended
// the process during `app.close()` (`Uncaught (in promise)`, exit 1). Deno's
// test runner fails a test on any unhandled rejection, so reaching the asserts
// at all is half the proof; the HOOK_ERROR reports are the other half.
import { assert, assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";

type Reported = { code: string; context: Record<string, unknown> };

async function bootWith(
  hooks: Record<string, unknown>,
  appId: string,
): Promise<{
  reported: Reported[];
  inc: () => Promise<unknown>;
  later: () => Promise<unknown>;
  close: () => Promise<void>;
}> {
  const { aio, cell } = await import("../mod.ts");
  const c = cell("c", {
    state: { v: 0 },
    methods: {
      inc(s: { v: number }) {
        s.v++;
      },
      // An async method's body runs as an effect, so `onEffect` sees it.
      // deno-lint-ignore require-await
      async later(s: { v: number }) {
        s.v++;
      },
    },
  });
  const reported: Reported[] = [];
  const app = await aio.run(
    {
      cells: [c],
      appId,
      client: "server-only",
      persist: false,
      libraryMode: true,
      port: freePort(),
      baseDir: await Deno.makeTempDir(),
      onError: (e: Reported) => void reported.push(e),
      ...hooks,
    } as Parameters<typeof aio.run>[0],
  );
  return {
    reported,
    // deno-lint-ignore no-explicit-any
    inc: () => (c as any).inc(),
    // deno-lint-ignore no-explicit-any
    later: () => (c as any).later(),
    close: () => app.close(),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

Deno.test("app hooks: an async onAction that rejects is a HOOK_ERROR, on an action and on __destroy", async () => {
  const app = await bootWith({
    // deno-lint-ignore require-await
    onAction: async (a: { type: string }) => {
      if (a.type === "c:inc" || a.type === "c:__destroy") {
        throw new Error(`hook rejected for ${a.type}`);
      }
    },
  }, "test-app-hook-async-reject");
  await app.inc();
  await settle();
  const onInc = app.reported.filter((e) => e.code === "HOOK_ERROR");
  assertEquals(onInc.length, 1, "the rejection is reported, once");
  assertEquals(onInc[0]!.context.hookName, "onAction");
  assertEquals(onInc[0]!.context.actionType, "c:inc");
  // Shutdown runs every cell's `__destroy` through the same hook — the case
  // that used to end the process.
  await app.close();
  // The __destroy rejection settles after `close()` has stopped the logger,
  // so its report arms the logger's 250 ms flush timer; wait that out rather
  // than leave the timer to the next test.
  await new Promise((r) => setTimeout(r, 300));
  assert(
    app.reported.some((e) =>
      e.code === "HOOK_ERROR" && e.context.actionType === "c:__destroy"
    ),
    "the __destroy rejection is reported, not left to kill the process",
  );
});

Deno.test("app hooks: an onEffect that returns a rejected promise is a HOOK_ERROR", async () => {
  const app = await bootWith({
    onEffect: () => Promise.reject(new Error("effect hook rejected")),
  }, "test-app-hook-async-reject-effect");
  try {
    await app.later();
    await settle();
  } finally {
    await app.close();
  }
  const onEffect = app.reported.filter((e) =>
    e.code === "HOOK_ERROR" && e.context.hookName === "onEffect"
  );
  assert(onEffect.length >= 1, "the effect hook's rejection is reported");
});
