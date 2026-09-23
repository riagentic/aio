// Crash recovery ACROSS builds (compat hunt round 3, area A).
//
//  - Upgrade: v1.0.9 journalled no `listensTo` reaction lines; its boot
//    re-derived a listener's reaction by folding each sync op through the
//    whole root. A newer boot over its crashed journal folds only each op's
//    own cell — so a KV listener of a sync cell came back at 0 (expected 10),
//    with nothing said. A tail with no format stamp now has its reactions
//    re-derived — only where no saved record can already hold them (v1.0.9's
//    own refold counted a saved one twice). Pinned against three data
//    directories v1.0.9 really wrote and crashed on (tests/fixtures/v1.0.9-*,
//    README in each).
//  - Downgrade: a reaction line carried a chain's first slice in `cells`,
//    which v1.0.9 applies as a jump AFTER re-deriving the reaction — a tally
//    of 10 reset to 1 and persisted. Reaction lines now leave `cells` empty
//    (the slice rides `keyframes`), so v1.0.9 applies nothing from them.
//  - A server write's call line, covered by the state line after it, was
//    reduced anyway: an idempotency guard threw and boot said the call
//    "COULD NOT be replayed" for a write it had restored.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  isLegacyTail,
  LEGACY_RECOVERED_TYPE,
  LISTENS_TO_CMD,
  LISTENS_TO_SYNC_OP_CMD,
  parseJournal,
  TT_RESTORE_TYPE,
} from "../src/server/journal.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const FIXTURE =
  new URL("./fixtures/v1.0.9-crashed-sync-listeners/", import.meta.url)
    .pathname;

async function run(dir: string, phase: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.js")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
      MOD,
      AIO_NO_OPEN: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase === "read" && !out.success) throw new Error(text);
  return text;
}
/** The fixture, file by file (two levels: the files and `data/`). */
async function copyFixture(
  to: string,
  from: string = FIXTURE,
): Promise<void> {
  for await (const e of Deno.readDir(from)) {
    if (e.isDirectory) {
      await Deno.mkdir(join(to, e.name), { recursive: true });
      for await (const f of Deno.readDir(join(from, e.name))) {
        await Deno.copyFile(
          join(from, e.name, f.name),
          join(to, e.name, f.name),
        );
      }
    } else await Deno.copyFile(join(from, e.name), join(to, e.name));
  }
}
const readJson = async (f: string) => JSON.parse(await Deno.readTextFile(f));

const STREAMING =
  new URL("./fixtures/v1.0.9-crashed-streaming/", import.meta.url).pathname;

// The store saved while the journal held no line: no app-wide watermark key.
const SYNC_ONLY_SAVE =
  new URL("./fixtures/v1.0.9-crashed-sync-only-save/", import.meta.url)
    .pathname;
const FIXTURES: [string, string][] = [
  ["before-fold", FIXTURE],
  ["streaming", STREAMING],
  ["sync-only-save", SYNC_ONLY_SAVE],
  // Server-side calls to sync cells journalled as plain call lines.
  [
    "server-writes",
    new URL("./fixtures/v1.0.9-crashed-server-writes/", import.meta.url)
      .pathname,
  ],
  // A clean stop: an EMPTY journal — the older build is known by the store's
  // missing stamp alone.
  [
    "clean-stop",
    new URL("./fixtures/v1.0.9-clean-stop/", import.meta.url).pathname,
  ],
];
/** `got` holds nothing `live` does not, as often as it does. Returns how
 *  many of `live`'s items it lacks. */
function shortfall(got: string[], live: string[], what: string): number {
  const left = new Map<string, number>();
  for (const x of live) left.set(x, (left.get(x) ?? 0) + 1);
  for (const x of got) {
    const n = left.get(x) ?? 0;
    assert(n > 0, `${what}: "${x}" recovered more often than written`);
    left.set(x, n - 1);
  }
  return [...left.values()].reduce((a, b) => a + b, 0);
}

