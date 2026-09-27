// A fetcher that throws SYNCHRONOUSLY (a plain function, not `async`: an RPC
// client that validates its argument, an `encodeURIComponent` of a lone
// surrogate while building the URL) is a failed fetch like any other: `error`
// holds the throw, `loading` ends, `value` has no result. The throw used to
// escape `doFetch` — `loading` stayed true for good (a spinner that never
// ends), `error` stayed empty, the previous value stayed on screen, and on
// the FIRST fetch `resource()` itself threw.
import { assertEquals } from "@std/assert";
import { resource } from "../src/air/resource.ts";
import { signal } from "../src/state/signal.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("resource: a fetcher's synchronous throw is a failed fetch — error set, loading false", async () => {
  const id = signal(1);
  const r = resource(() => id.value, (v: number) => {
    if (v === 2) throw new Error("bad id");
    return Promise.resolve(v * 10);
  });
  await tick();
  assertEquals([r.value, r.loading.value], [10, false]);

  id.set(2);
  await tick();
  assertEquals(r.loading.value, false);
  assertEquals((r.error.value as Error)?.message, "bad id");
  assertEquals(r.value, undefined);
  assertEquals(r.latest.value, 10);

  id.set(3); // recovers on the next source
  await tick();
  assertEquals([r.value, r.loading.value, r.error.value], [
    30,
    false,
    undefined,
  ]);
  r.dispose();
});

Deno.test("resource: a synchronous throw on the FIRST fetch does not throw out of resource()", async () => {
  const r = resource(() => 0, (): Promise<number> => {
    throw new Error("first");
  });
  await tick();
  assertEquals(r.loading.value, false);
  assertEquals((r.error.value as Error)?.message, "first");
  r.dispose();
});
