// `db.query()`'s "that statement WRITES" warning is about the APP's SQL, and
// it is not spent by the framework's.
//
// `looksLikeWrite` counted every PRAGMA as a write, so the schema reconcile's
// own `PRAGMA table_info(contacts)` — sent through `query()` — printed "db.query()
// was given a statement that WRITES" on every dev boot of a correct app. And
// the warning was one latch per handle, so that false one also used up the
// only one: the app's real `query("DELETE …")` a moment later said nothing.
//
// Three pins: the pragma shapes (a bare pragma and an introspection pragma
// read; `=`, a setting in parentheses and the side-effecting bare ones write),
// the boot-then-misuse sequence end to end, and a scan of src/ proving no
// framework `query()` call with literal SQL is a write — so none can take the
// app's warning, now or after the next edit.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { initSchema } from "../src/db/state-sync.ts";
import { looksLikeWrite, statementVerb } from "../src/db/sql-shape.ts";
import { integer, pk, table, text } from "../src/server/sql.ts";
import { log } from "../src/diagnostics/logger-api.ts";

Deno.test("sql-shape: a PRAGMA that only asks is a read; one that sets or acts is a write", () => {
  for (
    const sql of [
      "PRAGMA table_info(contacts)",
      "PRAGMA table_info('contacts')",
      "  pragma TABLE_XINFO ( [my table] ) ;",
      "PRAGMA main.index_list(t)",
      "PRAGMA foreign_key_check",
      "PRAGMA quick_check(10)",
      "PRAGMA journal_mode",
      "PRAGMA main.user_version;",
      "/* why */ PRAGMA synchronous -- trailing",
    ]
  ) assertEquals(looksLikeWrite(sql), false, sql);
  for (
    const sql of [
      "PRAGMA foreign_keys = ON",
      "PRAGMA main.user_version = 3",
      "PRAGMA user_version(5)", // the other spelling of `= 5`
      "PRAGMA journal_mode(WAL)",
      "PRAGMA optimize",
      "PRAGMA wal_checkpoint",
      "PRAGMA wal_checkpoint(TRUNCATE)",
      "PRAGMA incremental_vacuum",
      "PRAGMA shrink_memory",
      'PRAGMA "main".table_info(t)', // a shape it does not parse → write
      "PRAGMA table_info(t) junk",
      "PRAGMA",
    ]
  ) assertEquals(looksLikeWrite(sql), true, sql);
  assertEquals(statementVerb("/* c */ -- d\n delete from t"), "DELETE");
  assertEquals(statementVerb("  "), "");
});

Deno.test("db.query(): the framework's boot reads do not warn, and the app's own write through query() still does", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-query-pragma-" });
  const g = globalThis as Record<string, unknown>;
  const hadDev = g.__aioDev;
  const warnOrig = log.warn;
  const warns: string[] = [];
  g.__aioDev = true;
  log.warn = ((...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  }) as typeof log.warn;
  const db = createDB(join(dir, "state.db"));
  try {
    const schema = {
      rows: table({ id: pk(), text: text(), v: integer() }),
    };
    await initSchema(db, schema);
    await initSchema(db, schema); // a second boot, against the existing table
    const writes = () => warns.filter((w) => w.includes("WRITES"));
    assertEquals(writes(), [], "the reconcile's PRAGMA table_info is a read");
    await db.query("DELETE FROM rows WHERE id = -1");
    assertEquals(writes().length, 1, warns.join(" | "));
    assert(writes()[0]!.includes("DELETE FROM rows"), writes()[0]);
    // Once per kind: a second DELETE is quiet, an INSERT is its own warning.
    await db.query("DELETE FROM rows WHERE id = -2");
    await db.query("INSERT INTO rows (id, text, v) VALUES (1, 'a', 1)");
    assertEquals(writes().length, 2, warns.join(" | "));
  } finally {
    log.warn = warnOrig;
    g.__aioDev = hadDev;
    await db.close().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("src/: no framework db.query() call with literal SQL is a write", async () => {
  const root = new URL("../src/", import.meta.url);
  // `.query(` or `.query<…>(` then a string or template literal. Template
  // holes become a bare identifier, which is what they splice in.
  const CALL =
    /\.query\s*(?:<[^()]*?>)?\s*\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  const seen: string[] = [];
  const offenders: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) {
        await walk(new URL(`${e.name}/`, dir));
      } else if (/\.tsx?$/.test(e.name)) {
        const file = new URL(e.name, dir);
        const src = await Deno.readTextFile(file);
        for (const m of src.matchAll(CALL)) {
          const sql = m[1]!.slice(1, -1).replace(/\$\{[^}]*\}/g, "x");
          seen.push(sql);
          if (looksLikeWrite(sql)) {
            offenders.push(`${file.pathname.split("/src/")[1]}: ${sql}`);
          }
        }
      }
    }
  };
  await walk(root);
  // Not vacuous: the reconcile's pragma and the sync store's reads are found.
  assert(
    seen.some((s) => /PRAGMA table_info\(x\)/.test(s)),
    `the scan must reach state-sync's PRAGMA: ${seen.length} calls seen`,
  );
  assert(seen.length >= 15, `only ${seen.length} query() calls found`);
  assertEquals(offenders, []);
});