for (const [name, fixture] of FIXTURES) {
  Deno.test(`journal upgrade (${name}): v1.0.9 data — nothing re-derived, nothing counted twice, every listener that may lack reactions named — twice`, async () => {
    const dir = await tempDir("aio-upgrade-compat-");
    try {
      await copyFixture(dir, fixture);
      const live = await readJson(join(fixture, "expected.json"));
      const old = await readJson(join(fixture, "v1.0.9-recovered.json"));
      // `AIO_REGEN_UPGRADE_FIXTURES=1` re-pins what this build recovers
      // (after a deliberate change — review the diff).
      if (Deno.env.get("AIO_REGEN_UPGRADE_FIXTURES") === "1") {
        await run(dir, "read");
        // Re-formatted by `deno fmt`, so a regen never trips the fmt gate.
        const pinned = join(fixture, "upgrade-recovered.json");
        await Deno.copyFile(join(dir, "recovered.json"), pinned);
        await new Deno.Command(Deno.execPath(), { args: ["fmt", "-q", pinned] })
          .output();
        await copyFixture(dir, fixture);
      }
      const want = await readJson(join(fixture, "upgrade-recovered.json"));
      // The pinned result is sound against the live state at the kill: never
      // above it (v1.0.9 put a tally of 24 back at 45), no item twice, every
      // cell's own writes back.
      for (const k of ["tally", "shaped"]) assert(want[k] <= live[k], k);
      for (const k of ["mirror", "feed"]) shortfall(want[k], live[k], k);
      // v1.0.9 recorded no op-log position for a server-side call, so those
      // come back after the ops (as v1.0.9 put them): the same items.
      const items = (xs: string[]) =>
        name === "server-writes" ? [...xs].sort() : xs;
      assertEquals(items(want.notes), items(live.notes));
      assertEquals(want.inbox, live.inbox);
      if (name !== "before-fold") {
        assert(old.tally > live.tally, "v1.0.9 doubled");
      }
      for (let boot = 1; boot <= 2; boot++) {
        const log = await run(dir, "read");
        assertEquals(
          await readJson(join(dir, "recovered.json")),
          want,
          `boot ${boot}\n${log}`,
        );
        // The old calls are recovered once: the second boot must not reduce
        // them again (an idempotency guard threw on every one of them).
        assert(!/COULD NOT be replayed/.test(log), `boot ${boot}\n${log}`);
        if (boot > 1) {
          // Stamped by the first: this data is this build's now, and what
          // it named is not named again.
          assert(!/older aio build|are in no record/.test(log), log);
          continue;
        }
        assert(/last run by an older aio build/.test(log), log);
        assert(/none is re-derived, so nothing is counted twice/.test(log));
        // Every listener short of live is NAMED, with the plain advice.
        const short = {
          tally: live.tally - want.tally,
          shaped: live.shaped - want.shaped,
          mirror: shortfall(want.mirror, live.mirror, "mirror"),
          feed: shortfall(want.feed, live.feed, "feed"),
        };
        for (const [k, n] of Object.entries(short)) {
          if (n === 0) continue;
          assert(
            new RegExp(
              `"${k}"'s listensTo reactions to [^\\n]*are in no record[^\\n]*` +
                `nothing is counted twice; 1\\.0\\.9 may have saved these ` +
                `reactions or lost them — check "${k}"`,
            ).test(log),
            `${k} short ${n}, unnamed\n${log}`,
          );
        }
      }
    } finally {
      await dropTempDir(dir);
    }
  });
}

for (const phase of ["before-fold", "after-fold"]) {
  Deno.test(`journal downgrade-safe: ${phase} — reaction lines give an older reader nothing to apply; this build recovers all, silently`, async () => {
    const dir = await tempDir("aio-downgrade-compat-");
    try {
      // No save before the kill (a slow machine's persist would compact the
      // reaction lines away before they can be looked at).
      await Deno.writeTextFile(
        join(dir, "app.js"),
        (await Deno.readTextFile(join(FIXTURE, "app.js"))).replace(
          "journal: true,",
          "journal: true, persistDebounceMs: 999999,",
        ),
      );
      const wlog = await run(dir, phase);
      const text = await Deno.readTextFile(join(dir, "data", "journal")).catch(
        () => {
          throw new Error(`the writer never reached its kill:\n${wlog}`);
        },
      );
      const reactions = parseJournal(text, { quiet: true }).filter((e) =>
        e.type === TT_RESTORE_TYPE &&
        [LISTENS_TO_CMD, LISTENS_TO_SYNC_OP_CMD].includes(
          (e.payload as { cmd?: string }).cmd ?? "",
        )
      );
      assert(reactions.length > 0, "the run journalled reactions");
      for (const e of reactions) {
        assertEquals(
          (e.payload as { cells: unknown }).cells,
          {},
          `seq ${e.seq}`,
        );
      }
      const expected = await readJson(join(dir, "expected.json"));
      const log = await run(dir, "read");
      assertEquals(await readJson(join(dir, "recovered.json")), expected, log);
      assert(!/COULD NOT be replayed|could not be replayed/i.test(log), log);
      assert(
        !/older aio build/.test(log),
        "this build's own tail is not legacy",
      );
    } finally {
      await dropTempDir(dir);
    }
  });
}

