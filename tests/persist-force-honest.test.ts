// Audit a4 (C): `am persist` / `POST /__aio/trojan/persist` answered
// "persisted" before any write. `forcePersist` was `schedulePersist()` — it
// armed the debounce timer and returned — so the reply's `ok: true` was a
// promise about the future, and a SIGKILL inside the window lost a write the
// operator had just been told was safe.
//
// Now `forcePersist` IS the flush, awaited: the reply comes back once the
// cycle has landed, and a cycle that reported a failure is a 500.
import { assert, assertEquals } from "@std/assert";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { createDB } from "../src/server-entry.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { createPersistenceManager } from "../src/server/persistence.ts";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { DB } from "../src/db/types.ts";
import { pk, table, text } from "../src/server/sql.ts";

async function withTrojan(
  forcePersist: () => Promise<void>,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  const port = freePort();
  const server = createServer({
    port,
    title: "PersistHonest",
    getUIState: () => ({}),
    dispatch: () => {},
    getSnapshot: () => "{}",
    loadSnapshot: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      forcePersist,
      startedAt: Date.now(),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

const post = (url: string) =>
  fetch(`${url}/__aio/trojan/persist`, {
    method: "POST",
    headers: { "X-AIO": "1" },
  });

Deno.test("trojan persist: the reply waits for the write to land", async () => {
  let landed = false;
  await withTrojan(
    async () => {
      await new Promise((r) => setTimeout(r, 80));
      landed = true;
    },
    async (url) => {
      const resp = await post(url);
      assertEquals(resp.status, 200);
      assertEquals((await resp.json()).ok, true);
      assert(landed, "ok:true must mean the flush has RUN, not been scheduled");
    },
  );
});

Deno.test("trojan persist: a refused write is a 500, never 'persisted'", async () => {
  await withTrojan(
    () => Promise.reject(new Error("disk is full")),
    async (url) => {
      const resp = await post(url);
      assertEquals(resp.status, 500);
      const body = await resp.json();
      assert(
        /persist failed.*disk is full/.test(String(body.error)),
        JSON.stringify(body),
      );
    },
  );
});

/** A DB whose writes always fail — the shape of a full disk. */
function failingDb(): DB {
  return {
    // deno-lint-ignore no-explicit-any
    async query<T>(): Promise<any> {
      return { rows: [] as T[], changes: 0, lastInsertRowId: 0n };
    },
    async execute() {
      return { rows: [], changes: 0, lastInsertRowId: 0n };
    },
    async transaction(): Promise<never> {
      throw new Error("disk is full");
    },
    async close() {},
  };
}

Deno.test("persistence manager: flushPersist() resolves, lastCycleError() carries the verdict", async () => {
  const state = { notes: { items: [{ id: 1, v: "one" }] } };
  const p = createPersistenceManager({
    appId: "force-honest",
    persistKey: "force-honest",
    persistMode: "single",
    persistMs: 10,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    getState: () => state as unknown as Record<string, unknown>,
    getDBState: (s: Record<string, unknown>) => s,
    getTableState: () => ({ notes_items: state.notes.items }),
    asyncDb: failingDb(),
    dbSchema: { notes_items: table({ id: pk(), v: text() }) },
    kvDb: null,
    getReportOpts: () => ({ onError: () => {} }),
    // deno-lint-ignore no-explicit-any
  } as any);
  state.notes.items = [{ id: 1, v: "two" }];
  await p.flushPersist(); // never rejects — the loop must survive
  const err = p.lastCycleError();
  assert(err, "a refused cycle must be readable after the flush");
  assert(/disk is full/.test(err.message), err.message);
});

// 50audits §1 + §2 (RED, silent data loss): the three tests above could not
// see the bug they were written for. Two of them inject their own
// `forcePersist`, and the manager one picks `transaction()` throwing — the one
// failure mode that reaches `_reportPersistError` DIRECTLY. The refusal that
// actually happens in the field goes through `_reportRefusedCell`, which
// deduped the verdict along with the log line: cycle 1 reported, cycle 2 and
// every cycle after it reported NOTHING, so `am persist` answered
// `{"ok":true}` forever while nothing reached disk.
//
// The only place the bug lives is the SECOND cycle against the same refused
// cell. That is what this test is.
Deno.test("persistence manager: a cell refused TWICE reports on the second cycle too", async () => {
  const dir = await tempDir("persist-verdict-");
  const db = createDB(join(dir, "state.db"));
  await db.execute(SKV_SCHEMA);
  const kv = sqliteKv(db);
  const errorLines: string[] = [];
  // A BigInt is what a real app produces — `JSON.stringify` throws on it, and
  // that throw is the per-cell refusal path.
  const state = {
    todo: { items: [{ id: 1 }], scratch: 0n as unknown },
  } as Record<string, unknown>;
  const p = createPersistenceManager({
    appId: "verdict",
    persistKey: "verdict",
    persistMode: "single",
    persistMs: 5,
    log: {
      debug() {},
      info() {},
      warn() {},
      error(m: string) {
        errorLines.push(m);
      },
    },
    getState: () => state,
    getDBState: (s: Record<string, unknown>) => s,
    kvDb: kv,
    asyncDb: db,
    dbSchema: undefined,
    getReportOpts: () => ({ onError: () => {} }),
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    await p.flushPersist();
    assert(p.lastCycleError(), "cycle 1 must report the refusal");

    // A real change the operator then asks to flush.
    (state.todo as { items: { id: number }[] }).items.push({ id: 2 });
    await p.flushPersist();
    const second = p.lastCycleError();
    assert(
      second,
      "cycle 2 refused the same cell and answered `ok` — this is the lie " +
        "`am persist` told forever",
    );
    assert(/was NOT written/.test(second.message), second.message);

    // A third, to pin that it is not an off-by-one.
    (state.todo as { items: { id: number }[] }).items.push({ id: 3 });
    await p.flushPersist();
    assert(p.lastCycleError(), "cycle 3 must report too");

    // The dedupe still does its ONE job: the console is not spammed.
    const refusals = errorLines.filter((m) => /was NOT written/.test(m));
    assertEquals(
      refusals.length,
      1,
      `the log line must stay deduped, got ${refusals.length}`,
    );

    // And the verdict clears when the value is fixed — a stuck `true` would
    // be the same defect wearing the other mask.
    (state.todo as Record<string, unknown>).scratch = null;
    await p.flushPersist();
    assertEquals(p.lastCycleError(), null, "a clean cycle must clear it");
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});

Deno.test("end to end: after POST /persist the write is on disk while the app still runs", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = join(dir, "data.db");
  const port = freePort();
  _resetAioRuntime();
  const c = cell("fh_counter", {
    state: { n: 0 },
    methods: {
      add(s: { n: number }, by: number) {
        s.n += by;
      },
    },
  });
  const app = await aio.run({
    cells: [c],
    appId: "force-honest-e2e",
    dbPath,
    port,
    persistDebounceMs: 999999, // only the forced flush can write
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  });
  try {
    await (c as unknown as { add: (n: number) => Promise<void> }).add(9);
    const resp = await post(`http://127.0.0.1:${port}`);
    assertEquals(resp.status, 200);
    assertEquals((await resp.json()).ok, true);
    // Second connection, process still alive: the reply's claim, checked.
    const conn = new DatabaseSync(dbPath);
    try {
      const rows = conn.prepare("SELECT v FROM aio_kv").all() as {
        v: string;
      }[];
      assert(
        rows.some((r) => r.v.includes('"n":9')),
        "ok:true arrived before the write was on disk",
      );
    } finally {
      conn.close();
    }
  } finally {
    await app.close();
    _resetAioRuntime();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
