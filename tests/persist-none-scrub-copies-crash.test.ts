// A crash BETWEEN the live-file scrub and the copies' scrub must not leave
// the copies holding a `persist: "none"` slice forever.
//
// `scrubStoreCopies` (aio-boot.ts) ran only on a boot whose LIVE store still
// held a stale slice. A process that died after the live scrub came back to a
// clean live file — and never looked at the rolling snapshot or the backups
// again: the secret the cell declared must never be kept stayed on disk in
// every copy, for good. Each copy is now checked on its own (once, recorded
// by its file signature, re-checked when it changes).
//
// The crash is reproduced without a seam: the copies are moved aside while
// this build scrubs the live file (what the crash leaves: live clean, no copy
// scrubbed), then put back.
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
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error, // "could not scrub" is an error line
  };
  const grab = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.log =
    console.info =
    console.warn =
    console.error =
      grab;
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

Deno.test(`persist:"none": a crash between the live scrub and the copies' scrub still scrubs the copies on the next boot — and a verified copy is not reopened`, async () => {
  const dir = await tempDir("aio-scrub-crash-");
  const appId = `scrub-crash-${crypto.randomUUID().slice(0, 8)}`;
  const MARK = `OLD-SLICE-${crypto.randomUUID()}`;
  const aside = await tempDir("aio-scrub-aside-");
  try {
    // 0. The OLDER build persisted the slice; copies taken under it.
    await boot(dir, appId, false, async (c) => {
      await c.set(MARK);
      await c.inc();
    });
    const [live] = await filesHolding(dir, MARK, /^state\.db$/);
    assert(live, "the older build's slice never reached disk");
    const data = dirname(live);
    const home = dirname(data);
    const snap = `${live}.snapshot`;
    const src = createDB(live);
    await src.snapshot!(snap);
    await src.close();
    const planted = {
      snap,
      updateBackup: join(data, "backups", "pre-0.9.0-state.db"),
      amBackup: join(home, "backups", `${appId}-backup-x`, "data", "state.db"),
      torn: `${snap}.tmp-abc-def`,
    };
    for (const p of Object.values(planted)) {
      if (p === snap) continue;
      await Deno.mkdir(dirname(p), { recursive: true });
      await Deno.copyFile(snap, p);
    }
    // The torn one is from long ago (a live writer's is seconds old).
    const old = new Date(Date.now() - 3 * 3600_000);
    await Deno.utime(planted.torn, old, old);
    const copies = Object.values(planted);

    // 1. The crash: this build scrubs the LIVE file while no copy is there
    //    to scrub — exactly the state a death right after the live scrub
    //    leaves. Then the copies are back, each still holding the slice.
    const moved = copies.map((p, i) => [p, join(aside, String(i))] as const);
    for (const [p, a] of moved) await Deno.rename(p, a);
    const crashed = await boot(dir, appId, true);
    assertEquals(crashed.match(LINE)?.length, 1, crashed);
    for (const [p, a] of moved) await Deno.rename(a, p);
    await Deno.utime(planted.torn, old, old);
    assertEquals(
      (await filesHolding(dir, MARK, /./)).filter((p) => copies.includes(p))
        .sort(),
      [...copies].sort(),
      "every copy holds the slice again — else the boot below proves nothing",
    );

    // 2. The next boot: the live file is clean (no stale line), and still
    //    every copy is scrubbed — the torn one deleted.
    const next = await boot(dir, appId, true);
    assertEquals(next.match(LINE), null, "the live file was already clean");
    const still = (await filesHolding(dir, MARK, /./)).filter((p) =>
      copies.includes(p)
    );
    assertEquals(still, [], 'a copy still holds the persist:"none" slice');
    for (const p of [planted.snap, planted.updateBackup, planted.amBackup]) {
      assert(next.includes(`from the copy ${p} too`), next);
    }

    // 3. Cheap: a verified, unchanged copy is not reopened. Unreadable now —
    //    so a reopen would fail and say "could not scrub". (The snapshot:
    //    found by name, so an unreadable one is still a candidate — a backup
    //    is found by reading its header, which would hide it.)
    await Deno.chmod(planted.snap, 0o000);
    try {
      const third = await boot(dir, appId, true);
      assert(!/could not scrub/.test(third), third);
      assert(!/from the copy/.test(third), third);
    } finally {
      await Deno.chmod(planted.snap, 0o644);
    }
  } finally {
    await dropTempDir(aside);
    await dropTempDir(dir);
  }
});