for (
  const [phase, added] of [["before-fold", 10], [
    "fold-lags-persist",
    0,
  ]] as const
) {
  Deno.test(`journal upgrade: a SECOND crash right after the upgrade (${phase}) loses neither build's writes`, async () => {
    // Boot the v1.0.9 crash with this build, write more, SIGKILL before any
    // save of this run: the tail then holds v1.0.9's lines AND this build's.
    const dir = await tempDir("aio-upgrade-second-crash-");
    try {
      await copyFixture(dir);
      // The same app; its counter starts past the fixture's ids (op ids are
      // deduplicated by the server, and `notes:add` refuses a duplicate).
      const src = await Deno.readTextFile(join(FIXTURE, "app.js"));
      assert(src.includes("let n = 0;"));
      await Deno.writeTextFile(
        join(dir, "app.js"),
        src.replace("let n = 0;", "let n = 100;")
          // No save of this run before the kill: the tail stays MIXED.
          .replace(
            "journal: true,",
            "journal: true, persistDebounceMs: 999999,",
          ),
      );
      const before = await readJson(join(FIXTURE, "upgrade-recovered.json"));
      const wlog = await run(dir, phase); // boots the crash, then writes
      const expected = await readJson(join(dir, "expected.json")).catch(() => {
        throw new Error(`the writer never reached its kill:\n${wlog}`);
      });
      assertEquals(
        expected.tally,
        before.tally + added,
        "live, before the kill",
      );
      const tail = parseJournal(
        await Deno.readTextFile(join(dir, "data", "journal")),
        { quiet: true },
      );
      assert(
        tail.some((e) => e.fmt === undefined) &&
          tail.some((e) => e.fmt !== undefined),
        `the tail is not mixed: ${
          JSON.stringify(tail.map((e) => [e.seq, e.fmt]))
        }`,
      );
      for (let boot = 1; boot <= 2; boot++) {
        const log = await run(dir, "read");
        assertEquals(
          await readJson(join(dir, "recovered.json")),
          expected,
          `boot ${boot}\n${log}`,
        );
        assert(!/COULD NOT be replayed/.test(log), `boot ${boot}\n${log}`);
      }
    } finally {
      await dropTempDir(dir);
    }
  });
}

Deno.test("journal upgrade: the boot over an old tail retires it in ONE line — a crash before it recovers again, one after it recovers nothing twice", async () => {
  const dir = await tempDir("aio-upgrade-marker-");
  try {
    await copyFixture(dir);
    const want = await readJson(join(FIXTURE, "upgrade-recovered.json"));
    await run(dir, "read");
    const path = join(dir, "data", "journal");
    const lines = (await Deno.readTextFile(path)).split("\n");
    const marker = lines.findIndex((l) => l.includes(LEGACY_RECOVERED_TYPE));
    assert(marker >= 0, "the legacy boot wrote its marker");
    // The commits of every op it placed, its state lines and the marker:
    // one line (journal.ts J1) — no crash can keep some of them.
    assert(lines[marker]!.includes('"type":"__aioSyncApplied"'));
    assert(
      lines[marker]!.includes('"type":"aio:__timeTravel"') ||
        lines[marker]!.includes('"type":"__aioSyncReaction"'),
    );
    assert(!isLegacyTail(parseJournal(lines.join("\n"), { quiet: true })));
    // The database as that boot left it — with its WAL, or a later run's WAL
    // would be read against the older main file (malformed).
    const dbFiles = ["state.db", "state.db-wal", "state.db-shm"];
    const saved = await Promise.all(
      dbFiles.map((f) => Deno.readFile(join(dir, "data", f)).catch(() => null)),
    );
    // A crash after that line, before the op-log's stamp: this build's data
    // all the same — recovered from its lines, nothing re-derived or named.
    unstamp(dir);
    const after = await run(dir, "read");
    assert(
      !/last run by an older aio build|in no record|cannot tell/.test(after),
      after,
    );
    assertEquals(await readJson(join(dir, "recovered.json")), want, after);
    // A crash before that line (it never landed, nor the stamp): the tail is
    // legacy again, and recovery runs again — to the same state.
    for (const [i, f] of dbFiles.entries()) {
      const bytes = saved[i];
      if (bytes) await Deno.writeFile(join(dir, "data", f), bytes);
      else await Deno.remove(join(dir, "data", f)).catch(() => {});
    }
    unstamp(dir);
    lines.splice(marker, 1);
    await Deno.writeTextFile(path, lines.join("\n"));
    const log = await run(dir, "read");
    assert(/last run by an older aio build/.test(log), log);
    assertEquals(await readJson(join(dir, "recovered.json")), want, log);
  } finally {
    await dropTempDir(dir);
  }
});

