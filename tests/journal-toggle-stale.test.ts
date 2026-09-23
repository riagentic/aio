// Turning the journal OFF over a journal a crash left, then back ON.
//
// Measured (round-6 re-verify): journal on + SIGKILL left three server writes
// to sync cell `s` in the journal; a run with the journal off then took ten
// client ops and a server write whose fold compacted `s`, and stopped
// cleanly; the next boot with the journal on replayed the first run's STATE
// line for `s` as the newest state — every item of the second run gone, for
// good, with no warning. Two rules now (server/aio-boot.ts):
//   - a journal-off boot moves an unreplayed journal aside, loudly
//     (`retireUnreplayedJournal`), so no later run replays it over newer data;
//   - a sync state line older than the cell's saved snapshot is never applied
//     (`seedSyncReactions`) — the route a build that leaves the journal where
//     it is (1.0.9 with the journal off) still opens.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = new URL("./fixtures/journal-toggle/app.js", import.meta.url)
  .pathname;
const TREE = new URL("..", import.meta.url).pathname;

type Snap = { s: string[]; k: number; tally: number };

async function run(
  dir: string,
  phase: string,
  env: Record<string, string>,
  tree = TREE,
): Promise<{ log: string; boot?: Snap; live?: Snap }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(tree, "deno.json"), APP],
    env: {
      ...env,
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      PHASE: phase,
      MOD: new URL(`file://${join(tree, "mod.ts")}`).href,
      AIO_NO_OPEN: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const log = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  const pick = (tag: string): Snap | undefined => {
    const m = new RegExp(`^${tag} (.*)$`, "m").exec(log);
    return m ? JSON.parse(m[1]!) : undefined;
  };
  return { log, boot: pick("BOOT"), live: pick("LIVE") };
}

const first = { J: "1", W: "3", TAG: "a", STOP: "kill" };
const offRun = {
  J: "0",
  W: "2",
  N: "10",
  LATE: "1",
  TAG: "b",
  SETTLE: "700",
  STOP: "close",
};

