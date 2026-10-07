// A rolled-back DIRECTORY install leaves `installed.json` naming the version
// that runs.
//
// The record follows the artifact: `am installed` reports it, and `am upgrade`
// decides what to rebuild — and what to prune — from it. The flat and the
// versioned layouts reconcile it when a failed update is put back; the
// directory layout (a Windows install, which cannot move the folder it runs
// from and hands the move to the swap helper) returned before that line, so
// the record kept naming the build that had just failed to come up.
//
// And the other way round: the record is written BEFORE the helper moves
// anything, so when the helper fails and starts the failed build again, that
// boot has to put the record back — or it names a version that is not running.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  failedUpdatePath,
  firstBootPath,
  MAX_BOOT_ATTEMPTS,
  type PendingUpdate,
  readPending,
  writePending,
  writeRecordAtomic,
} from "../src/server/updates-apply.ts";
import {
  judgePendingUpdate,
  pendingConfirmer,
  startUpdates,
} from "../src/server/updates-boot.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import {
  getLogger,
  type Log,
  setLogger,
} from "../src/diagnostics/logger-api.ts";
import { _recordDeps } from "../src/server/install-record.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const quiet = {
  info() {},
  debug() {},
  warn() {},
  error() {},
} as unknown as Log;

Deno.test("rollback: a directory install's installed.json names the version put back", async () => {
  const dir = await tempDir("aio-rollback-dir-record-");
  const data = await tempDir("aio-rollback-dir-record-data-");
  try {
    const current = join(dir, "notes");
    const previous = `${current}.old-1.0.0`;
    await Deno.mkdir(current);
    await Deno.mkdir(previous);
    // What `am upgrade` (or the installer) recorded for the build that then
    // failed to come up.
    await Deno.writeTextFile(
      join(dir, "installed.json"),
      JSON.stringify({ name: "notes", version: "2.0.0", artifact: "notes" }),
    );
    writePending(data, {
      from: "1.0.0",
      to: "2.0.0",
      artifact: current,
      previous,
      attempts: MAX_BOOT_ATTEMPTS,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const moves: string[] = [];
    const stop = await judgePendingUpdate(data, quiet, "2.0.0", {
      os: "windows",
      swapDirectory: (o) => (moves.push(o.staged), { previous: "" }),
      exe: "1:200:5000:1700000099000",
    });
    assertEquals(stop, true, "the failed build exits for the helper");
    assertEquals(moves, [previous], "the helper was handed the old version");
    const rec = JSON.parse(
      await Deno.readTextFile(join(dir, "installed.json")),
    );
    assertEquals(
      [rec.name, rec.version, rec.artifact],
      ["notes", "1.0.0", "notes"],
      "installed.json still names the version that was rolled back from",
    );
    assertEquals(readPending(data), null);
  } finally {
    await dropTempDir(dir);
    await dropTempDir(data);
  }
});

Deno.test("rollback: a helper that cannot start changes NOTHING on the record", async () => {
  const dir = await tempDir("aio-rollback-dir-record-");
  const data = await tempDir("aio-rollback-dir-record-data-");
  try {
    const current = join(dir, "notes");
    await Deno.mkdir(current);
    await Deno.mkdir(`${current}.old-1.0.0`);
    await Deno.writeTextFile(
      join(dir, "installed.json"),
      JSON.stringify({ name: "notes", version: "2.0.0", artifact: "notes" }),
    );
    writePending(data, {
      from: "1.0.0",
      to: "2.0.0",
      artifact: current,
      previous: `${current}.old-1.0.0`,
      attempts: MAX_BOOT_ATTEMPTS,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const stop = await judgePendingUpdate(data, quiet, "2.0.0", {
      os: "windows",
      swapDirectory: () => {
        throw new Error("blocked by policy");
      },
      exe: "1:200:5000:1700000099000",
    });
    assertEquals(stop, false, "nothing was put back: this build boots on");
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, "installed.json"))).version,
      "2.0.0",
      "the failed build is still the one installed, and the record says so",
    );
  } finally {
    await dropTempDir(dir);
    await dropTempDir(data);
  }
});

