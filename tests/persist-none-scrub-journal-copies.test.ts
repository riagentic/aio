// A COPIED journal kept a `persist: "none"` call's arguments for good.
//
// A journal line written before `JournalEntry.unstored` (every 1.0.11 and
// older journal) records a `persist: "none"` cell's call with its arguments —
// for such a cell, its state: `{"type":"vault:setTok","payload":{"args":
// ["SECRET"]}}`. The live journal drops the line at its next compaction, but
// `am backup` copies `data/journal`, `am restore` moves the old one aside to
// `data.replaced-*`, and boot sets an unreplayable one aside as
// `journal.unreplayed-*` — and the copy scrub (aio-boot.ts
// `scrubStoreCopies`) looked at SQLite files only. Every such journal is now
// scrubbed with the store copies: once, with the same one-line log, rewritten
// over its own bytes; every other line is kept byte for byte.
import { assert, assertEquals } from "@std/assert";
import { createDB } from "../src/db/async-db.ts";
import { dirname, join } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** Every file under `dir` whose bytes hold `marker` — `only` narrows it
 *  (the store's own files by default; the whole-home scan passes a wider one). */
async function filesHolding(
  dir: string,
  marker: string,
  only: RegExp = /\.db(-wal|-shm)?$/,
): Promise<string[]> {
  const needle = new TextEncoder().encode(marker);
  const out: string[] = [];
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) await walk(p);
      else if (e.isFile && only.test(e.name)) {
        const b = await Deno.readFile(p);
        outer: for (let i = 0; i + needle.length <= b.length; i++) {
          for (let j = 0; j < needle.length; j++) {
            if (b[i + j] !== needle[j]) continue outer;
          }
          out.push(p);
          break;
        }
      }
    }
  };
  await walk(dir);
  return out;
}

/** Boot, run `body`, close — returning every console line the boot printed. */
async function boot(
  baseDir: string,
  appId: string,
  persistNone: boolean,
  body: (
    cells: { set: (v: string) => unknown; inc: () => unknown },
  ) => Promise<void> | void = () => {},
  extra: Record<string, unknown> = {},
): Promise<string> {
  const secret = cell("scrubJournalSecret", {
    state: { v: "" },
    ...(persistNone ? { persist: "none" as const } : {}),
    methods: {
      set(s: { v: string }, v: string) {
        s.v = v;
      },
    },
  });
  const kept = cell("scrubJournalKept", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  const lines: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn };
  const grab = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.log = console.info = console.warn = grab;
  try {
    const srv = await testServer({
      cells: [secret, kept],
      appId,
      baseDir,
      persist: true,
      ...extra,
    });
    try {
      await body({ set: (v) => secret.set(v), inc: () => kept.inc() });
    } finally {
      await srv.close();
    }
  } finally {
    Object.assign(console, orig);
  }
  return lines.join("\n");
}

