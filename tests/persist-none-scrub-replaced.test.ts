// `am restore` moves the data it replaces aside to `<home>/data.replaced-<stamp>/`
// (am-cmd-data.ts — kept so "wrong archive" is recoverable). That folder is a
// whole copy of the store: `state.db`, its rolling `.snapshot`, the update's
// `backups/`. The `persist: "none"` copy scrub (aio-boot.ts
// `scrubStoreCopies`) looked only beside the live db and under the two
// `backups/` roots — so a secret an older build wrote stayed in the replaced
// folder forever, with not even the warning a `.corrupt-*` copy gets. It is
// now scrubbed like every other copy: once, with the same one-line log.
import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
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
  const secret = cell("scrubReplacedSecret", {
    state: { v: "" },
    ...(persistNone ? { persist: "none" as const } : {}),
    methods: {
      set(s: { v: string }, v: string) {
        s.v = v;
      },
    },
  });
  const kept = cell("scrubReplacedKept", {
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

Deno.test(`persist:"none": an am restore's data.replaced-* copy (and its nested backups) is scrubbed once, said once`, async () => {
  const dir = await tempDir("aio-scrub-replaced-");
  const appId = `scrub-replaced-${crypto.randomUUID().slice(0, 8)}`;
  const MARK = `OLD-SLICE-${crypto.randomUUID()}`;
  try {
    // 0. The OLDER build persisted the slice.
    await boot(dir, appId, false, async (c) => {
      await c.set(MARK);
      await c.inc();
    });
    const [live] = await filesHolding(dir, MARK, /^state\.db$/);
    assert(live, "the older build's slice never reached disk");
    const data = dirname(live);
    const home = dirname(data);
    // 1. `am restore`, as it leaves the disk: the current data moved aside
    //    whole (its snapshot and update backup with it), a restored copy in
    //    its place. The name is am's (`freeSibling(<data>.replaced-<stamp>)`).
    const aside = join(home, "data.replaced-20260924-101010");
    const aside2 = `${aside}-2`;
    const src = createDB(live);
    for (const d of [aside, aside2]) {
      await Deno.mkdir(join(d, "backups"), { recursive: true });
      await src.snapshot!(join(d, "state.db"));
    }
    await src.close();
    await Deno.copyFile(
      join(aside, "state.db"),
      join(aside, "state.db.snapshot"),
    );
    await Deno.copyFile(
      join(aside, "state.db"),
      join(aside, "backups", "pre-0.9.0-state.db"),
    );
    const copies = [
      join(aside, "state.db"),
      join(aside, "state.db.snapshot"),
      join(aside, "backups", "pre-0.9.0-state.db"),
      join(aside2, "state.db"),
    ];
    assertEquals(
      (await filesHolding(home, MARK, /./)).filter((p) => copies.includes(p))
        .sort(),
      [...copies].sort(),
      "every planted copy holds the slice — else the boot below proves nothing",
    );

    // 2. This build: persist:"none" — every replaced copy is scrubbed, each
    //    said in the one line every other copy gets.
    const first = await boot(dir, appId, true);
    assertEquals(
      await filesHolding(home, MARK, /./),
      [],
      'a data.replaced-* copy still holds the persist:"none" slice',
    );
    for (const p of copies) {
      assert(first.includes(`from the copy ${p} too`), first);
    }

    // 3. Once: a verified, unchanged copy is neither reopened nor re-said.
    const second = await boot(dir, appId, true);
    assert(!/from the copy/.test(second), second);
    assert(!/could not scrub/.test(second), second);
  } finally {
    await dropTempDir(dir);
  }
});