Deno.test("journal on → killed → journal OFF, clean → journal on: the off run's data is kept — sync and store cells", async () => {
  const dir = await tempDir("aio-journal-toggle-");
  try {
    const r1 = await run(dir, "w", first);
    assertEquals(r1.live, { s: ["aw0", "aw1", "aw2"], k: 3, tally: 3 }, r1.log);
    const r2 = await run(dir, "w", offRun);
    // The off run does not replay the journal: it says so, by path, and
    // moves it aside.
    assert(
      /journal: this run has the journal off, but \S+journal held \d+ records/
        .test(r2.log),
      r2.log,
    );
    const aside = [...Deno.readDirSync(join(dir, "data"))]
      .filter((e) => e.name.startsWith("journal.unreplayed-"));
    assert(aside.length >= 1, "the journal is kept aside, for a person");
    assertEquals(r2.live!.s.length, 13, r2.log);
    const r3 = await run(dir, "read", { J: "1" });
    // Nothing of the off run rolled back: sync cell and store cell alike.
    assertEquals(r3.boot, r2.live, r3.log);
    // …and the next off run finds nothing to move.
    const r4 = await run(dir, "read", { J: "0" });
    assert(!/the journal off, but/.test(r4.log), r4.log);
    assertEquals(r4.boot, r2.live, r4.log);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a sync cell's journalled state older than its saved snapshot is never applied — nor its actions", async () => {
  const dir = await tempDir("aio-journal-stale-line-");
  try {
    await run(dir, "w", first);
    // A build that leaves the journal where it is (1.0.9 with the journal
    // off): it is simply not there for the off run.
    const data = join(dir, "data");
    await Deno.rename(join(data, "journal"), join(data, "hidden"));
    await Deno.rename(join(data, "journal.base"), join(data, "hidden.base"))
      .catch(() => {});
    const r2 = await run(dir, "w", offRun);
    await Deno.rename(join(data, "hidden"), join(data, "journal"));
    await Deno.rename(join(data, "hidden.base"), join(data, "journal.base"))
      .catch(() => {});
    const r3 = await run(dir, "read", { J: "1" });
    assert(
      /journal: "s"'s journalled state \(seq \d+\) is older than its saved snapshot, which a run without the journal wrote/
        .test(r3.log),
      r3.log,
    );
    // The snapshot is kept whole, and the old writes are not re-added.
    assertEquals(r3.boot!.s, r2.live!.s, r3.log);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a clean stop vouches for its run's LAST op too — the one at the very end of its range", async () => {
  // Client ops only, and a store-persisted listener only: no fold takes a
  // value after the last op, so it sits exactly at the recorded end.
  const dir = await tempDir("aio-journal-clean-edge-");
  try {
    const r1 = await run(dir, "w", { J: "0", N: "3", STOP: "close" });
    assertEquals(r1.live!.tally, 3, r1.log);
    const r2 = await run(dir, "read", { J: "1" });
    assert(!/cannot tell/.test(r2.log), r2.log);
    assertEquals(r2.boot, r1.live, r2.log);
  } finally {
    await dropTempDir(dir);
  }
});

async function exportTag(tag: string): Promise<string> {
  const dir = await tempDir("aio-old-tree-");
  const tar = join(dir, "tree.tar");
  const a = await new Deno.Command("git", {
    args: ["-C", TREE, "archive", "--format=tar", "-o", tar, tag],
    stderr: "piped",
  }).output();
  assert(
    a.success,
    `git archive ${tag}: ${new TextDecoder().decode(a.stderr)}`,
  );
  const x = await new Deno.Command("tar", {
    args: ["-xf", tar, "-C", dir],
    stderr: "piped",
  }).output();
  assert(x.success, new TextDecoder().decode(x.stderr));
  return dir;
}

Deno.test("this build (journal on) killed → REAL v1.0.9 with the journal off saves newer data → this build: the stale journal is moved aside, never replayed over it", async () => {
  // 1.0.9 ignores this build's journal and saves the store past it; its
  // writes fire this build's store triggers (store-gen.ts) — plain SQL, which
  // 1.0.9 runs without knowing. Replaying the tail then applied the killed
  // run's calls a second time on top (k: 5 + 3 = 8), or rolled a `set` back.
  const given = Deno.env.get("AIO_V109_TREE");
  const old = given ?? await exportTag("v1.0.9-beta");
  try {
    const modes: Record<string, string>[] = [{}, { MULTI: "1" }];
    for (const mode of modes) {
      const dir = await tempDir("aio-journal-foreign-save-");
      try {
        const r1 = await run(dir, "w", { ...first, ...mode });
        assertEquals(r1.live!.k, 3, r1.log);
        const r2 = await run(dir, "w", { ...offRun, ...mode }, old);
        assert(r2.live, `1.0.9 boots and runs over the triggers\n${r2.log}`);
        const r3 = await run(dir, "read", { J: "1", ...mode });
        assert(
          /journal: the store was written outside aio.s journalled saves/
            .test(r3.log),
          r3.log,
        );
        assertEquals(r3.boot!.s, r2.live!.s, r3.log);
        assertEquals(r3.boot!.k, r2.live!.k, `not replayed late\n${r3.log}`);
        // …once: the next boot finds nothing to say.
        const r4 = await run(dir, "read", { J: "1", ...mode });
        assert(!/written outside aio.s journalled saves/.test(r4.log), r4.log);
        assertEquals(r4.boot, r3.boot, r4.log);
      } finally {
        await dropTempDir(dir);
      }
    }
  } finally {
    if (!given) await dropTempDir(old);
  }
});

Deno.test("an app's own INSERT into a SQL-only db: table is not a foreign save — a kill after it replays the journal, and says nothing", async () => {
  // The bulk pattern (docs/persistence/big-data.md): `app.db.execute` into a
  // table no state mirrors. Watching it (store-gen.ts) read that insert as
  // someone else's save, and the next boot moved the whole journal aside.
  const app = new URL("./fixtures/sql-only-table/app.js", import.meta.url)
    .pathname;
  const dir = await tempDir("aio-sql-only-table-");
  const go = async (phase: string) => {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(TREE, "deno.json"), app],
      env: {
        DIR: dir,
        PORT: String(freePort()),
        AIO_APPS_DIR: dir,
        XDG_RUNTIME_DIR: dir,
        PHASE: phase,
        MOD: new URL(`file://${join(TREE, "mod.ts")}`).href,
        AIO_NO_OPEN: "1",
        PDM: "1500",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
  };
  try {
    const live = await go("w");
    assert(/LIVE \{"n":3,"rows":1\}/.test(live), live);
    const log = await go("read");
    assert(/SNAP \{"n":3,"rows":1\}/.test(log), `bumps replayed\n${log}`);
    assert(!/journalled saves|unreplayed/.test(log), log);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a boot's own store writes never read as a foreign save — even when that boot dies right after them", async () => {
  // Switching the persist layout adopts the stored state into the new one: a
  // write to store rows by this build's boot. It is recorded as this build's
  // at once (aio-boot.ts), so a boot killed before its first save leaves no
  // foreign-save flag behind.
  const dir = await tempDir("aio-boot-writes-then-dies-");
  try {
    const r1 = await run(dir, "w", { J: "1", W: "2", STOP: "close" });
    assertEquals(r1.live!.k, 2, r1.log);
    // The layout switch; killed once the boot is past its store writes (the
    // restore line comes after them), before anything saves.
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(TREE, "deno.json"), APP],
      env: {
        DIR: dir,
        PORT: String(freePort()),
        AIO_APPS_DIR: dir,
        XDG_RUNTIME_DIR: dir,
        PHASE: "read",
        MOD: new URL(`file://${join(TREE, "mod.ts")}`).href,
        AIO_NO_OPEN: "1",
        MULTI: "1",
        STOP: "hold",
      },
      stdout: "piped",
      stderr: "null",
    }).spawn();
    let log = "";
    const dec = new TextDecoder();
    for await (const chunk of child.stdout) {
      log += dec.decode(chunk);
      if (/sync: restored cell/.test(log)) {
        child.kill("SIGKILL");
        break;
      }
    }
    await child.status;
    assert(/migrated the stored document single → multi/.test(log), log);
    const d = new DatabaseSync(join(dir, "data", "state.db"));
    try {
      const { dirty } = d.prepare(
        "SELECT dirty FROM aio_store_gen WHERE id = 1",
      ).get() as { dirty: number };
      assertEquals(dirty, 0, log);
    } finally {
      d.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});
