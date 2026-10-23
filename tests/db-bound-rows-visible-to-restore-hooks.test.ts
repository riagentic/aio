// A cell's `onMigrate` / `onRestore` (and the app-level `onRestore`) ran
// BEFORE the `db:` table rows were loaded, so a hook reading a bound array saw
// its declared default — `[]` — on every boot. `onRestore: (s) => { s.total =
// sum(s.rows) }` restored `total: 0` over a table full of rows, in silence.
// The rows are now read before the hooks run, so a hook sees what the app sees
// after boot. What a hook WRITES to a bound array is still replaced by the
// table (SQLite owns those rows) — now said, instead of dropped quietly — and
// a hook mutating a row in place can no longer reach the diff baseline.
import { assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { aio, cell, integer, pk, table, text } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Row = { id: number; t: string; n: number };
type S = { rows: Row[]; total: number; seen: number; nid: number };

const rowsTable = () => table({ id: pk(), t: text(), n: integer() });

function make(version: number, hooks: boolean) {
  return cell("ledger", {
    version,
    state: { rows: [] as Row[], total: 0, seen: 0, nid: 1 } as S,
    ...(hooks
      ? {
        onMigrate: (s: S) => ({ ...s, seen: s.rows.length }),
        onRestore: (s: S) => {
          s.total = s.rows.reduce((a, r) => a + r.n, 0);
          // A write the table replaces: must not leak into state or baseline.
          for (const r of s.rows) r.n = 999;
        },
      }
      : {}),
    methods: {
      add(s: S, n: number) {
        s.rows.push({ id: s.nid++, t: "r" + n, n });
        s.total += n;
      },
      bump(s: S) {
        s.rows[0]!.n++;
        s.total++;
      },
    },
  });
}

async function boot(
  dir: string,
  c: ReturnType<typeof make>,
  appRestore: (s: unknown) => void,
  logs: string[],
) {
  return await aio.run({
    cells: [c],
    appId: "db-bound-rows-restore-hooks",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    dbPath: join(dir, "data.db"),
    baseDir: dir,
    persistDebounceMs: 10,
    db: { rows: rowsTable() },
    onRestore: appRestore,
  } as never);
}

/** Every console line `fn` prints. */
async function capture<T>(logs: string[], fn: () => Promise<T>): Promise<T> {
  const orig = { warn: console.warn, log: console.log, error: console.error };
  const push = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.warn = console.log = console.error = push;
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

Deno.test("db: restore hooks see the bound rows; their writes to them never leak", async () => {
  const dir = await tempDir("db-bound-rows-hooks-");
  try {
    const logs: string[] = [];
    const first = make(1, false);
    const a = await boot(dir, first, () => {}, logs);
    try {
      await first.add(2);
      await first.add(3);
      await first.add(4);
    } finally {
      await a.close();
    }

    const second = make(2, true);
    let appSaw = -1;
    const b = await capture(logs, () =>
      boot(dir, second, (s) => {
        appSaw = (s as { ledger: S }).ledger.rows.length;
      }, logs));
    try {
      const s = (b.getState() as unknown as { ledger: S }).ledger;
      assertEquals(s.seen, 3, "onMigrate read the stored rows");
      assertEquals(s.total, 9, "onRestore read the stored rows");
      assertEquals(appSaw, 3, "the app-level onRestore read them too");
      assertEquals(
        s.rows.map((r) => r.n),
        [2, 3, 4],
        "a hook's write to a bound row is replaced by the table",
      );
      assertEquals(
        logs.filter((m) => /onRestore.*rows.*replaced/s.test(m)).length,
        1,
        `the discarded write is said once: ${logs.join("\n")}`,
      );
      // The baseline is what SQLite holds: a change to row 1 is written.
      await second.bump();
    } finally {
      await b.close();
    }
    const db = new DatabaseSync(join(dir, "data.db"));
    try {
      assertEquals(
        db.prepare("SELECT n FROM rows ORDER BY id").all().map((r) =>
          Number(r.n)
        ),
        [3, 3, 4],
      );
    } finally {
      db.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("db: a bound array a CHECKPOINT restores is not blamed on a restore hook", async () => {
  const dir = await tempDir("db-bound-rows-cp-");
  const run = (c: ReturnType<typeof make>, restoreHook: boolean) =>
    aio.run({
      cells: [c],
      appId: "db-bound-rows-cp",
      appDir: dir,
      client: "server-only",
      libraryMode: true,
      port: freePort(),
      dbPath: join(dir, "data.db"),
      persistDebounceMs: 10,
      db: { rows: rowsTable() },
      diagnostics: { dev: { actionLog: false, checkpoint: { debounce: 0 } } },
      ...(restoreHook
        ? { onCheckpointRestore: (cp: { state: unknown }) => cp.state }
        : {}),
      watch: false,
    } as never);
  try {
    const first = make(1, false);
    const a = await run(first, false);
    try {
      await first.add(2);
    } finally {
      await a.close();
    }
    await Deno.writeTextFile(
      join(dir, "logs", "checkpoint.json"),
      JSON.stringify({
        ts: Date.now(),
        state: {
          ledger: {
            rows: [{ id: 1, t: "cp", n: 7 }],
            total: 7,
            seen: 0,
            nid: 2,
          },
        },
        recentActions: [],
        cells: {},
      }),
      { mode: 0o600 },
    );
    const second = cell("ledger", {
      version: 1,
      state: { rows: [] as Row[], total: 0, seen: 0, nid: 1 } as S,
      onRestore: (s: S) => {
        s.seen = 1; // a hook that never touches the rows
      },
      methods: {},
    }) as unknown as ReturnType<typeof make>;
    const logs: string[] = [];
    const b = await capture(logs, () => run(second, true));
    const s = (b.getState() as unknown as { ledger: S }).ledger;
    await b.close();
    assertEquals(s.total, 7, "control: the checkpoint was restored");
    assertEquals(
      logs.filter((m) => /hook changed state\.ledger\.rows/.test(m)),
      [],
      `a checkpoint's rows were blamed on a hook: ${logs.join("\n")}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});
