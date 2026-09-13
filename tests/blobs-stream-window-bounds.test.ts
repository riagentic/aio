// blobs.stream() byte-window bounds (src/server/blobs.ts).
//
// A fractional start/end left `remaining` between 0 and 1: the stream kept
// enqueuing empty chunks forever and a reader ran out of memory. A negative
// start skipped the seek and served bytes from offset 0. Both are now a
// TypeError naming the argument, thrown before any file handle is opened.
import { assertEquals, assertRejects } from "@std/assert";
import { _resetBlobStores, openBlobStore } from "../src/server/blobs.ts";

async function withStore(
  fn: (store: ReturnType<typeof openBlobStore>) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "aio-blob-bounds-" });
  _resetBlobStores();
  try {
    await fn(openBlobStore(`bounds-${crypto.randomUUID().slice(0, 8)}`, home));
  } finally {
    _resetBlobStores();
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

/** Reads at most `cap` chunks, so a stream that never ends fails the test
 *  instead of hanging it. */
async function boundedDrain(
  s: ReadableStream<Uint8Array>,
  cap = 1000,
): Promise<{ text: string; ended: boolean }> {
  const r = s.getReader();
  let text = "";
  for (let i = 0; i < cap; i++) {
    const { done, value } = await r.read();
    if (done) return { text, ended: true };
    text += new TextDecoder().decode(value);
  }
  await r.cancel();
  return { text, ended: false };
}

async function outcome(
  store: ReturnType<typeof openBlobStore>,
  id: string,
  opts: { start?: number; end?: number },
): Promise<string> {
  try {
    const { text, ended } = await boundedDrain(await store.stream(id, opts));
    return ended ? `ok:${text}` : "never-ended";
  } catch (e) {
    return `${(e as Error).name}:${(e as Error).message}`;
  }
}

Deno.test("blobs.stream: fractional / negative / non-finite bounds are refused, naming the arg", async () => {
  await withStore(async (store) => {
    const { id } = await store.put(new TextEncoder().encode("0123456789"));
    for (
      const [opts, arg] of [
        [{ start: 2.5, end: 5 }, "start"],
        [{ start: 0, end: 4.5 }, "end"],
        [{ start: -3 }, "start"],
        [{ end: -1 }, "end"],
        [{ start: NaN }, "start"],
        [{ end: Infinity }, "end"],
      ] as const
    ) {
      const got = await outcome(store, id, opts);
      assertEquals(
        got.startsWith("TypeError:") && got.includes(`stream() ${arg}`),
        true,
        `${JSON.stringify(opts)} → ${got}`,
      );
    }
    await assertRejects(
      () => store.stream(id, { start: 1.5 }),
      TypeError,
      "non-negative integer",
    );
  });
});

Deno.test("blobs.stream: valid windows keep their exact meaning (end exclusive, past-EOF clamps)", async () => {
  await withStore(async (store) => {
    const { id } = await store.put(new TextEncoder().encode("0123456789"));
    assertEquals(await outcome(store, id, { start: 2, end: 5 }), "ok:234");
    assertEquals(await outcome(store, id, { start: 3, end: 1 }), "ok:");
    assertEquals(await outcome(store, id, { start: 20 }), "ok:");
    assertEquals(
      await outcome(store, id, { start: 0, end: 1e9 }),
      "ok:0123456789",
    );
    assertEquals(await outcome(store, id, {}), "ok:0123456789");
  });
});
