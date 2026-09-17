// Seam: the SAME method, in-process and over a real WebSocket, must leave the
// SAME state. Sibling of tests/transport-differential.test.ts (payload shape);
// this one pins the method path hunters keep finding broken under "unit green,
// wire wrong" — ack, drain, and client replay.
import { assert, assertEquals } from "@std/assert";
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

// ── A reducer throw carries the SAME code on every door ─────────────────────
//
// `bootCells`, `testUI`, WS and UDS all reject a reducer throw with
// `createAioError("REDUCE_ERROR", …)`, so `errorCode(err) === "REDUCE_ERROR"`
// is what an app's error handling keys on. `testCell` rejected with the RAW
// Error — no `.code` — so the identical assertion was green under
// `bootCells`/`testUI` and red under `testCell` for identical app code.
// Message text is unchanged: `expect.rejects(fn, /text/)` keeps matching.
import { errorCode } from "../src/protocol/envelope.ts";
import { testCell } from "../src/testing/cell-test.ts";
import { cell as defineCell } from "../mod.ts";

const thrower = defineCell("seam-reduce-code", {
  state: { n: 0 },
  methods: {
    boom(_s: { n: number }, why: string) {
      throw new Error(`boom: ${why}`);
    },
  },
});

testCell(
  thrower,
  "a reducer throw rejects with code REDUCE_ERROR, message intact",
  async (t) => {
    const err = await t.send.boom("x").then(() => undefined, (e) => e);
    assert(err instanceof Error, "rejected with an Error");
    assertEquals(
      (err as Error).message,
      "boom: x",
      "message text is the app's",
    );
    assertEquals(
      errorCode(err),
      "REDUCE_ERROR",
      "testCell must reject with the code bootCells/WS/UDS reject with",
    );
  },
);

Deno.test("the reference: bootCells rejects the same throw with REDUCE_ERROR", async () => {
  const { bootCells } = await import("../src/testing/cell-test.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  _resetAioRuntime();
  using _h = await bootCells([thrower] as never);
  const err =
    await (thrower as unknown as { boom: (w: string) => Promise<void> })
      .boom("x").then(() => undefined, (e) => e);
  assertEquals((err as Error).message, "boom: x");
  assertEquals(errorCode(err), "REDUCE_ERROR");
});