/** The op-log's stamp gone — a crash before `stampReactions`. */
function unstamp(dir: string): void {
  const d = new DatabaseSync(join(dir, "data", "state.db"));
  try {
    d.prepare("DELETE FROM sync_meta WHERE cell = ?").run(
      "__aio_reactions_fmt",
    );
  } finally {
    d.close();
  }
}

Deno.test("isLegacyTail: unstamped lines without the marker only", () => {
  const e = (seq: number, extra: Record<string, unknown> = {}) => ({
    seq,
    type: "c:a",
    ts: 0,
    ...extra,
  });
  assertEquals(isLegacyTail([]), false);
  assertEquals(isLegacyTail([e(1), e(2)]), true);
  assertEquals(isLegacyTail([e(1, { fmt: 2 })]), false);
  assertEquals(
    isLegacyTail([e(1), e(2, { fmt: 2 })]),
    true,
    "mixed, no marker",
  );
  assertEquals(
    isLegacyTail([
      e(1),
      e(2, { fmt: 2, type: LEGACY_RECOVERED_TYPE }),
      e(3, { fmt: 2 }),
    ]),
    false,
  );
  // A marker answers only for the lines BEFORE it: an older build that wrote
  // on after it (a downgrade) left a legacy tail again.
  assertEquals(
    isLegacyTail([
      e(1),
      e(2, { fmt: 2, type: LEGACY_RECOVERED_TYPE }),
      e(3),
    ]),
    true,
    "unstamped above the marker",
  );
});

Deno.test("journal upgrade: a journal.base's mtime proves nothing — a stale one (a base write that failed, or a kill before it) must not make a saved reaction apply again", async () => {
  const CLEAN_STOP =
    new URL("./fixtures/v1.0.9-clean-stop/", import.meta.url).pathname;
  const want = await readJson(join(CLEAN_STOP, "upgrade-recovered.json"));
  for (const mtime of [1_000, 4e12]) {
    const dir = await tempDir("aio-upgrade-base-mtime-");
    try {
      await copyFixture(dir, CLEAN_STOP);
      await Deno.utime(join(dir, "data", "journal.base"), mtime, mtime);
      const log = await run(dir, "read");
      const got = await readJson(join(dir, "recovered.json"));
      // Nothing re-derived, whatever the file times say: the same state,
      // and "tally" named.
      assertEquals(got, want, log);
      assert(
        /"tally"'s listensTo reactions to [^\n]*are in no record/.test(log),
      );
    } finally {
      await dropTempDir(dir);
    }
  }
});

Deno.test("journal upgrade: the store's stamp outlives the journal — once its stamped lines are compacted away, the next boot is not an upgrade again", async () => {
  const CLEAN_STOP =
    new URL("./fixtures/v1.0.9-clean-stop/", import.meta.url).pathname;
  const dir = await tempDir("aio-upgrade-stamp-");
  try {
    await copyFixture(dir, CLEAN_STOP);
    const first = await run(dir, "readstop");
    assert(/last run by an older aio build/.test(first), first);
    // Every line compacted (as it is once each cell's save holds it): no
    // stamped line is left to say whose data this is — only the store can.
    await Deno.writeTextFile(join(dir, "data", "journal"), "");
    const log = await run(dir, "read");
    assert(/sync: restored cell "notes"/.test(log), log);
    assert(!/this data was last run by an older aio build/.test(log), log);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal upgrade: placements that could not be written down are named again — the same state, nothing counted twice", async () => {
  const CLEAN_STOP =
    new URL("./fixtures/v1.0.9-clean-stop/", import.meta.url).pathname;
  const want = await readJson(join(CLEAN_STOP, "upgrade-recovered.json"));
  const dir = await tempDir("aio-upgrade-unsaved-");
  try {
    await copyFixture(dir, CLEAN_STOP);
    const journal = join(dir, "data", "journal");
    // Every append refused: the commits of the ops it placed never land.
    await Deno.chmod(journal, 0o400);
    const first = await run(dir, "read");
    assert(/last run by an older aio build/.test(first), first);
    assertEquals(await readJson(join(dir, "recovered.json")), want, first);
    await Deno.chmod(journal, 0o600);
    const log = await run(dir, "read");
    // Named again — as unplaceable now: the first boot stamped the op-log,
    // so these ops read as ones whose records were lost ("cannot tell").
    assert(
      /cannot tell whether "tally" holds its listensTo reactions to 10 "notes" ops/
        .test(log),
      log,
    );
    assertEquals(await readJson(join(dir, "recovered.json")), want, log);
    // …and written down this time: named no more.
    const third = await run(dir, "read");
    assert(!/are in no record|cannot tell/.test(third), third);
  } finally {
    await dropTempDir(dir);
  }
});