Deno.test(`persist:"none": a copied journal's persist:"none" lines are scrubbed (backup, data.replaced-*, journal.unreplayed-*) once, said once — every other line kept`, async () => {
  const dir = await tempDir("aio-scrub-journal-");
  const appId = `scrub-journal-${crypto.randomUUID().slice(0, 8)}`;
  const MARK = `OLD-ARG-${crypto.randomUUID()}`;
  try {
    // 0. A store exists (the copy scrub runs on a boot that restores one).
    await boot(dir, appId, true, async (c) => {
      await c.inc();
    });
    const [live] = await filesHolding(dir, `"scrubJournalKept"`, /^state\.db$/);
    assert(live, "no live store — nothing below is a check");
    const data = dirname(live);
    const home = dirname(data);
    // 1. Journals an older build wrote, where each kind of copy keeps them.
    const S = "scrubJournalSecret";
    const K = "scrubJournalKept";
    const keptLine =
      `{"seq":1,"fmt":2,"type":"${K}:inc","payload":{"args":[]},"ts":1}`;
    const text = [
      keptLine,
      `{"seq":2,"fmt":2,"type":"${S}:set","payload":{"args":["${MARK}"]},"ts":2}`,
      `{"seq":3,"fmt":2,"type":"${S}:__setSetLater","payload":{"mutations":[{"path":["v"],"value":"${MARK}"}]},"origin":"${S}:setLater","ts":3}`,
      `{"seq":5,"type":"__aioBatch","fmt":2,"ts":5,"entries":[{"seq":4,"type":"${S}:set","payload":{"args":["${MARK}"]},"ts":4},{"seq":5,"type":"aio:__timeTravel","payload":{"cmd":"goto","cells":{"${S}":{"v":"${MARK}"},"${K}":{"n":1}}},"ts":5}]}`,
      `{"seq":6,"fmt":2,"type":"${S}:set","payload":{"args":["${MARK}`,
      "",
    ].join("\n");
    const planted = [
      join(home, "backups", `${appId}-backup-x`, "data", "journal"),
      join(home, "data.replaced-20260924-101010", "journal"),
      join(data, "journal.unreplayed-2026-09-24T10-10-10-000Z"),
    ];
    for (const p of planted) {
      await Deno.mkdir(dirname(p), { recursive: true });
      await Deno.writeTextFile(p, text);
    }
    assertEquals(
      (await filesHolding(home, MARK, /./)).sort(),
      [...planted].sort(),
      "every planted journal holds the argument — else the boot proves nothing",
    );

    // 2. This build: each one scrubbed, each said in the one line.
    const first = await boot(dir, appId, true);
    assertEquals(
      await filesHolding(home, MARK, /./),
      [],
      'a copied journal still holds a persist:"none" argument',
    );
    for (const p of planted) {
      assert(
        first.includes(`slice(s) ${S} from the copy ${p} too`),
        first,
      );
      const after = await Deno.readTextFile(p);
      const lines = after.split("\n");
      assertEquals(lines[0], keptLine, "a persisted cell's line was changed");
      const e2 = JSON.parse(lines[1]!);
      assertEquals([e2.seq, e2.payload, e2.unstored], [2, "[redacted]", true]);
      const batch = JSON.parse(lines[3]!);
      assertEquals(batch.entries[0].unstored, true);
      assertEquals(batch.entries[1].payload.cells, { [K]: { n: 1 } });
      assert(lines[4]!.startsWith(`{"seq":6`), "the torn line lost its seq");
      assert(after.length >= text.length, "old bytes left past the new end");
    }

    // 3. Once: a verified, unchanged copy is neither reopened nor re-said.
    const second = await boot(dir, appId, true);
    assert(!/from the copy/.test(second), second);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test(`persist:"none": a copied journal is scrubbed on a boot whose store holds NO snapshot yet (a crash before the first save, then a backup)`, async () => {
  const dir = await tempDir("aio-scrub-journal-nosnap-");
  const appId = `scrub-journal-nosnap-${crypto.randomUUID().slice(0, 8)}`;
  const MARK = `OLD-ARG-${crypto.randomUUID()}`;
  try {
    await boot(dir, appId, true, async (c) => {
      await c.inc();
    });
    const [live] = await filesHolding(dir, `"scrubJournalKept"`, /^state\.db$/);
    assert(live, "no live store — nothing below is a check");
    // The crash before the first save: the store holds no snapshot at all.
    const db = createDB(live);
    await db.execute("DELETE FROM aio_kv");
    await db.close();
    const home = dirname(dirname(live));
    const copy = join(home, "backups", `${appId}-backup-x`, "data", "journal");
    await Deno.mkdir(dirname(copy), { recursive: true });
    await Deno.writeTextFile(
      copy,
      `{"seq":1,"fmt":2,"type":"scrubJournalSecret:set","payload":{"args":["${MARK}"]},"ts":1}\n`,
    );
    const out = await boot(dir, appId, true);
    assertEquals(
      await filesHolding(home, MARK, /./),
      [],
      `the backup journal kept the argument for a whole boot:\n${out}`,
    );
    assert(out.includes(`from the copy ${copy} too`), out);
  } finally {
    await dropTempDir(dir);
  }
});
