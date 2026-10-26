// An async `close` was never awaited: the next `open` (same key after a
// `null`, or a new key) ran while the old resource was still being released —
// two pipelines on one exclusive device, the thing the module promises to
// rule out ("closes the old resource before opening the new one").
import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { signal } from "../src/state/signal.ts";
import { _openResourceCount, useResource } from "../src/air/use-resource.ts";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function run(keys: (string | null)[]): Promise<string[]> {
  const log: string[] = [];
  const key = signal<string | null>(keys[0]!);
  const h = useResource({
    key: () => key.value,
    open: async (id: string | number) => {
      log.push(`open ${id}`);
      await wait(1);
      return { id };
    },
    close: async (v: { id: string | number }) => {
      log.push(`close ${v.id} start`);
      await wait(30);
      log.push(`close ${v.id} done`);
    },
  });
  await wait(10);
  for (const k of keys.slice(1)) key.set(k);
  assertEquals(h.loading.peek(), true, "loading while the old one closes");
  await wait(80);
  assertEquals(h.loading.peek(), false);
  h.dispose();
  await wait(50);
  assertEquals(_openResourceCount(), 0);
  return log;
}

Deno.test("useResource: a → null → a reopens only after the async close resolves", async () => {
  assertEquals((await run(["a", null, "a"])).slice(0, 4), [
    "open a",
    "close a start",
    "close a done",
    "open a",
  ]);
});

Deno.test("useResource: a → b opens b only after a's async close resolves", async () => {
  assertEquals((await run(["a", "b"])).slice(0, 4), [
    "open a",
    "close a start",
    "close a done",
    "open b",
  ]);
});

// An open still IN FLIGHT when the key moves on, with an `open` that ignores
// the abort signal (getUserMedia, a serial port): the next open waits for it
// to land AND for its late close.
async function runSlowOpen(keys: (string | null)[]): Promise<string[]> {
  const log: string[] = [];
  const key = signal<string | null>(keys[0]!);
  const h = useResource({
    key: () => key.value,
    open: async (id: string | number) => {
      log.push(`open ${id} start`);
      await wait(30);
      log.push(`open ${id} done`);
      return { id };
    },
    close: async (v: { id: string | number }) => {
      log.push(`close ${v.id} start`);
      await wait(20);
      log.push(`close ${v.id} done`);
    },
  });
  await wait(5);
  for (const k of keys.slice(1)) key.set(k);
  await wait(150);
  assertEquals(h.loading.peek(), false);
  h.dispose();
  await wait(50);
  assertEquals(_openResourceCount(), 0);
  return log;
}

for (const keys of [["a", "b"], ["a", null, "a"]]) {
  const next = keys[keys.length - 1];
  Deno.test(`useResource: ${keys.map(String).join(" → ")} with "a" still opening waits for its open and late close`, async () => {
    assertEquals((await runSlowOpen(keys)).slice(0, 6), [
      "open a start",
      "open a done",
      "close a start",
      "close a done",
      `open ${next} start`,
      `open ${next} done`,
    ]);
  });
}

// The wait is BOUNDED: an open that never settles (a permission prompt nobody
// answers, a hung device) must not block the next key forever. After the
// bound the next open proceeds, and it says why.
Deno.test("useResource: a never-settling open delays the next key by the bound, then it opens and warns", async () => {
  const time = new FakeTime();
  const said: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  const key = signal<string | null>("a");
  const h = useResource({
    key: () => key.value,
    open: (id: string | number) =>
      id === "a" ? new Promise<{ id: string | number }>(() => {}) : { id },
    close: () => {},
  });
  try {
    key.set("b");
    await time.tickAsync(4999);
    assertEquals(h.loading.peek(), true, "still within the bound");
    assertEquals(said, []);
    await time.tickAsync(1);
    await time.runMicrotasks();
    assertEquals(h.value, { id: "b" });
    assertEquals(h.loading.peek(), false);
    assertEquals(said.length, 1);
    assertEquals(said[0]!.includes('before "b" has not settled'), true);
    key.set("c");
    await time.runMicrotasks();
    assertEquals(h.value, { id: "c" }, "given up on: no second wait");
  } finally {
    h.dispose();
    console.warn = w;
    time.restore();
  }
  assertEquals(_openResourceCount(), 0);
});
