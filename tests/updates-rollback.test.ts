// updates-rollback.test.ts — the boot half of an update, against a real
// filesystem.
//
// This is the code that runs when an update has already gone wrong, in a
// process nobody is watching, and until now NONE of it was pinned: deleting the
// entire body of the rollback turned no test red. Worse, two of the three
// install layouts did not roll back AT ALL — the versioned (`run.sh`) layout
// renamed a file onto ITSELF and logged "rolled back", and the electron-zip
// layout hit `AlreadyExists` on every attempt and then cleared the marker so it
// never retried. Everything here is a real directory with real artifacts.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  beginUpdates,
  confirmPendingUpdate,
  judgePendingUpdate,
  startUpdates,
} from "../src/server/updates-boot.ts";
import { readTrust } from "../src/server/updates-check.ts";
import {
  installUpdatesRuntime,
  updatesRuntime,
} from "../src/state/updates-cell.ts";
import {
  MAX_BOOT_ATTEMPTS,
  type PendingUpdate,
  readPending,
  swapArtifact,
  writePending,
} from "../src/server/updates-apply.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";

/** A log that keeps every line, so "it said so, loudly" is an assertion rather
 *  than a hope. */
function recorder(): Log & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (...a: unknown[]) => {
    lines.push(`${level} ${a.map(String).join(" ")}`);
  };
  return {
    lines,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("debug"),
  } as unknown as Log & { lines: string[] };
}

async function tmp(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "aio-rollback-" });
}

function mark(over: Partial<PendingUpdate>): PendingUpdate {
  return {
    from: "1.0.0",
    to: "2.0.0",
    previous: "/x/app.old-1.0.0",
    attempts: 0,
    startedAt: "2026-08-08T00:00:00.000Z",
    ...over,
  };
}

