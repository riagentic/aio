// Seam: the SAME method, in-process and over a real WebSocket, must leave the
// SAME state. Sibling of tests/transport-differential.test.ts (payload shape);
// this one pins the method path hunters keep finding broken under "unit green,
// wire wrong" — ack, drain, and client replay.
import { assertEquals } from "@std/assert";
import { enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Snap = { count: number; last: string };

async function inProcess(): Promise<Snap> {
  const { cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");
  _resetAioRuntime();
  const c = cell("seaminc", {
    state: { count: 0, last: "" },
    methods: {
      inc(s: Snap, by = 1, tag = "") {
        s.count += by;
        s.last = tag;
      },
      reset(s: Snap) {
        s.count = 0;
        s.last = "";
      },
    },
  });
  await bootCells([c] as never);
  const m = c as unknown as {
    inc: (by?: number, tag?: string) => void;
    reset: () => void;
    count: number;
    last: string;
  };
  m.inc(2, "a");
  m.inc(3, "b");
  await new Promise((r) => setTimeout(r, 20));
  return { count: m.count, last: m.last };
}

async function overWire(): Promise<Snap> {
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  _resetAioRuntime();
  const c = cell("seamincw", {
    state: { count: 0, last: "" },
    methods: {
      inc(s: Snap, by = 1, tag = "") {
        s.count += by;
        s.last = tag;
      },
    },
  });
  const dir = await tempDir("seam-method-");
  const port = freePort();
  try {
    const app = await aio.run({
      cells: [c],
      appId: `seam-method-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      dbPath: ":memory:",
    } as never);
    const handle = app as unknown as {
      port: number;
      close: () => Promise<void>;
    };
    const ws = new WebSocket(`ws://localhost:${handle.port}/ws`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws never opened"));
    });
    ws.send(
      enc("action", {
        type: "seamincw:inc",
        payload: { args: [2, "a"] },
      }),
    );
    ws.send(
      enc("action", {
        type: "seamincw:inc",
        payload: { args: [3, "b"] },
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    const snap = {
      count: (c as unknown as Snap).count,
      last: (c as unknown as Snap).last,
    };
    ws.close();
    await handle.close();
    return snap;
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("seam method differential: inc sequence matches in-process vs wire", async () => {
  const direct = await inProcess();
  const wire = await overWire();
  assertEquals(
    wire,
    direct,
    `method seam diverged\n  in-process: ${JSON.stringify(direct)}\n` +
      `  over wire : ${JSON.stringify(wire)}`,
  );
  assertEquals(direct.count, 5);
  assertEquals(direct.last, "b");
});