/** `installed.json`'s version once it reads `want` — the write that puts it
 *  back is not awaited by the boot. */
async function recordedVersion(dir: string, want: string): Promise<string> {
  const read = async () =>
    JSON.parse(await Deno.readTextFile(join(dir, "installed.json"))).version;
  const deadline = Date.now() + 5000;
  while (await read() !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return await read();
}

/** The lines about the record once `n` of them are there — the line is said
 *  when the write has answered, which the boot does not wait for. */
async function recordLines(said: string[], n: number): Promise<string[]> {
  const lines = () => said.filter((m) => m.includes("installed.json"));
  const deadline = Date.now() + 5000;
  while (lines().length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return lines();
}

/** A directory install whose update failed and was handed to the helper by a
 *  build whose executable is `exe`. `artifact: false` is a marker staged by a
 *  build that did not record which path it replaced. */
async function handedToHelper(
  dir: string,
  data: string,
  exe: string,
  { artifact = true, more = {} as Partial<PendingUpdate> } = {},
): Promise<void> {
  const current = join(dir, "notes");
  await Deno.mkdir(current);
  await Deno.mkdir(`${current}.old-1.0.0`);
  await Deno.writeTextFile(
    join(dir, "installed.json"),
    JSON.stringify({ name: "notes", version: "2.0.0", artifact: "notes" }),
  );
  writePending(data, {
    from: "1.0.0",
    to: "2.0.0",
    ...(artifact ? { artifact: current } : {}),
    previous: `${current}.old-1.0.0`,
    attempts: MAX_BOOT_ATTEMPTS,
    startedAt: "2026-08-08T00:00:00.000Z",
    ...more,
  });
  await judgePendingUpdate(data, quiet, "2.0.0", {
    os: "windows",
    swapDirectory: () => ({ previous: "" }),
    exe,
  });
  assertEquals(await recordedVersion(dir, "1.0.0"), "1.0.0");
}

/** {@link handedToHelper}, then the next boot, running `bootExe`. */
async function bootAfterHelper(
  dir: string,
  data: string,
  exe: string,
  bootExe: string,
  version: string,
): Promise<string[]> {
  await handedToHelper(dir, data, exe);
  return boot(data, bootExe, join(dir, "notes"), version);
}

/** One boot of the build whose executable is `exe`, reporting `version` and
 *  running from the install directory `here`: what it said as errors. */
function boot(
  data: string,
  exe: string,
  here: string | null,
  version = "2.0.0",
  warned: string[] = [],
): string[] {
  const errors: string[] = [];
  const slot = {
    runtime: null,
    cell: { status: "idle", error: null, ready: () => {} },
  } as unknown as UpdatesSlot;
  startUpdates({
    updates: { source: "https://example.invalid/rel", check: 1000 },
    dataDir: data,
    appName: "notes",
    appVersion: version,
    local: { schema: 1, cells: {} },
    exposed: false,
    log: {
      ...quiet,
      error: (_c: string, m: string) => errors.push(m),
      warn: (_c: string, m: string) => warned.push(m),
    } as unknown as Log,
    argv: [],
    slot,
    exe,
    installDir: here,
  }).stop();
  return errors;
}

Deno.test("rollback: the helper moved NOTHING and the failed build is running again — installed.json names it again", async () => {
  const dir = await tempDir("aio-rollback-dir-record-");
  const data = await tempDir("aio-rollback-dir-record-data-");
  try {
    const exe = "1:200:5000:1700000099000";
    const errors = await bootAfterHelper(dir, data, exe, exe, "2.0.0");
    assertEquals(
      errors.filter((m) => m.includes("ROLLBACK FAILED")).length,
      1,
      errors.join("\n"),
    );
    assertEquals(
      await recordedVersion(dir, "2.0.0"),
      "2.0.0",
      "the build that runs is 2.0.0 — the record must not say 1.0.0",
    );
  } finally {
    await dropTempDir(dir);
    await dropTempDir(data);
  }
});

Deno.test("rollback: the helper DID put the old version back — its boot leaves the record alone", async () => {
  const dir = await tempDir("aio-rollback-dir-record-");
  const data = await tempDir("aio-rollback-dir-record-data-");
  try {
    const errors = await bootAfterHelper(
      dir,
      data,
      "1:200:5000:1700000099000",
      "1:100:4000:1600000000000",
      "1.0.0",
    );
    assertEquals(errors.some((m) => m.includes("was rolled back")), true);
    // Nothing is in flight to wait for: give a wrong write the time to land.
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(await recordedVersion(dir, "1.0.0"), "1.0.0");
  } finally {
    await dropTempDir(dir);
    await dropTempDir(data);
  }
});

// The judge derives the install's path when the marker does not carry it, and
// keeps it on the failed record: the boot that says the rollback failed names
// the path to put the old version back at.
Deno.test("rollback: a marker that never recorded its path — the failed build's boot still names it, and puts the record back", async () => {
  const dir = await tempDir("aio-rollback-dir-record-");
  const data = await tempDir("aio-rollback-dir-record-data-");
  try {
    const exe = "1:200:5000:1700000099000";
    await handedToHelper(dir, data, exe, { artifact: false });
    const errors = boot(data, exe, join(dir, "notes"));
    assertEquals(await recordedVersion(dir, "2.0.0"), "2.0.0");
    assertEquals(errors.length, 1);
    assertStringIncludes(
      errors[0]!,
      `back at ${join(dir, "notes")} by hand`,
    );
  } finally {
    await dropTempDir(dir);
    await dropTempDir(data);
  }
});

// The put-back is one best-effort write. When it fails, the next boot of the
// same build makes it again — not only the boot that first learned the
// rollback had failed.
Deno.test({
  name:
    "rollback: a put-back that could not be written is made again on the next boot",
  async fn() {
    const dir = await tempDir("aio-rollback-dir-record-");
    const data = await tempDir("aio-rollback-dir-record-data-");
    try {
      const exe = "1:200:5000:1700000099000";
      const record = join(dir, "installed.json");
      await handedToHelper(dir, data, exe);
      const here = join(dir, "notes");
      // The record is replaced whole, through a temp beside it — so a record
      // that cannot be written is one whose temp cannot be made: a folder
      // (not empty, so nothing clears it) has its name. On every OS, and for
      // root, which a read-only file never stopped.
      const nonce = _recordDeps.nonce;
      _recordDeps.nonce = () => "blocked";
      const blocked = `${record}.tmp-${Deno.pid}-blocked`;
      await Deno.mkdir(join(blocked, "x"), { recursive: true });
      // The writer's own line (path and reason) goes to the process's log.
      const prev = getLogger();
      const writer: string[] = [];
      setLogger(
        {
          ...(prev ?? {}),
          pub: (lvl: string, _cat: string, msg: string) => {
            if (lvl === "warn") writer.push(msg);
          },
        } as unknown as Parameters<typeof setLogger>[0],
      );
      const first: string[] = [];
      try {
        boot(data, exe, here, "2.0.0", first);
        for (const end = Date.now() + 10_000; writer.length === 0;) {
          if (Date.now() > end) throw new Error("no failed write within 10 s");
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        setLogger(prev);
        _recordDeps.nonce = nonce;
      }
      assertStringIncludes(writer.join("\n"), `could not update ${record}`);
      assertEquals(await recordedVersion(dir, "1.0.0"), "1.0.0");
      // Nothing was corrected, so nothing says it was: the writer's own line
      // is the one warning of that boot.
      assertEquals(await recordLines(first, 0), []);
      await Deno.remove(blocked, { recursive: true });
      const second: string[] = [];
      const errors = boot(data, exe, here, "2.0.0", second);
      assertEquals(await recordedVersion(dir, "2.0.0"), "2.0.0");
      assertEquals((await recordLines(second, 1)).length, 1);
      assertEquals(
        errors.filter((m) => m.includes("ROLLBACK FAILED")).length,
        1,
        errors.join("\n"),
      );
    } finally {
      await dropTempDir(dir);
      await dropTempDir(data);
    }
  },
});

// ── the record names the build that runs ─────────────────────────────────────
//
// A directory install's moves are made by a helper after the process that
// decided them is gone, or by hand. Every boot of the install the record was
// written for puts the running version on it — unless the updater is still
// deciding which build stays (a pending marker, a first-boot token), when the
// record is the updater's to write.

const FAILED_EXE = "1:200:5000:1700000099000";
const OLD_EXE = "1:100:4000:1600000000000";

/** A record of update 1.0.0 → 2.0.0 of the install at `current`. */
const marker = (current: string, more: Partial<PendingUpdate> = {}) => ({
  from: "1.0.0",
  to: "2.0.0",
  artifact: current,
  previous: `${current}.old-1.0.0`,
  attempts: MAX_BOOT_ATTEMPTS,
  startedAt: "2026-08-08T00:00:00.000Z",
  ...more,
});

type RecordCase = {
  name: string;
  /** What `installed.json` holds before the boot (null: there is none). */
  record: Record<string, unknown> | string | null;
  /** The version of the build that boots, and its executable. */
  runs: string;
  exe?: string;
  /** Where it runs from, under the install's parent (null: not a directory
   *  install). */
  here?: string | null;
  pending?: Partial<PendingUpdate>;
  firstBoot?: boolean;
  failed?: Partial<PendingUpdate>;
  /** The version the record names afterwards (undefined: untouched). */
  becomes?: string;
  /** Part of the one error line this boot says about the failed update. */
  says?: string;
};

const notes = (version: string) => ({
  name: "notes",
  version,
  artifact: "notes",
});

const RECORD_CASES: RecordCase[] = [
  {
    name: "a record an older build left behind after its update",
    record: notes("1.0.0"),
    runs: "2.0.0",
    becomes: "2.0.0",
  },
  {
    name: "the record already names what runs",
    record: notes("2.0.0"),
    runs: "2.0.0",
  },
  {
    name: "an update applied and not yet confirmed (pending marker)",
    record: notes("1.0.0"),
    runs: "2.0.0",
    pending: { attempts: 1 },
  },
  {
    name: "a rollback that failed and is retried by the judge (pending marker)",
    record: notes("2.0.0"),
    runs: "1.0.0",
    pending: { rollbackFailed: "the file was busy" },
  },
  {
    name: "the helper is still watching for the first boot (token)",
    record: notes("1.0.0"),
    runs: "2.0.0",
    firstBoot: true,
  },
  {
    name: "rolled back by the helper: the old build runs, the record says so",
    record: notes("1.0.0"),
    runs: "1.0.0",
    exe: OLD_EXE,
    failed: { failedExe: FAILED_EXE },
    says: "was rolled back: it failed to come up",
  },
  {
    name: "the helper's rollback failed: the failed build runs again",
    record: notes("1.0.0"),
    runs: "2.0.0",
    exe: FAILED_EXE,
    failed: { failedExe: FAILED_EXE },
    becomes: "2.0.0",
    says: "ROLLBACK FAILED",
  },
  {
    name: "…and the old build was then put back by hand",
    record: notes("2.0.0"),
    runs: "1.0.0",
    exe: OLD_EXE,
    failed: { failedExe: FAILED_EXE, rollbackFailed: "the helper could not" },
    becomes: "1.0.0",
    says: "was rolled back by hand (the helper could not) — this is 1.0.0",
  },
  {
    name:
      "…or the kept-aside copy was started by hand, the failed one in place",
    record: notes("2.0.0"),
    runs: "1.0.0",
    exe: OLD_EXE,
    here: "notes.old-1.0.0",
    failed: { failedExe: FAILED_EXE, rollbackFailed: "the helper could not" },
    says: "ROLLBACK FAILED",
  },
  {
    name: "the swap itself failed: the old build was started again",
    record: notes("1.0.0"),
    runs: "1.0.0",
    exe: OLD_EXE,
    failed: { attempts: 0, swapFailed: "a move failed" },
    says: "could not be installed",
  },
  {
    name: "a record written for another artifact beside this install",
    record: { name: "notes", version: "1.0.0", artifact: "notes.AppImage" },
    runs: "2.0.0",
  },
  {
    name: "a record that names no version",
    record: { name: "notes", artifact: "notes" },
    runs: "2.0.0",
  },
  {
    // The writer takes only a record with a name; it decides, and nothing
    // is said about a correction that was not made.
    name: "a record without a name",
    record: { version: "1.0.0", artifact: "notes" },
    runs: "2.0.0",
  },
  { name: "a record that is not JSON", record: "{", runs: "2.0.0" },
  { name: "no record", record: null, runs: "2.0.0" },
  {
    name: "not a directory install",
    record: notes("1.0.0"),
    runs: "2.0.0",
    here: null,
  },
];

for (const c of RECORD_CASES) {
  Deno.test(`installed.json at boot: ${c.name}`, async () => {
    const dir = await tempDir("aio-rollback-dir-record-");
    const data = await tempDir("aio-rollback-dir-record-data-");
    try {
      const current = join(dir, "notes");
      const path = join(dir, "installed.json");
      const before = c.record === null
        ? null
        : typeof c.record === "string"
        ? c.record
        : JSON.stringify(c.record);
      if (before !== null) await Deno.writeTextFile(path, before);
      if (c.pending) writePending(data, marker(current, c.pending));
      if (c.firstBoot) {
        writeRecordAtomic(firstBootPath(data), marker(current));
      }
      if (c.failed) {
        writeRecordAtomic(failedUpdatePath(data), marker(current, c.failed));
      }
      const here = c.here === undefined ? current : c.here && join(dir, c.here);
      const warned: string[] = [];
      const errors = boot(data, c.exe ?? OLD_EXE, here, c.runs, warned);
      if (c.becomes) {
        assertEquals(await recordedVersion(dir, c.becomes), c.becomes);
        const rewrites = await recordLines(warned, 1);
        assertEquals(rewrites.length, 1, warned.join("\n"));
        assertStringIncludes(
          rewrites[0]!,
          `named ${(c.record as { version: string }).version} while ` +
            `${c.becomes} is running — corrected`,
        );
        // Said once: the next boot finds the record true.
        const again: string[] = [];
        boot(data, c.exe ?? OLD_EXE, here, c.runs, again);
        await new Promise((r) => setTimeout(r, 100));
        assertEquals(await recordLines(again, 0), []);
      } else {
        await new Promise((r) => setTimeout(r, 100)); // a wrong write would land
        assertEquals(
          await Deno.readTextFile(path).catch(() => null),
          before,
          "the record was not this boot's to change",
        );
        assertEquals(await recordLines(warned, 0), []);
      }
      assertEquals(errors.length, c.says ? 1 : 0, errors.join("\n"));
      if (c.says) assertStringIncludes(errors[0]!, c.says);
    } finally {
      await dropTempDir(dir);
      await dropTempDir(data);
    }
  });
}

// ── a healthy update, step by step ───────────────────────────────────────────
//
// The record follows the update at the moment it is CONFIRMED — the moment
// the flat and versioned installs have it right too — and nothing about it is
// said at warn level: the boot rule above is a repair, and a healthy update
// has nothing to repair.

type Step = {
  step: string;
  /** What happens: a boot (the judge, then the updater starts), with or
   *  without the confirm that follows a healthy start. */
  boot?: boolean;
  confirm?: "healthy" | "at exit";
  /** An installer (`run.sh`) puts this version in, and on the record. */
  install?: string;
  record: string;
};

const NEW_EXE = "1:300:6000:1800000000000";

const HEALTHY: {
  name: string;
  /** What the record says after the swap (a single-file swap writes it; the
   *  directory helper does not), and whether this is a directory install. */
  swapped?: string;
  file?: boolean;
  steps: Step[];
}[] = [
  {
    // The confirm writes only over the version the update replaced: a record
    // that names anything else is an install made since.
    name: "an install made before the confirm keeps its record",
    steps: [
      { step: "after apply: the helper swapped it in", record: "1.0.0" },
      { step: "first boot, not yet confirmed", boot: true, record: "1.0.0" },
      { step: "run.sh installs 3.0.0", install: "3.0.0", record: "3.0.0" },
      {
        step: "2.0.0 is confirmed healthy",
        confirm: "healthy",
        record: "3.0.0",
      },
    ],
  },
  {
    name:
      "a single-file install: the swap wrote it, the confirm changes nothing",
    swapped: "2.0.0",
    file: true,
    steps: [
      { step: "after apply: the swap wrote the record", record: "2.0.0" },
      { step: "first boot, not yet confirmed", boot: true, record: "2.0.0" },
      { step: "run.sh installs 3.0.0", install: "3.0.0", record: "3.0.0" },
      {
        step: "2.0.0 is confirmed healthy",
        confirm: "healthy",
        record: "3.0.0",
      },
      { step: "the next boot", boot: true, record: "3.0.0" },
    ],
  },
  {
    name: "confirmed in its first session",
    steps: [
      { step: "after apply: the helper swapped it in", record: "1.0.0" },
      { step: "first boot, not yet confirmed", boot: true, record: "1.0.0" },
      { step: "confirmed healthy", confirm: "healthy", record: "2.0.0" },
      { step: "the next boot", boot: true, record: "2.0.0" },
    ],
  },
  {
    // The first session ended cleanly before its confirm: the marker is only
    // stamped, and the next boot's judge confirms — moments before the
    // updater starts and looks at the same record.
    name: "confirmed by the next boot's judge",
    steps: [
      { step: "after apply: the helper swapped it in", record: "1.0.0" },
      { step: "first boot, not yet confirmed", boot: true, record: "1.0.0" },
      {
        step: "a clean exit before the confirm",
        confirm: "at exit",
        record: "1.0.0",
      },
      { step: "the next boot", boot: true, record: "2.0.0" },
      { step: "the boot after it", boot: true, record: "2.0.0" },
    ],
  },
];

for (const flow of HEALTHY) {
  Deno.test(`installed.json through a healthy update: ${flow.name}`, async () => {
    const dir = await tempDir("aio-rollback-dir-record-");
    const data = await tempDir("aio-rollback-dir-record-data-");
    try {
      const current = join(dir, "notes");
      if (flow.file) await Deno.writeTextFile(current, "the app");
      else await Deno.mkdir(current);
      await Deno.writeTextFile(
        join(dir, "installed.json"),
        JSON.stringify(notes(flow.swapped ?? "1.0.0")),
      );
      // What the old build leaves when it hands the swap to the helper.
      writePending(data, marker(current, { attempts: 0, fromExe: OLD_EXE }));
      const loud: string[] = [];
      const log = {
        ...quiet,
        warn: (_c: string, m: string) => loud.push(`${at}: ${m}`),
        error: (_c: string, m: string) => loud.push(`${at}: ${m}`),
      } as unknown as Log;
      let at = "";
      let confirm = (_atExit?: boolean) => {};
      let steps = 0;
      for (const s of flow.steps) {
        at = s.step;
        if (s.boot) {
          const stop = await judgePendingUpdate(data, log, "2.0.0", {
            os: "linux",
            exe: NEW_EXE,
          });
          assertEquals(stop, false, s.step);
          confirm = pendingConfirmer(data, log);
          boot(data, NEW_EXE, flow.file ? null : current, "2.0.0", loud);
        }
        if (s.install) {
          await Deno.writeTextFile(
            join(dir, "installed.json"),
            JSON.stringify(notes(s.install)),
          );
        }
        if (s.confirm) confirm(s.confirm === "at exit");
        assertEquals(await recordedVersion(dir, s.record), s.record, s.step);
        // Long enough for a second, wrong write to land.
        await new Promise((r) => setTimeout(r, 50));
        assertEquals(await recordedVersion(dir, s.record), s.record, s.step);
        steps++;
      }
      assertEquals(steps, flow.steps.length);
      assertEquals(loud, [], "a healthy update says nothing at warn or error");
    } finally {
      await dropTempDir(dir);
      await dropTempDir(data);
    }
  });
}

// The reason an earlier attempt at the rollback failed for goes when the
// rollback is handed on: the helper then made it, and its boot must not read
// that reason as "the helper could not".
Deno.test("rollback: an earlier failed attempt, then the helper puts the old version back — rolled back, not 'by hand'", async () => {
  const dir = await tempDir("aio-rollback-dir-record-");
  const data = await tempDir("aio-rollback-dir-record-data-");
  try {
    await handedToHelper(dir, data, FAILED_EXE, {
      more: { rollbackFailed: "an earlier try" },
    });
    const errors = boot(data, OLD_EXE, join(dir, "notes"), "1.0.0");
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!, "was rolled back: it failed to come up");
  } finally {
    await dropTempDir(dir);
    await dropTempDir(data);
  }
});

// ── the two orders in which the record and the tree can part ────────────────
//
// A rollback writes the record BEFORE the helper moves the tree; a forward
// swap moves the tree and writes NO record. One install, taken through both,
// with the process gone at the worst moment of each: after every boot that is
// allowed to decide, the record names the build that runs.
Deno.test("installed.json: a rollback cut between the record and the move, then a forward swap — each boot leaves the record true", async () => {
  const dir = await tempDir("aio-rollback-dir-record-");
  const data = await tempDir("aio-rollback-dir-record-data-");
  try {
    const current = join(dir, "notes");
    const record = join(dir, "installed.json");
    await Deno.mkdir(current);
    await Deno.mkdir(`${current}.old-1.0.0`);
    // The rollback of 2.0.0 got as far as the record — then the process was
    // gone: no failed record, the marker still there, the tree not moved.
    await Deno.writeTextFile(record, JSON.stringify(notes("1.0.0")));
    writePending(data, marker(current));
    // The failed build boots again. Its judge hands the rollback on once
    // more; the helper moves nothing, and starts the failed build again.
    const stop = await judgePendingUpdate(data, quiet, "2.0.0", {
      os: "windows",
      swapDirectory: () => ({ previous: "" }),
      exe: FAILED_EXE,
    });
    assertEquals(stop, true, "the rollback is handed to the helper again");
    assertEquals(readPending(data), null);
    const warned: string[] = [];
    const errors = boot(data, FAILED_EXE, current, "2.0.0", warned);
    assertEquals(errors.length, 1, errors.join("\n"));
    assertStringIncludes(errors[0]!, "ROLLBACK FAILED");
    assertEquals(await recordedVersion(dir, "2.0.0"), "2.0.0");
    assertEquals((await recordLines(warned, 1)).length, 1);

    // Forward: 2.0.0 → 3.0.0. The helper swapped the tree in and wrote
    // nothing; the new build's first boot is not yet the one that stays.
    await Deno.remove(failedUpdatePath(data));
    const forward = marker(current, {
      from: "2.0.0",
      to: "3.0.0",
      previous: `${current}.old-2.0.0`,
      attempts: 0,
      fromExe: FAILED_EXE,
      startedAt: "2026-08-09T00:00:00.000Z",
    });
    writePending(data, forward);
    const judge = () =>
      judgePendingUpdate(data, quiet, "3.0.0", { os: "linux", exe: NEW_EXE });
    assertEquals(await judge(), false);
    const said: string[] = [];
    boot(data, NEW_EXE, current, "3.0.0", said);
    await new Promise((r) => setTimeout(r, 100)); // a wrong write would land
    assertEquals(await recordedVersion(dir, "2.0.0"), "2.0.0");
    // …and that process is gone before any confirm. The next boot's judge
    // sees a build that came up twice, and the boot leaves the record true —
    // whichever of the two (confirm, boot check) writes it.
    assertEquals(await judge(), false);
    boot(data, NEW_EXE, current, "3.0.0", said);
    pendingConfirmer(data, quiet)();
    assertEquals(await recordedVersion(dir, "3.0.0"), "3.0.0");
    // A confirm cut after the marker went and before the record: the boot
    // after it has no marker to wait for, and repairs it — said once.
    await Deno.writeTextFile(record, JSON.stringify(notes("2.0.0")));
    assertEquals(readPending(data), null);
    boot(data, NEW_EXE, current, "3.0.0", said);
    assertEquals(await recordedVersion(dir, "3.0.0"), "3.0.0");
    assertEquals((await recordLines(said, 1)).length, 1, said.join("\n"));
  } finally {
    await dropTempDir(dir);
    await dropTempDir(data);
  }
});
