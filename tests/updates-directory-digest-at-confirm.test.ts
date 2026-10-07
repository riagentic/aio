// What a directory install records as INSTALLED is written when the update is
// confirmed — never before the swap has happened.
//
// The digest and the signed release time of a verified download went on the
// trust record before the helper moved anything. Measured on Windows 11: the
// swap failed, the old version started again, and `update-trust.json` carried
// the failed release's `installedReleasedAt` while the old version ran. That
// date is what tells an older build of one version from a newer one
// (`decide`'s "a stale or replayed manifest"), so it must describe the build
// that is running — or be absent.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  failedUpdatePath,
  readPending,
  swapArtifact,
  swapDirectoryDetached,
  writePending,
  writeRecordAtomic,
} from "../src/server/updates-apply.ts";
import {
  _confirm,
  confirmPendingUpdate,
  startUpdates,
  sweepRecordTmps,
} from "../src/server/updates-boot.ts";
import { readTrust, writeTrust } from "../src/server/updates-check.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const quiet = {
  info() {},
  debug() {},
  warn() {},
  error() {},
} as unknown as Log;
const SHA = "cd".repeat(32);
const RELEASED = "2026-10-02T18:20:00.000Z";

Deno.test("directory update: the verified digest rides on the marker and is recorded at the confirm", async () => {
  const root = await tempDir("aio-digest-confirm-");
  try {
    const data = join(root, "data");
    const current = join(root, "notes");
    await Deno.mkdir(data);
    await Deno.mkdir(current);
    await Deno.mkdir(`${current}.staged-2.0.0`);
    swapDirectoryDetached({
      current,
      staged: `${current}.staged-2.0.0`,
      fromVersion: "1.0.0",
      pending: {
        dataDir: data,
        from: "1.0.0",
        to: "2.0.0",
        sha256: SHA,
        releasedAt: RELEASED,
      },
      // The helper: nothing is moved in this test. Off Windows its script is
      // a temp file the helper itself removes when it runs.
      spawn: (_cmd, args) => {
        if (Deno.build.os !== "windows") Deno.removeSync(args[0]!);
      },
    });
    const marker = readPending(data)!;
    assertEquals([marker.sha256, marker.releasedAt], [SHA, RELEASED]);
    // Not yet: the swap may still fail.
    assertEquals(readTrust(data).installedSha256, undefined);
    // The new build's first boot counted itself, then proved healthy.
    writePending(data, { ...marker, attempts: 1 });
    confirmPendingUpdate(data, quiet);
    await _confirm.pruned; // its background prune, read to the end
    const trust = readTrust(data);
    assertEquals(
      [trust.installedSha256, trust.installedReleasedAt],
      [SHA, RELEASED],
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("single-file update: a marker with no digest leaves the record its swap wrote", async () => {
  const data = await tempDir("aio-digest-confirm-");
  try {
    writeTrust(data, { installedSha256: SHA, installedReleasedAt: RELEASED });
    writePending(data, {
      from: "1.0.0",
      to: "2.0.0",
      previous: join(data, "app.old-1.0.0"),
      attempts: 1,
      startedAt: "2026-10-02T18:30:00.000Z",
    });
    confirmPendingUpdate(data, quiet);
    await _confirm.pruned; // its background prune, read to the end
    const trust = readTrust(data);
    assertEquals(
      [trust.installedSha256, trust.installedReleasedAt],
      [SHA, RELEASED],
    );
  } finally {
    await dropTempDir(data);
  }
});

Deno.test("an update that was put back leaves neither its digest nor its release time on the record", async () => {
  const data = await tempDir("aio-digest-confirm-");
  try {
    // As a build before this one left it: written ahead of a swap that failed.
    writeTrust(data, { installedSha256: SHA, installedReleasedAt: RELEASED });
    writeRecordAtomic(failedUpdatePath(data), {
      swapFailed: "the running version could not be moved aside",
      from: "1.0.0",
      to: "2.0.0",
      previous: "/nonexistent-aio-test/notes.old-1.0.0",
      attempts: 0,
      startedAt: "2026-10-02T18:27:05.000Z",
    });
    startUpdates({
      updates: { source: "https://example.invalid/rel", check: false },
      dataDir: data,
      appName: "notes",
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      log: quiet,
      argv: [],
      slot: { runtime: null, cell: null } as unknown as UpdatesSlot,
      installDir: null,
    }).stop();
    const trust = readTrust(data);
    assertEquals(
      [trust.installedSha256, trust.installedReleasedAt],
      [undefined, undefined],
    );
  } finally {
    await dropTempDir(data);
  }
});

// A single-file swap wrote the digest AFTER its renames. Killed in between
// (measured: kill -9 there, 3 of 3), the new version ran and was confirmed
// under the old one's digest — and every check offered it to itself as
// "same version, new build". The marker carries it now, as for a directory.
Deno.test("single-file update: the digest rides on the marker too, and a confirm after a kill mid-swap records it", async () => {
  const root = await tempDir("aio-digest-confirm-");
  try {
    const data = join(root, "data");
    await Deno.mkdir(data);
    const current = join(root, "notes"), staged = join(root, "notes.new-2.0.0");
    await Deno.writeTextFile(current, "v1");
    await Deno.writeTextFile(staged, "v2");
    writeTrust(data, { installedSha256: "ab".repeat(32) });
    await swapArtifact({
      current,
      staged,
      fromVersion: "1.0.0",
      smoke: false,
      pending: {
        dataDir: data,
        from: "1.0.0",
        to: "2.0.0",
        sha256: SHA,
        releasedAt: RELEASED,
      },
    });
    // Killed here: the swap is made, the record still names the old build.
    assertEquals(await Deno.readTextFile(current), "v2");
    const marker = readPending(data)!;
    assertEquals([marker.sha256, marker.releasedAt], [SHA, RELEASED]);
    writePending(data, { ...marker, attempts: 1 });
    confirmPendingUpdate(data, quiet);
    await _confirm.pruned; // its background prune, read to the end
    const trust = readTrust(data);
    assertEquals(
      [trust.installedSha256, trust.installedReleasedAt],
      [SHA, RELEASED],
    );
  } finally {
    await dropTempDir(root);
  }
});

// …and the kill left `update-trust.json.tmp-<pid>` in the data directory for
// good.
Deno.test("a record's temp file left by a kill is removed at the next boot — one a live process is writing is not", async () => {
  const data = await tempDir("aio-digest-confirm-");
  try {
    const names = () => [...Deno.readDirSync(data)].map((e) => e.name).sort();
    const stale = [
      "update-trust.json.tmp-2147483647", // nobody
      `update-trust.json.tmp-${Deno.pid}`, // an earlier run with this pid
      "update-pending.json.tmp-2147483646",
    ];
    const kept = [
      "update-failed.json.tmp-4242", // being written by a live process
      "update-trust.json", // the record itself
      "update-notes.txt.tmp-2147483647", // not a record's temp
      "state.db.tmp-2147483647",
    ];
    for (const n of [...stale, ...kept]) {
      await Deno.writeTextFile(join(data, n), "{}");
    }
    await Deno.mkdir(join(data, "update-x.json.tmp-2147483645"));
    // (Where the app is pid 1 at every boot, its own pid is always alive.)
    sweepRecordTmps(data, (pid) => pid === 4242 || pid === Deno.pid);
    assertEquals(names(), [...kept, "update-x.json.tmp-2147483645"].sort());
    // A boot does it.
    await Deno.writeTextFile(join(data, stale[0]!), "{}");
    startUpdates({
      updates: { source: "https://example.invalid/rel", check: false },
      dataDir: data,
      appName: "notes",
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      log: quiet,
      argv: [],
      slot: { runtime: null, cell: null } as unknown as UpdatesSlot,
      installDir: null,
      artifact: "/nonexistent-aio-test/notes",
    }).stop();
    assertEquals(names().includes(stale[0]!), false);
  } finally {
    await dropTempDir(data);
  }
});
