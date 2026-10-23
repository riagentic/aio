// The "identical twin" rule DELETES one layout of the stored document at boot
// (an interrupted persistMode migration left the same document in both). It
// is safe only while "identical" really means identical — two layouts that
// differ in ANY way (another value, one cell fewer, a nested field) are the
// never-guess case, and both must stay byte for byte where they are.
//
// Nothing pinned that side: `sameDocument` answering `true` for everything
// (deleting a layout that held different data) passed every test.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { createDB } from "../src/db/async-db.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { loadAndMigrateSnapshot } from "../src/server/aio-boot.ts";
import type { SkvInstance } from "../src/server/skv.ts";

type Log = Parameters<typeof loadAndMigrateSnapshot>[4];

/** Both layouts in one Map, exactly as the SQLite store keys them. */
function store(rows: Record<string, unknown>) {
  const m = new Map<string, string>(
    Object.entries(rows).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const ok = { ok: true as const, versionstamp: "" };
  const kv: SkvInstance = {
    set: (k, v) => (m.set(k, JSON.stringify(v)), Promise.resolve(ok)),
    get: <T>(k: string) =>
      Promise.resolve(m.has(k) ? JSON.parse(m.get(k)!) as T : null),
    del: (k) => (m.delete(k), Promise.resolve()),
    close: () => {},
    setMulti: (p, obj, prev = []) => {
      for (const [k, v] of Object.entries(obj)) {
        m.set(`${p}\x1f${k}`, JSON.stringify(v));
      }
      for (const k of prev) if (!(k in obj)) m.delete(`${p}\x1f${k}`);
      return Promise.resolve(ok);
    },
    getMulti: <T>(p: string) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of [...m].sort(([a], [b]) => a < b ? -1 : 1)) {
        if (k.startsWith(`${p}\x1f`)) {
          out[k.slice(p.length + 1)] = JSON.parse(v);
        }
      }
      return Promise.resolve(Object.keys(out).length ? out as T : null);
    },
  };
  return { kv, rows: () => Object.fromEntries(m) };
}

function logger() {
  const lines: string[] = [];
  const say = (m: unknown) => void lines.push(String(m));
  const log = {
    debug: say,
    info: say,
    warn: say,
    error: say,
  } as unknown as Log;
  return { log, lines };
}

const twinCases: [string, Record<string, unknown>, Record<string, unknown>][] =
  [
    ["another value", { box: { n: 1 } }, { box: { n: 2 } }],
    ["one cell fewer", { box: { n: 1 }, other: { k: 7 } }, { box: { n: 1 } }],
    ["a nested field", { box: { n: 1, tags: ["a"] } }, {
      box: { n: 1, tags: ["a", "b"] },
    }],
    ["array order", { box: { list: [1, 2] } }, { box: { list: [2, 1] } }],
    ["null vs missing", { box: { n: 1, x: null } }, { box: { n: 1 } }],
  ];

for (const mode of ["single", "multi"] as const) {
  for (const [what, single, multi] of twinCases) {
    Deno.test(`persist layouts (${mode}): two that differ by ${what} are BOTH kept`, async () => {
      const rows: Record<string, unknown> = { state: single };
      for (const [k, v] of Object.entries(multi)) rows[`state\x1f${k}`] = v;
      const s = store(rows);
      const before = s.rows();
      const { log, lines } = logger();
      const got = await loadAndMigrateSnapshot(s.kv, "app", "state", mode, log);
      assertEquals(got, mode === "single" ? single : multi);
      const { "app:__layout": layout, ...after } = s.rows();
      assertEquals(after, before, "nothing retired, nothing rewritten");
      assertEquals(
        layout,
        JSON.stringify(mode),
        "the copy it booted on is recorded, for a reader without the config",
      );
      assert(
        lines.some((l) => l.includes("BOTH layouts")),
        `the ambiguity is said:\n${lines.join("\n")}`,
      );
    });
  }

  Deno.test(`persist layouts (${mode}): the same document in both — key order aside — retires the other`, async () => {
    const doc = { box: { n: 1, deep: { b: 2, a: [1, { y: 1, x: 2 }] } } };
    const reordered = { box: { deep: { a: [1, { x: 2, y: 1 }], b: 2 }, n: 1 } };
    const s = store({ state: doc, "state\x1fbox": reordered.box });
    const { log, lines } = logger();
    await loadAndMigrateSnapshot(s.kv, "app", "state", mode, log);
    const left = Object.keys(s.rows());
    assertEquals(
      left,
      mode === "single" ? ["state"] : ["state\x1fbox"],
      lines.join("\n"),
    );
    assert(lines.some((l) => l.includes("finished an interrupted")));
  });
}

// A stored document is an object of cells. `42` (a hand-edited or foreign
// store) used to boot on defaults without a word — and the first save
// replaced it. Refused now, whichever layout holds it, and left on disk.
const notDocuments: [string, unknown][] = [
  ["a number", 42],
  ["a string", "x"],
  ["an array", [1, 2]],
  ["false", false],
];
for (const mode of ["single", "multi"] as const) {
  for (const [what, doc] of notDocuments) {
    Deno.test(`persist layouts (${mode}): a stored document that is ${what} is refused, not replaced`, async () => {
      const s = store({ state: doc });
      const before = s.rows();
      await assertRejects(
        () => loadAndMigrateSnapshot(s.kv, "app", "state", mode, logger().log),
        Error,
        "not an object of cells",
      );
      assertEquals(s.rows(), before);
    });
  }
}

Deno.test("boot: a stored document that is not an object refuses with the malformed-store advice, and stays on disk", async () => {
  const dir = await tempDir("persist-not-doc-");
  const db = join(dir, "state.db");
  try {
    const raw = createDB(db);
    await raw.execute(SKV_SCHEMA);
    await sqliteKv(raw).set("state", 42);
    await raw.close();
    _resetAioRuntime();
    const err = await assertRejects(() =>
      aio.run({
        cells: [cell("ctr", { state: { n: 0 }, methods: {} })],
        appId: "persist-not-doc",
        dbPath: db,
        port: freePort(),
        libraryMode: true,
        client: "server-only",
        baseDir: dir,
        // deno-lint-ignore no-explicit-any
      } as any)
    );
    const msg = String((err as Error).message);
    assert(msg.includes("not an object of cells"), msg);
    assert(msg.includes("persistence unavailable"), msg);
    assert(msg.includes("am restore"), msg);
    const back = createDB(db, { readonly: true });
    try {
      assertEquals(await sqliteKv(back).get("state"), 42);
    } finally {
      await back.close();
    }
  } finally {
    _resetAioRuntime();
    await dropTempDir(dir);
  }
});
