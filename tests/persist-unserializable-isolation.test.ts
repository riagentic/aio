// Audit 2026-08-27 (HIGH, data loss): ONE `BigInt` (or one cyclic reference)
// anywhere in state stopped ALL state persistence, app-wide, forever.
//
// `JSON.stringify` throws before the round-trip guard can build its issue list.
// The throw escaped the per-cell loop in `_planKv`, so `kv` was null and NOTHING
// was written — every other cell's changes lost, on every window and on the
// shutdown flush — under a message that named neither the cell nor the path
// (which is the guard's entire purpose) and blamed `getDBState`.
//
// Reproduced before the fix: `bad.big = 123n` froze `good` at its first value
// for the rest of the process. These tests are that reproduction.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { createDB } from "../src/server-entry.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import {
  findUnserializable,
  PersistSerializeError,
  stringifyWithIssues,
} from "../src/server/persist-guard.ts";

type LogEntry = { level: string; msg: string };
function makeLog(entries: LogEntry[]): Log {
  const push = (level: string) => (msg: string) => entries.push({ level, msg });
  return {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  } as unknown as Log;
}

async function harness(
  mode: "single" | "multi",
  state: { v: Record<string, unknown> },
) {
  const dir = await Deno.makeTempDir({ prefix: "persist-refuse-" });
  const db = createDB(join(dir, "state.db"));
  await db.execute(SKV_SCHEMA);
  const kv = sqliteKv(db);
  const logs: LogEntry[] = [];
  const errors: unknown[] = [];
  const mgr = createPersistenceManager({
    kvDb: kv,
    asyncDb: db,
    dbSchema: undefined,
    persistKey: "app-state",
    persistMode: mode,
    persistMs: 5,
    getState: () => state.v,
    getDBState: (s) => s,
    log: makeLog(logs),
    getReportOpts: () => ({ onError: (e: unknown) => errors.push(e) }),
    appId: "app",
  });
  const stored = async (): Promise<Record<string, unknown> | null> =>
    mode === "multi"
      ? await kv.getMulti<Record<string, unknown>>("app-state")
      : await kv.get<Record<string, unknown>>("app-state");
  return {
    mgr,
    kv,
    logs,
    errors,
    stored,
    [Symbol.asyncDispose]: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

for (const mode of ["single", "multi"] as const) {
  Deno.test(`persist ${mode}: one BigInt cell never costs another cell its write`, async () => {
    const state = {
      v: { good: { n: 1 }, bad: { x: 1 } } as Record<string, unknown>,
    };
    await using h = await harness(mode, state);

    await h.mgr.flushPersist();
    assertEquals((await h.stored())?.good, { n: 1 });

    // The BigInt lands, and the app keeps working.
    state.v = { good: { n: 2 }, bad: { x: 1, big: 123n } };
    await h.mgr.flushPersist();
    state.v = { good: { n: 3 }, bad: { x: 1, big: 123n } };
    await h.mgr.flushPersist();

    const after = await h.stored();
    assertEquals(after?.good, { n: 3 }, "every other cell still persists");
    assertEquals(
      after?.bad,
      { x: 1 },
      "the refused cell keeps its last successfully written value",
    );

    // The report names the CELL, the PATH and the fix — the guard's job.
    const msg = h.logs.filter((l) => l.level === "error").map((l) => l.msg)
      .join("\n");
    assert(msg.includes(`cell "bad"`), msg);
    assert(msg.includes("bad.big"), msg);
    assert(msg.includes("BigInt"), msg);
    assert(msg.includes("fix:"), msg);
    assert(!msg.includes("getDBState"), `misattributed to getDBState:\n${msg}`);
    const reported = h.errors
      .map((e) => String((e as { cause?: unknown })?.cause ?? e)).join("\n");
    assertStringIncludes(
      reported,
      "bad",
      "onError must name the offending cell, not merely fire",
    );
  });

  Deno.test(`persist ${mode}: a cyclic reference is named by path, and isolated`, async () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.child = { parent: cyclic };
    const state = {
      v: { good: { n: 1 }, bad: { x: 1 } } as Record<string, unknown>,
    };
    await using h = await harness(mode, state);
    await h.mgr.flushPersist();

    state.v = { good: { n: 2 }, bad: cyclic };
    await h.mgr.flushPersist();

    assertEquals((await h.stored())?.good, { n: 2 });
    assertEquals((await h.stored())?.bad, { x: 1 });
    const msg = h.logs.filter((l) => l.level === "error").map((l) => l.msg)
      .join("\n");
    assert(msg.includes("bad.child.parent"), msg);
    assert(msg.includes("circular"), msg);
  });

  Deno.test(`persist ${mode}: a cell refused from the FIRST window keeps what is on disk`, async () => {
    // The hard case: this process has never written the cell, so there is no
    // in-memory "last good" — the stored slice from a previous run is what must
    // survive. Single mode writes the whole document as one row, so getting
    // this wrong deletes the cell's data outright.
    const dir = await Deno.makeTempDir({ prefix: "persist-refuse-boot-" });
    const db = createDB(join(dir, "state.db"));
    try {
      await db.execute(SKV_SCHEMA);
      const kv = sqliteKv(db);
      // A previous run's data.
      if (mode === "multi") {
        await kv.setMulti("app-state", {
          good: { n: 1 },
          bad: { kept: "from the last run" },
        });
      } else {
        await kv.set("app-state", {
          good: { n: 1 },
          bad: { kept: "from the last run" },
        });
      }

      const state = {
        v: { good: { n: 2 }, bad: { kept: "from the last run", big: 1n } },
      };
      const logs: LogEntry[] = [];
      const mgr = createPersistenceManager({
        kvDb: kv,
        asyncDb: db,
        dbSchema: undefined,
        persistKey: "app-state",
        persistMode: mode,
        persistMs: 5,
        getState: () => state.v as Record<string, unknown>,
        getDBState: (s) => s,
        log: makeLog(logs),
        getReportOpts: () => ({}),
        appId: "app",
        storedKeys: ["good", "bad"],
      });
      await mgr.flushPersist();

      const after = mode === "multi"
        ? await kv.getMulti<Record<string, unknown>>("app-state")
        : await kv.get<Record<string, unknown>>("app-state");
      assertEquals(after?.good, { n: 2 }, "the healthy cell advanced");
      assertEquals(
        after?.bad,
        { kept: "from the last run" },
        "the refused cell's stored data survived — it was never deleted",
      );
    } finally {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("persist single: a never-stored refused cell is omitted, losing nothing", async () => {
  const state = {
    v: { good: { n: 1 }, bad: { big: 7n } } as Record<string, unknown>,
  };
  await using h = await harness("single", state);
  await h.mgr.flushPersist();
  const after = await h.stored();
  assertEquals(after?.good, { n: 1 });
  assertEquals("bad" in (after ?? {}), false);
});

Deno.test("persist: the shutdown flush still writes every healthy cell", async () => {
  const state = {
    v: { good: { n: 1 }, bad: { x: 1 } } as Record<string, unknown>,
  };
  await using h = await harness("single", state);
  await h.mgr.flushPersist();
  state.v = { good: { n: 9 }, bad: { x: 1, big: 2n } };
  h.mgr.setShuttingDown();
  await h.mgr.flushPersist(); // the LAST chance to write anything
  assertEquals((await h.stored())?.good, { n: 9 });
});

Deno.test("persist-guard: a refused value is located, not just refused", () => {
  const e = (() => {
    try {
      stringifyWithIssues({ a: { b: [1, 2, { c: 5n }] } });
      return null;
    } catch (err) {
      return err as PersistSerializeError;
    }
  })();
  assert(e instanceof PersistSerializeError);
  assertEquals(e.path, "a.b.2.c");
  assertEquals(e.kind, "bigint");
  assert(e.message.includes("fix:"), e.message);
  assertEquals(e.withPrefix("cart").path, "cart.a.b.2.c");

  const cyc: Record<string, unknown> = {};
  cyc.self = { back: cyc };
  assertEquals(findUnserializable(cyc), {
    path: "self.back",
    kind: "circular",
  });
  // A shared (non-cyclic) reference is not a cycle — JSON writes it twice.
  const shared = { x: 1 };
  assertEquals(findUnserializable({ a: shared, b: shared }), null);
});
