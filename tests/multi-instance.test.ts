// perfect-aio D2 (B2) — multiple aio apps in ONE process.
// The process-wide `_running` gate is gone; isolation comes from def-level
// bind exclusivity (a cell def binds to exactly one app, loudly) + per-appId
// singleton locks. libraryMode keeps everything embeddable/testable.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { aio } from "../src/server/aio.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

Deno.test("multi-instance: two libraryMode apps coexist with disjoint cells", async () => {
  _resetAioRuntime();
  const a = cell("mi-a", {
    state: { n: 0 },
    methods: {
      bump(s) {
        s.n += 1;
      },
    },
  });
  const b = cell("mi-b", {
    state: { m: 0 },
    methods: {
      bump(s) {
        s.m += 10;
      },
    },
  });

  const app1 = await aio.run({
    cells: [a],
    appId: "mi-app-1",
    libraryMode: true,
    persist: false,
    client: "server-only",
  });
  const app2 = await aio.run({
    cells: [b],
    appId: "mi-app-2",
    libraryMode: true,
    persist: false,
    client: "server-only",
  });

  try {
    await a.bump();
    await a.bump();
    await b.bump();

    // Each app owns exactly its own slice — no cross-talk.
    const s1 = app1.getState() as Record<string, { n?: number; m?: number }>;
    const s2 = app2.getState() as Record<string, { n?: number; m?: number }>;
    assertEquals(s1["mi-a"]?.n, 2);
    assertEquals(s1["mi-b"], undefined, "app1 must not contain app2's cell");
    assertEquals(s2["mi-b"]?.m, 10);
    assertEquals(s2["mi-a"], undefined, "app2 must not contain app1's cell");
  } finally {
    await app1.close();
    await app2.close();
    _resetAioRuntime();
  }
});

Deno.test("multi-instance: binding one def to two apps throws the D2 error", async () => {
  _resetAioRuntime();
  const shared = cell("mi-shared", {
    state: { x: 0 },
    methods: {
      poke(s) {
        s.x++;
      },
    },
  });

  const app1 = await aio.run({
    cells: [shared],
    appId: "mi-excl-1",
    libraryMode: true,
    persist: false,
    client: "server-only",
  });
  try {
    let msg = "";
    try {
      await aio.run({
        cells: [shared],
        appId: "mi-excl-2",
        libraryMode: true,
        persist: false,
        client: "server-only",
      });
    } catch (e) {
      msg = String(e);
    }
    assert(msg.includes("already bound"), `expected D2 error, got: ${msg}`);
    assert(msg.includes("disjoint"), `error must teach the fix: ${msg}`);
  } finally {
    await app1.close();
    _resetAioRuntime();
  }
});
