// The SAME end-of-life contract, on the other runtime.
//
// `src/server/shutdown.ts` Phase 1 is a four-step promise: close the door,
// ABORT every in-flight async method so a stream takes its own cancellation
// path, WAIT for the writes it makes on the way out, and only then write the
// final snapshot. `tests/shutdown-inflight.test.ts` pins it, and it exists
// because a chat that was streaming a reply when the window closed came back
// on the next launch with the conversation missing.
//
// `src/standalone-air.ts` is the runtime an Android APK ships (and the one the
// in-process harnesses boot), and its `close()` decided the same fact a second
// time: close the queue, flush localStorage, return — no abort, no wait. So the
// snapshot it wrote was the state as of the instant close() was called, and
// everything an in-flight method still had to write depended on a debounce
// timer firing in a process that is being torn down. On Android, where close()
// IS the process ending, that timer does not fire. Identical bug, identical
// symptom, one runtime later.
//
// Two runtimes, one contract: what `close()` returns must be what the next
// launch reads.
import { assert, assertEquals } from "@std/assert";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storage.set(k, v);
    },
    removeItem: (k: string) => {
      storage.delete(k);
    },
    clear: () => storage.clear(),
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
  },
  writable: true,
  configurable: true,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// deno-lint-ignore no-explicit-any
type Any = any;

type Doc = { chunks: string[]; status: string };

Deno.test({
  name:
    "standalone close: an in-flight method is aborted and its last write is in the flush",
  async fn() {
    storage.clear();
    const sa = await import("../src/standalone-air.ts");
    const { cell } = sa;
    sa._reset();
    const streamer = cell("sastream", {
      // alpha52: streaming cell — incremental commits, the documented opt-out.
      transaction: false,
      state: { chunks: [] as string[], status: "idle" } as Doc,
      methods: {
        // The shape of every streaming reply: only its abort signal ends it.
        async reply(s: Doc & { $signal: AbortSignal }) {
          s.status = "streaming";
          for (let i = 0; i < 500; i++) {
            if (s.$signal.aborted) {
              s.status = "aborted";
              return;
            }
            await sleep(4);
            s.chunks = [...s.chunks, `c${i}`];
          }
          s.status = "done";
        },
      },
    });
    try {
      const app = await sa.aio.run({
        appId: "sa-close",
        cells: [streamer],
        persist: true,
      }) as Any;

      const call = (streamer as Any).reply() as Promise<unknown>;
      await sleep(60); // a few chunks in — the scenario is real
      const mid = (app.getState() as Record<string, Doc>).sastream!;
      assertEquals(mid.status, "streaming");
      assert(mid.chunks.length > 0);

      const t0 = Date.now();
      await app.close();
      const elapsed = Date.now() - t0;
      // Bounded, exactly like the server's Phase 1: a method that ignored its
      // signal must not hold the app open, and a well-behaved one returns at
      // its first check.
      assert(
        elapsed < 4000,
        `close() took ${elapsed}ms — the drain must be bounded`,
      );

      // What close() PROMISED is what the next launch reads. Nothing after
      // this line is allowed to matter: on Android the process is gone.
      const raw = localStorage.getItem("aio:sa-close");
      assert(raw, "close() must have flushed");
      const doc = (JSON.parse(raw!) as Record<string, Doc>).sastream!;
      assertEquals(
        doc.status,
        "aborted",
        "close() must abort the in-flight call so the stream can end itself, " +
          "wait for the write it makes on the way out, and only then flush — " +
          "the same four steps the server runtime takes (shutdown.ts Phase 1)",
      );
      assert(
        doc.chunks.length >= mid.chunks.length && doc.chunks.length < 500,
        `the partial stream survives: ${mid.chunks.length} mid-flight, ` +
          `${doc.chunks.length} flushed`,
      );
      await call; // the caller is told the truth: it ended, it did not blow up
    } finally {
      sa._reset();
      storage.clear();
    }
  },
});

Deno.test({
  name:
    "standalone close: a method that ignores its abort signal cannot hold the app open",
  async fn() {
    storage.clear();
    const sa = await import("../src/standalone-air.ts");
    const { cell } = sa;
    sa._reset();
    const deaf = cell("sadeaf", {
      state: { chunks: [] as string[], status: "idle" } as Doc,
      methods: {
        async grind(s: Doc) {
          for (let i = 0; i < 4000; i++) await sleep(5);
          s.status = "done";
        },
      },
    });
    try {
      await sa.aio.run({
        appId: "sa-deaf",
        cells: [deaf],
        persist: true,
      }) as Any;
      const call = ((deaf as Any).grind() as Promise<unknown>).catch(() => {});
      await sleep(30);
      const t0 = Date.now();
      await (await import("../src/standalone-air.ts")).aio.run({
        appId: "sa-deaf",
        cells: [deaf],
      }).then((a: Any) => a.close());
      const elapsed = Date.now() - t0;
      assert(
        elapsed < 6000,
        `close() waited ${elapsed}ms on a method that ignores its signal`,
      );
      void call;
    } finally {
      sa._reset();
      storage.clear();
    }
  },
});
