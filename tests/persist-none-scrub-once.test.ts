// `persist: "none"` slices an OLDER build left in the store are scrubbed at
// boot (aio-boot.ts `scrubStaleSlices`: secure_delete, VACUUM, WAL truncate)
// — ONCE. The heavy proof is the hosts lane (tests/hosts.test.ts, a real
// binary per host); this is the light one, in-process, pinning what that lane
// does not: the first boot SAYS it (one log line) and takes the slice off the
// disk, and the second boot finds nothing and does nothing — no line, no
// second scrub with its VACUUM of the whole file.
import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const LINE = /persist: removed [^\n]*left by an older build/g;

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
  const secret = cell("scrubOnceSecret", {
    state: { v: "" },
    ...(persistNone ? { persist: "none" as const } : {}),
    methods: {
      set(s: { v: string }, v: string) {
        s.v = v;
      },
    },
  });
  const kept = cell("scrubOnceKept", {
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

Deno.test(`persist:"none": an older build's slice is scrubbed on the first boot, said once — the second boot says and scrubs nothing`, async () => {
  const dir = await tempDir("aio-scrub-once-");
  const appId = `scrub-once-${crypto.randomUUID().slice(0, 8)}`;
  const MARK = `OLD-SLICE-${crypto.randomUUID()}`;
  try {
    // 0. The OLDER build: the same cell, persisted. Asserted on disk, or
    //    everything after is vacuous.
    await boot(dir, appId, false, async (c) => {
      await c.set(MARK);
      await c.inc();
    });
    assert(
      (await filesHolding(dir, MARK)).length > 0,
      "the older build's slice never reached disk — nothing below is a check",
    );

    // 0b. Every COPY of the store aio keeps, taken under the older build:
    //     the rolling snapshot, an update's pre-migration backup, an
    //     `am backup`, a quarantined damaged store, and a snapshot a crash
    //     cut off. Each holds the slice, byte for byte.
    const [live] = await filesHolding(dir, MARK, /^state\.db$/);
    assert(live, "no state.db holds the slice");
    const data = dirname(live);
    const home = dirname(data);
    const src = createDB(live);
    const snap = `${live}.snapshot`;
    await src.snapshot!(snap);
    await src.close();
    const planted = {
      updateBackup: join(data, "backups", "pre-0.9.0-state.db"),
      amBackup: join(home, "backups", `${appId}-backup-x`, "data", "state.db"),
      quarantine: `${live}.corrupt-2026-01-01T00-00-00-000Z`,
      torn: `${snap}.tmp-abc-def`,
    };
    for (const p of Object.values(planted)) {
      await Deno.mkdir(dirname(p), { recursive: true });
      await Deno.copyFile(snap, p);
    }
    // Every file of the home, `logs/` included: the dev action log and the
    // checkpoint the older build wrote hold the slice too.
    const everyFile = () => filesHolding(dir, MARK, /./);
    const logs = join(home, "logs");
    assertEquals(
      (await everyFile()).filter((p) => p !== live).sort(),
      [
        snap,
        ...Object.values(planted),
        join(logs, "actions.jsonl"),
        join(logs, "checkpoint.json"),
      ].sort(),
      "every planted copy holds the slice — else the scan below proves nothing",
    );

    // 1. This build: scrubbed, said exactly once, gone from every file —
    //    every one, not only the store's: the quarantine alone is kept (the
    //    damaged original a recovery tool needs), and SAID.
    const first = await boot(dir, appId, true);
    assertEquals(first.match(LINE)?.length, 1, first);
    assert(/"none" cell\(s\) scrubOnceSecret /.test(first), first);
    assertEquals(
      await everyFile(),
      [planted.quarantine],
      "the slice is still on disk",
    );
    assert(
      first.includes(`${planted.quarantine} is a damaged copy of the store`),
      first,
    );
    for (const p of [snap, planted.updateBackup, planted.amBackup]) {
      assert(first.includes(`from the copy ${p} too`), first);
      // Scrubbed, not destroyed: the copy still opens and keeps the rest.
      const c = createDB(p, { readonly: true });
      try {
        const { rows } = await c.query<{ v: string }>(
          "SELECT v FROM aio_kv WHERE v LIKE '%scrubOnceKept%' OR k LIKE '%scrubOnceKept%'",
        );
        assert(rows.length > 0, `${p} lost the kept cell`);
      } finally {
        await c.close();
      }
    }
    await Deno.lstat(planted.torn).then(
      () => assert(false, "the torn snapshot is still there"),
      () => {},
    );

    assert(
      /withheld the payload of \d+ line\(s\) an older build wrote/.test(first),
      first,
    );

    // 2. Nothing left to scrub: no line, and no scrub (whose every run is
    //    that line — see `scrubStaleSlices`' caller).
    const second = await boot(dir, appId, true);
    assertEquals(second.match(LINE), null, second);
    assert(!/could not scrub/.test(second), second);

    // 3. And THIS build never writes one: a value the cell holds now reaches
    //    no file — not the store, not the action log, not the checkpoint.
    const NOW = `NEW-VALUE-${crypto.randomUUID()}`;
    await boot(dir, appId, true, async (c) => {
      await c.set(NOW);
      await c.inc();
    });
    // …at `logging.level: "debug"` too: debug.log keeps every action's
    // payload on disk, and a persist:"none" method's arguments ARE its state.
    const DEBUG = `DEBUG-VALUE-${crypto.randomUUID()}`;
    await boot(dir, appId, true, async (c) => {
      await c.set(DEBUG);
      await c.inc();
    }, { logging: { level: "debug" } });
    assert(
      (await filesHolding(dir, "cell:scruboncesecret", /^debug\.log/)).length >
        0,
      "debug.log never recorded the call — the check below would be vacuous",
    );
    assertEquals(
      await filesHolding(dir, DEBUG, /./),
      [],
      'a persist:"none" method\'s argument reached a file at debug level',
    );
    assertEquals(
      await filesHolding(dir, NOW, /./),
      [],
      'a persist:"none" value reached a file',
    );
  } finally {
    await dropTempDir(dir);
  }
});