Deno.test("boot: retry, retry, then a REAL restore — and only then is the marker cleared", async () => {
  const dir = await tmp();
  const data = await tmp();
  try {
    const current = join(dir, "app");
    const previous = join(dir, "app.old-1.0.0");
    await Deno.writeTextFile(current, "v2-broken");
    await Deno.writeTextFile(previous, "v1-works");
    writePending(data, mark({ artifact: current, previous }));

    // Two boots that never reach "healthy" only COUNT. A single failure can be
    // a port collision or a machine still coming up, and rolling back on that
    // would be an outage of its own.
    for (let i = 1; i <= MAX_BOOT_ATTEMPTS; i++) {
      const log = recorder();
      assertEquals(await judgePendingUpdate(data, log), false);
      assertEquals(readPending(data)?.attempts, i);
      assertEquals(await Deno.readTextFile(current), "v2-broken");
    }

    // Attempts spent: the NEW build puts the old one back and says stop.
    const log = recorder();
    assertEquals(await judgePendingUpdate(data, log), true);
    assertEquals(
      await Deno.readTextFile(current),
      "v1-works",
      "the artifact at the stable path is the version that worked",
    );
    assertEquals(readPending(data), null, "a completed rollback clears itself");
    assert(
      log.lines.some((l) =>
        l.startsWith("error") && l.includes("rolling back")
      ),
      `the rollback is announced at error level: ${log.lines.join(" | ")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("boot: the VERSIONED layout restores the SYMLINK — it does not rename a file onto itself", async () => {
  // The bug this pins: `current` was derived by stripping `.old-<version>` off
  // `previous`, a suffix this layout never produces. So `current === previous`,
  // the rename was a no-op, "rolled back" was logged, and the stable name still
  // pointed at the broken version. It LIED.
  const dir = await tmp();
  const data = await tmp();
  try {
    const v1 = join(dir, "versions", "1.0.0", "notes");
    const v2 = join(dir, "versions", "2.0.0", "notes");
    await Deno.mkdir(join(dir, "versions", "1.0.0"), { recursive: true });
    await Deno.mkdir(join(dir, "versions", "2.0.0"), { recursive: true });
    await Deno.writeTextFile(v1, "v1-works");
    await Deno.writeTextFile(v2, "v2-broken");
    const link = join(dir, "notes");
    await Deno.symlink(v2, link);

    writePending(
      data,
      mark({ artifact: link, previous: v1, attempts: MAX_BOOT_ATTEMPTS }),
    );

    assertEquals(await judgePendingUpdate(data, recorder()), true);

    assertEquals(
      (await Deno.lstat(link)).isSymlink,
      true,
      "the stable name must STILL be a symlink",
    );
    assertEquals(await Deno.realPath(link), v1);
    assertEquals(await Deno.readTextFile(link), "v1-works");
    assertEquals(
      (await Deno.stat(v2)).isFile,
      true,
      "the version we rolled back FROM stays on disk",
    );
    assertEquals(readPending(data), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("boot: the electron-zip layout restores a DIRECTORY", async () => {
  // `previous` is a whole unpacked install here, and `rename` onto an existing
  // directory is `AlreadyExists (os error 17)` on every platform — so this path
  // failed on EVERY attempt, and the marker was then cleared so it never
  // retried. The current directory is moved aside first.
  const dir = await tmp();
  const data = await tmp();
  try {
    const current = join(dir, "MyApp");
    const previous = join(dir, "MyApp.old-1.0.0");
    await Deno.mkdir(current);
    await Deno.mkdir(previous);
    await Deno.writeTextFile(join(current, "VERSION"), "2.0.0");
    await Deno.writeTextFile(join(previous, "VERSION"), "1.0.0");
    writePending(
      data,
      mark({ artifact: current, previous, attempts: MAX_BOOT_ATTEMPTS }),
    );

    assertEquals(await judgePendingUpdate(data, recorder()), true);

    assertEquals(await Deno.readTextFile(join(current, "VERSION")), "1.0.0");
    assertEquals(readPending(data), null);
    // The broken install is not left lying around as a second copy.
    const left = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(left, ["MyApp"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("boot: a rollback that FAILS keeps the marker, is loud, and does not brick the app", async () => {
  // Clearing the marker after a failed rollback is what turned "this update
  // broke the app" into "this app is broken forever with no record of why".
  const dir = await tmp();
  const data = await tmp();
  try {
    const current = join(dir, "app");
    await Deno.writeTextFile(current, "v2-broken");
    // The version that worked is GONE — a prune, a full disk, a manual tidy-up.
    const previous = join(dir, "app.old-1.0.0");
    writePending(
      data,
      mark({ artifact: current, previous, attempts: MAX_BOOT_ATTEMPTS }),
    );

    const log = recorder();
    assertEquals(
      await judgePendingUpdate(data, log),
      false,
      "the boot continues — bricking the app on top of a failed rollback " +
        "helps nobody",
    );
    const kept = readPending(data);
    assert(kept, "the marker MUST survive a failed rollback");
    assert(kept.rollbackFailed, "and it records that the rollback failed");
    const errors = log.lines.filter((l) => l.startsWith("error"));
    assert(
      errors.some((l) => l.includes("ROLLBACK FAILED")),
      `it screams: ${log.lines.join(" | ")}`,
    );
    assert(
      errors.some((l) => l.includes(previous)),
      "and names the artifact the operator has to move back",
    );

    // Next boot: it says so AGAIN and tries again — never once and then quietly.
    const log2 = recorder();
    await judgePendingUpdate(data, log2);
    assert(
      log2.lines.some((l) => l.includes("FAILED on a previous boot")),
      `every boot repeats it: ${log2.lines.join(" | ")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("boot: a healthy app confirms the update and clears the marker", async () => {
  const dir = await tmp();
  const data = await tmp();
  try {
    const current = join(dir, "app");
    await Deno.writeTextFile(current, "v2");
    writePending(data, mark({ artifact: current, attempts: 1 }));

    const log = recorder();
    confirmPendingUpdate(data, log);
    assertEquals(readPending(data), null);
    assert(
      log.lines.some((l) => l.includes("confirmed healthy")),
      log.lines.join(" | "),
    );

    // Confirming when nothing is pending is a no-op, not an error — it runs on
    // every boot.
    confirmPendingUpdate(data, recorder());
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("boot: a marker from an older build is rolled back anyway, and says it is guessing", async () => {
  // `artifact` did not always exist. A marker written by an earlier build must
  // still roll back — and must not pretend it knew the path.
  const dir = await tmp();
  const data = await tmp();
  try {
    const current = join(dir, "app");
    const previous = join(dir, "app.old-1.0.0");
    await Deno.writeTextFile(current, "v2-broken");
    await Deno.writeTextFile(previous, "v1-works");
    writePending(data, mark({ previous, attempts: MAX_BOOT_ATTEMPTS }));

    const log = recorder();
    assertEquals(await judgePendingUpdate(data, log), true);
    assertEquals(await Deno.readTextFile(current), "v1-works");
    assert(
      log.lines.some((l) => l.includes("did not record which path")),
      `the guess is declared: ${log.lines.join(" | ")}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("boot: no marker means no work and no noise", async () => {
  const data = await tmp();
  try {
    const log = recorder();
    assertEquals(await judgePendingUpdate(data, log), false);
    assertEquals(log.lines, []);
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

// ── the install record the in-app updater used to leave behind ──────────────

Deno.test("in-app swap: installed.json follows the version that was installed", async () => {
  // `installed.json` had exactly one writer — `run.sh` — so an app that updated
  // itself five times still reported the version it was first installed at.
  // `am installed` was wrong, and `am upgrade`'s prune could delete the very
  // version a pending marker names as `previous`.
  const dir = await tmp();
  try {
    const vdir = join(dir, "versions", "1.0.0");
    await Deno.mkdir(vdir, { recursive: true });
    const target = join(vdir, "notes");
    await Deno.writeTextFile(target, "#!/bin/sh\necho 1.0.0\n");
    await Deno.chmod(target, 0o755);
    const link = join(dir, "notes");
    await Deno.symlink(target, link);
    await Deno.writeTextFile(
      join(dir, "installed.json"),
      JSON.stringify({
        name: "notes",
        version: "1.0.0",
        artifact: "notes",
        source: "https://example.invalid/notes.git",
      }),
    );
    const staged = join(dir, "staged");
    await Deno.writeTextFile(staged, "#!/bin/sh\necho 2.0.0\n");
    await Deno.chmod(staged, 0o755);

    await swapArtifact({
      current: link,
      staged,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    });

    const rec = JSON.parse(
      await Deno.readTextFile(join(dir, "installed.json")),
    );
    assertEquals(rec.version, "2.0.0");
    assertEquals(
      rec.source,
      "https://example.invalid/notes.git",
      "everything the record already knew survives",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("in-app swap: a binary nobody installed gets no invented record", async () => {
  // A file somebody copied to /usr/local/bin is not an `am`-managed install,
  // and inventing a record would make `am` claim to manage something it cannot.
  const dir = await tmp();
  try {
    const current = join(dir, "app");
    await Deno.writeTextFile(current, "#!/bin/sh\necho v1\n");
    await Deno.chmod(current, 0o755);
    const staged = join(dir, "app.new");
    await Deno.writeTextFile(staged, "#!/bin/sh\necho v2\n");
    await Deno.chmod(staged, 0o755);

    await swapArtifact({
      current,
      staged,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    });
    assertEquals(
      await Deno.stat(join(dir, "installed.json")).catch(() => null),
      null,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── what the boot sequence decides about CHECKING ───────────────────────────

Deno.test("boot: `check: false` really means no BOOT check, not just no polling", async () => {
  // It is documented as "manual `check()` only" and was not: the boot check
  // fired anyway, so an app that opted out of polling still contacted the
  // release host on every single launch. Two-sided, because "nothing happened"
  // passes for the wrong reason far too easily.
  const data = await tmp();
  const off = recorder();
  const on = recorder();
  try {
    const base = {
      dataDir: data,
      appName: "demo",
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      argv: [],
    };
    const quiet = startUpdates({
      ...base,
      updates: { source: "https://example.invalid/rel", check: false },
      log: off,
    });
    assertEquals(quiet.intervalMs, 0);
    beginUpdates();
    await new Promise((r) => setTimeout(r, 100));
    quiet.stop();
    assertEquals(
      off.lines.filter((l) => !l.startsWith("debug")),
      [],
      `nothing was attempted: ${off.lines.join(" | ")}`,
    );

    const loud = startUpdates({
      ...base,
      updates: { source: "https://example.invalid/rel" },
      log: on,
    });
    assert(loud.intervalMs > 0);
    beginUpdates();
    await new Promise((r) => setTimeout(r, 100));
    loud.stop();
    assert(
      on.lines.some((l) => l.startsWith("warn")),
      `the boot check IS attempted when checking is on: ${
        on.lines.join(" | ")
      }`,
    );
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("boot: a one-off --channel is NOT pinned forever", async () => {
  // An operator who looked at beta once had an install that silently followed
  // beta for the rest of its life. Pinning is an explicit act (`setChannel`) or
  // a property of the artifact (the build stamp) — never a flag on one run.
  const data = await tmp();
  try {
    const log = recorder();
    const started = startUpdates({
      updates: { source: "https://example.invalid/rel", check: false },
      dataDir: data,
      appName: "demo",
      appVersion: "1.0.0",
      flag: "beta",
      local: { schema: 1, cells: {} },
      exposed: false,
      log,
      argv: [],
    });
    assertEquals(started.channel, "beta", "the flag is honoured for this run");
    assertEquals(
      readTrust(data).channel,
      undefined,
      "…and it is NOT written down",
    );
    assert(
      log.lines.some((l) => l.includes("for this run only")),
      `and the app says so: ${log.lines.join(" | ")}`,
    );
    started.stop();
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("boot: the channel an app is BUILT for is pinned", async () => {
  const data = await tmp();
  try {
    const started = startUpdates({
      updates: { source: "https://example.invalid/rel", check: false },
      dataDir: data,
      appName: "demo",
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      log: recorder(),
      argv: [],
    });
    assertEquals(started.channel, "prod");
    assertEquals(readTrust(data).channel, "prod");
    started.stop();
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

// The two ways to drive updates, and why only one can win.
//
// An app may replace the whole platform half (`installUpdatesRuntime` on
// "aio/updates") when its delivery is not a shape aio can verify — an internal
// artifact server with its own auth, an MDM push. `startUpdates` used to
// install aio's runtime unconditionally, so an app that did both had its own
// implementation silently replaced and no way to see why its `check()` stopped
// being called. Configuration that is quietly overruled is worse than
// configuration that is refused.
Deno.test("updates: an app-supplied runtime and `updates:` cannot both win", async () => {
  const data = await Deno.makeTempDir({ prefix: "aio-updates-excl-" });
  const mine = {
    kind: "manifest" as const,
    channel: "prod",
    current: "1.0.0",
    exposed: false,
    check: () => Promise.resolve({ kind: "current" as const, reason: "mine" }),
    apply: () => Promise.resolve(),
    setChannel: () => Promise.resolve(),
  };
  try {
    installUpdatesRuntime(mine);
    let threw = "";
    try {
      startUpdates({
        dataDir: data,
        appName: "demo",
        appVersion: "1.0.0",
        local: { schema: 1, cells: {} },
        exposed: false,
        argv: [],
        updates: { source: "https://example.invalid/rel", check: false },
        log: recorder(),
      });
    } catch (e) {
      threw = (e as Error).message;
    }
    assertStringIncludes(threw, "already installed");
    // The refusal names BOTH doors and the fix for each — the reader has to be
    // able to tell which one they meant.
    assertStringIncludes(threw, "installUpdatesRuntime");
    assertStringIncludes(threw, "updates:");
    // …and the app's own runtime is untouched: a refusal that had already
    // clobbered it would be the bug wearing an error message.
    assertEquals(updatesRuntime(), mine);
  } finally {
    installUpdatesRuntime(null);
    await Deno.remove(data, { recursive: true }).catch(() => {});
  }
});
