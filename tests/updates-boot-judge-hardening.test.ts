// The boot-time judge of an update, where a mistake costs the app: a boot
// killed by a file error is counted as a failed build, and an old version
// that finds the marker must never be taken for the new one.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  failedUpdatePath,
  firstBootPath,
  MAX_BOOT_ATTEMPTS,
  pendingPath,
  readPending,
  replacedExeIdentity,
  swapDirectoryDetached,
  writePending,
} from "../src/server/updates-apply.ts";
import {
  _confirm,
  confirmPendingUpdate,
  judgePendingUpdate,
  startUpdates,
} from "../src/server/updates-boot.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

function capture() {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  const log = {
    info: push,
    debug: push,
    warn: push,
    error: push,
  } as unknown as Log;
  return { log, lines };
}

/** The executable identities the tests stand in for `exeIdentity()`. */
const OLD_EXE = "1:100:5000:1700000000000";
const NEW_EXE = "1:200:5000:1700000099000";

/** A data dir as `swapDirectoryDetached` leaves it: marker + token. */
async function swapped(to = "2.0.0"): Promise<string> {
  const dir = await tempDir("aio-judge-");
  await Deno.mkdir(join(dir, "app"));
  swapDirectoryDetached({
    current: join(dir, "app"),
    staged: join(dir, "app.staged"),
    fromVersion: "1.0.0",
    pending: { dataDir: dir, from: "1.0.0", to, exe: OLD_EXE },
    spawn: (_c, args) =>
      Deno.build.os !== "windows" && Deno.removeSync(args[0]!),
  });
  return dir;
}

Deno.test("judge: the OLD version finding the marker is not the new one's boot — recorded as failed, never confirmed", async () => {
  const dir = await swapped();
  try {
    const { log, lines } = capture();
    assertEquals(
      await judgePendingUpdate(dir, log, "1.0.0", { exe: OLD_EXE }),
      false,
    );
    assertEquals(readPending(dir), null, "the marker would confirm 2.0.0");
    assertEquals(await Deno.stat(firstBootPath(dir)).catch(() => null), null);
    const rec = JSON.parse(await Deno.readTextFile(failedUpdatePath(dir)));
    assertEquals([rec.to, rec.swapFailed], [
      "2.0.0",
      "it never replaced 1.0.0",
    ]);
    assertMatch(
      lines.join("\n"),
      /did not take effect — this is still 1\.0\.0/,
    );
    confirmPendingUpdate(dir, log);
    await _confirm.pruned; // its background prune, read to the end
    assert(!lines.join("\n").includes("confirmed healthy"));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("judge: the new version is judged as always", async () => {
  const dir = await swapped();
  try {
    const { log } = capture();
    assertEquals(
      await judgePendingUpdate(dir, log, "2.0.0", { exe: NEW_EXE }),
      false,
    );
    assertEquals(readPending(dir)?.attempts, 1);
  } finally {
    await dropTempDir(dir);
  }
});

// Two builds can report ONE version: a repository rebuild (to = a commit,
// while a shallow clone stamps every build `<base>.1`), a pinned `version`, a
// publish re-stamped over an older one. Judged by the version, the new build
// recorded its own successful update as "did not take effect" and dropped its
// rollback. Only the executable tells the builds apart.
Deno.test("judge: a new build reporting the old version is judged as the new build, not the old", async () => {
  const dir = await swapped("abcdef12");
  try {
    const { log, lines } = capture();
    assertEquals(
      await judgePendingUpdate(dir, log, "1.0.0", { exe: NEW_EXE }),
      false,
    );
    assertEquals(readPending(dir)?.attempts, 1, lines.join("\n"));
    assertEquals(
      await Deno.stat(failedUpdatePath(dir)).catch(() => null),
      null,
    );
    assert(!lines.join("\n").includes("did not take effect"));
  } finally {
    await dropTempDir(dir);
  }
});

// A marker staged by an older build names no executable: unsure is never
// "old" — the boot is counted, as that build's own judge would.
Deno.test("judge: a marker without the old executable's identity never judges a boot old", async () => {
  const dir = await tempDir("aio-judge-legacy-");
  try {
    writePending(dir, {
      from: "1.0.0",
      to: "2.0.0",
      previous: join(dir, "app.old-1.0.0"),
      attempts: 0,
      startedAt: new Date().toISOString(),
    });
    const { log } = capture();
    assertEquals(
      await judgePendingUpdate(dir, log, "1.0.0", { exe: OLD_EXE }),
      false,
    );
    assertEquals(readPending(dir)?.attempts, 1);
    assertEquals(
      await Deno.stat(failedUpdatePath(dir)).catch(() => null),
      null,
    );
  } finally {
    await dropTempDir(dir);
  }
});

// The failed record is read on every boot that has a marker: a torn or
// `null` one used to throw out of the claim, and every boot exited.
Deno.test("judge: a torn or null update-failed.json never stops the boot — set aside, the boot counted", async () => {
  for (const text of ["{trunc", "null", ""]) {
    const dir = await swapped();
    try {
      Deno.removeSync(firstBootPath(dir)); // a single-file swap: no token
      Deno.writeTextFileSync(failedUpdatePath(dir), text);
      const { log, lines } = capture();
      const t0 = Date.now();
      assertEquals(
        await judgePendingUpdate(dir, log, "2.0.0", { exe: NEW_EXE }),
        false,
        JSON.stringify(text),
      );
      assert(Date.now() - t0 < 1000, "the claim was retried as if held");
      assertEquals(readPending(dir)?.attempts, 1);
      assertEquals(
        await Deno.stat(failedUpdatePath(dir)).catch(() => null),
        null,
      );
      assert(
        [...Deno.readDirSync(dir)].some((e) =>
          e.name.startsWith("update-failed.json.bad-")
        ),
        "moved aside, so it is said once",
      );
      assertMatch(lines.join("\n"), /update-failed\.json .* ignored, kept as/);
    } finally {
      await dropTempDir(dir);
    }
  }
});

Deno.test("judge: an attempt that cannot be recorded does not kill the boot", async () => {
  if (Deno.build.os === "windows" || Deno.uid() === 0) return; // the mode is the seam
  const dir = await swapped();
  try {
    Deno.removeSync(firstBootPath(dir));
    Deno.chmodSync(dir, 0o500);
    const { log, lines } = capture();
    assertEquals(await judgePendingUpdate(dir, log, "2.0.0"), false);
    assertMatch(
      lines.join("\n"),
      /could not record boot attempt 1 .* booting anyway/,
    );
  } finally {
    Deno.chmodSync(dir, 0o700);
    await dropTempDir(dir);
  }
});

Deno.test("judge: a token that cannot be taken exits (loudly) rather than run while the helper rolls back", async () => {
  const dir = await swapped();
  try {
    Deno.removeSync(firstBootPath(dir));
    Deno.mkdirSync(join(firstBootPath(dir), "held"), { recursive: true });
    const { log, lines } = capture();
    assertEquals(await judgePendingUpdate(dir, log, "2.0.0"), true);
    assertMatch(lines.join("\n"), /could not take the first-boot token/);
    assertEquals(readPending(dir)?.attempts, 0, "nothing was written");
  } finally {
    await dropTempDir(dir);
  }
});

// A Windows directory install cannot move the folder it runs from: every
// in-app rollback of one failed. It is handed to the swap helper.
Deno.test("judge: a Windows directory install is rolled back by the swap helper, not in-app", async () => {
  const dir = await swapped();
  try {
    const current = join(dir, "app");
    const previous = `${current}.old-1.0.0`;
    Deno.mkdirSync(previous);
    Deno.removeSync(firstBootPath(dir));
    writePending(dir, {
      ...readPending(dir)!,
      attempts: MAX_BOOT_ATTEMPTS,
    });
    const calls: { current: string; staged: string; fromVersion: string }[] =
      [];
    const { log } = capture();
    const stop = await judgePendingUpdate(dir, log, "2.0.0", {
      os: "windows",
      swapDirectory: (o) => (calls.push(o), { previous: "" }),
      exe: NEW_EXE,
    });
    assertEquals(stop, true);
    assertEquals(calls.map((c) => [c.current, c.staged, c.fromVersion]), [
      [current, previous, "2.0.0"],
    ]);
    assert(Deno.statSync(current).isDirectory, "moved from inside");
    assert(Deno.statSync(previous).isDirectory);
    assertEquals(readPending(dir), null);
    assertEquals(
      JSON.parse(Deno.readTextFileSync(failedUpdatePath(dir))).to,
      "2.0.0",
    );
  } finally {
    await dropTempDir(dir);
  }
});

function boot(data: string, log: Log, exe?: string) {
  const cell = {
    status: "idle",
    error: null,
    ready: () => {},
    check: () => Promise.resolve({ kind: "none" }),
    apply: () => Promise.resolve(),
    dismiss: () => Promise.resolve(),
  };
  return startUpdates({
    updates: { source: "https://example.invalid/rel", check: 60_000 },
    dataDir: data,
    appName: "demo",
    appVersion: "1.0.0",
    local: { schema: 1, cells: {} },
    exposed: false,
    log,
    argv: [],
    slot: { runtime: null, cell } as unknown as UpdatesSlot,
    exe,
  });
}

// The Windows rollback is the helper's, after this process is gone. When its
// move failed it started the build it was putting back — which had no marker
// left, and a record claiming "rolled back". That boot now finds itself.
Deno.test("judge: a Windows helper rollback that did not happen is said as a FAILED rollback on the next boot", async () => {
  for (const next of [NEW_EXE, OLD_EXE]) {
    const dir = await swapped();
    try {
      Deno.mkdirSync(join(dir, "app.old-1.0.0"));
      Deno.removeSync(firstBootPath(dir));
      writePending(dir, { ...readPending(dir)!, attempts: MAX_BOOT_ATTEMPTS });
      assertEquals(
        await judgePendingUpdate(dir, capture().log, "2.0.0", {
          os: "windows",
          swapDirectory: () => ({ previous: "" }),
          exe: NEW_EXE,
        }),
        true,
      );
      const { log, lines } = capture();
      boot(dir, log, next).stop();
      const said = lines.join("\n");
      const rec = JSON.parse(Deno.readTextFileSync(failedUpdatePath(dir)));
      if (next === NEW_EXE) {
        assertMatch(
          said,
          /ROLLBACK FAILED of update 1\.0\.0 → 2\.0\.0: .*this is still 2\.0\.0/,
        );
        assert(!said.includes("was rolled back"), said);
        assertMatch(rec.rollbackFailed, /could not move/);
      } else {
        assertMatch(
          said,
          /was rolled back: it failed to come up after 2 boots/,
        );
        assertEquals(rec.rollbackFailed, undefined);
      }
    } finally {
      await dropTempDir(dir);
    }
  }
});

// The failed record is replaced whole (temp + rename), like the marker: a
// reader never sees half of one, and a leftover the process may not WRITE
// (read-only, from a copy or a restore) is still replaced.
Deno.test("judge: the failed record is replaced atomically, never written in place", async () => {
  if (Deno.build.os === "windows" || Deno.uid() === 0) return; // the mode is the seam
  const dir = await swapped();
  try {
    // A VALID record of an older update: an unparseable one is moved aside by
    // the read before the write, and never tests the write at all.
    Deno.writeTextFileSync(
      failedUpdatePath(dir),
      JSON.stringify({
        from: "0.9.0",
        to: "1.0.0",
        previous: "",
        startedAt: "",
      }),
    );
    Deno.chmodSync(failedUpdatePath(dir), 0o444);
    const { log, lines } = capture();
    await judgePendingUpdate(dir, log, "1.0.0", { exe: OLD_EXE });
    const rec = JSON.parse(Deno.readTextFileSync(failedUpdatePath(dir)));
    assertEquals(rec.to, "2.0.0", lines.join("\n"));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("failed record: an unreadable one is said ONCE and moved aside", async () => {
  const data = await tempDir("aio-failed-bad-");
  try {
    Deno.writeTextFileSync(failedUpdatePath(data), "{torn");
    for (const expect of [1, 0]) {
      const { log, lines } = capture();
      boot(data, log).stop();
      assertEquals(
        lines.filter((l) => l.includes("update-failed.json")).length,
        expect,
        lines.join("\n"),
      );
    }
    assert(
      [...Deno.readDirSync(data)].some((e) =>
        e.name.startsWith("update-failed.json.bad-")
      ),
    );
  } finally {
    await dropTempDir(data);
  }
});

Deno.test("failed record: the words match what happened, and the OS", async () => {
  const data = await tempDir("aio-failed-words-");
  try {
    const rec = { from: "1.0.0", to: "2.0.0", previous: "", startedAt: "" };
    for (
      const [extra, want] of [
        [{ attempts: 0 }, /it never started/],
        [
          {
            attempts: 0,
            swapFailed: "the new version could not be moved into place",
          },
          /could not be installed: the new version could not be moved into place, so 1\.0\.0 was started again/,
        ],
      ] as const
    ) {
      Deno.writeTextFileSync(
        failedUpdatePath(data),
        JSON.stringify({ ...rec, ...extra }),
      );
      const { log, lines } = capture();
      boot(data, log).stop();
      const said = lines.join("\n");
      assertMatch(said, want);
      if (Deno.build.os !== "darwin") assert(!said.includes("macOS"), said);
    }
  } finally {
    await dropTempDir(data);
  }
});

// Only an executable the swap replaces can tell the old build from the new:
// one outside it (a `deno run`, an injected target) is the same file after the
// update, and recording it would judge every good update "did not take effect".
Deno.test("judge: the old build's identity is recorded only when the swap replaces the running executable", async () => {
  const dir = await tempDir("aio-judge-exeid-");
  try {
    const app = join(dir, "My App");
    await Deno.mkdir(app);
    const exe = join(app, "app.exe");
    const outside = join(dir, "deno");
    await Deno.writeTextFile(exe, "x");
    await Deno.writeTextFile(outside, "y");
    await Deno.writeTextFile(join(dir, "My App2"), "z");
    // The file itself, and a directory that holds it.
    assert(replacedExeIdentity(exe, exe));
    assert(replacedExeIdentity(app, exe));
    // Not inside: a sibling, a prefix-named sibling, a missing artifact.
    assertEquals(replacedExeIdentity(app, outside), undefined);
    assertEquals(replacedExeIdentity(join(dir, "My App2"), exe), undefined);
    assertEquals(replacedExeIdentity(join(dir, "My Ap"), exe), undefined);
    assertEquals(replacedExeIdentity(join(dir, "gone"), exe), undefined);
  } finally {
    await dropTempDir(dir);
  }
});

// The swap helper's record of an update is the truthful one. A marker it could
// not remove (a scanner holding it) used to make the OLD version's next boot
// overwrite that record with "it never replaced 1.0.0" — a rollback, or a swap
// that failed for a named reason, told as something else.
Deno.test("judge: the old version keeps the swap helper's record of the same update, and only drops the marker", async () => {
  const reasons = [{}, {
    swapFailed: "the new version could not be moved into place",
  }];
  for (const reason of reasons) {
    const dir = await swapped();
    try {
      // What the helper leaves: the token claimed as the failed record, the
      // marker still there.
      const helper = { ...readPending(dir)!, ...reason };
      Deno.removeSync(firstBootPath(dir));
      Deno.writeTextFileSync(failedUpdatePath(dir), JSON.stringify(helper));
      const { log, lines } = capture();
      assertEquals(
        await judgePendingUpdate(dir, log, "1.0.0", { exe: OLD_EXE }),
        false,
      );
      assertEquals(readPending(dir), null);
      assertEquals(
        JSON.parse(Deno.readTextFileSync(failedUpdatePath(dir))),
        helper,
        lines.join("\n"),
      );
      boot(dir, log, OLD_EXE).stop();
      assertMatch(
        lines.join("\n"),
        "swapFailed" in reason
          ? /could not be installed: the new version could not be moved/
          : /was rolled back: it never started/,
      );
    } finally {
      await dropTempDir(dir);
    }
  }
});

// …but a failed record of ANOTHER update is replaced, as before.
Deno.test("judge: a failed record of another update is replaced by this one's", async () => {
  const dir = await swapped();
  try {
    const other = { ...readPending(dir)!, to: "1.5.0" };
    Deno.writeTextFileSync(failedUpdatePath(dir), JSON.stringify(other));
    await judgePendingUpdate(dir, capture().log, "1.0.0", { exe: OLD_EXE });
    const rec = JSON.parse(Deno.readTextFileSync(failedUpdatePath(dir)));
    assertEquals([rec.to, rec.swapFailed], [
      "2.0.0",
      "it never replaced 1.0.0",
    ]);
  } finally {
    await dropTempDir(dir);
  }
});

// When neither copy could be moved back, the helper starts the OLD one from
// where it was set aside: that boot is not "still 2.0.0".
Deno.test("judge: a failed rollback that restarted the old version from its set-aside copy says so", async () => {
  const dir = await swapped();
  try {
    Deno.writeTextFileSync(
      failedUpdatePath(dir),
      JSON.stringify({
        ...readPending(dir)!,
        rollbackFailed:
          "the old version could not be moved back into place, nor the new one",
      }),
    );
    Deno.removeSync(pendingPath(dir));
    const cases = [
      [OLD_EXE, /this is 1\.0\.0, started from where it was set aside/],
      [NEW_EXE, /this is still 2\.0\.0/],
    ] as const;
    for (const [exe, says] of cases) {
      const { log, lines } = capture();
      boot(dir, log, exe).stop();
      assertMatch(lines.join("\n"), says);
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("judge: a marker its build stamped confirmed at a clean exit is confirmed by the next boot — the OLD file started by hand after it records no failed update", async () => {
  // The new build; the old file itself; a kept `.old-1.0.0` COPY (its own
  // identity) started by hand.
  for (
    const [exe, version] of [
      [NEW_EXE, "2.0.0"],
      [OLD_EXE, "1.0.0"],
      ["a-copy-of-the-old-file", "1.0.0"],
    ]
  ) {
    const dir = await swapped();
    try {
      writePending(dir, {
        ...readPending(dir)!,
        attempts: 1,
        confirmedAt: new Date().toISOString(),
      });
      const { log, lines } = capture();
      assertEquals(
        await judgePendingUpdate(dir, log, version, { exe }),
        false,
      );
      // Not the new build: the marker only goes — nothing is pruned from
      // under the build that is running.
      assertEquals(
        lines.join("\n").includes("started by hand after it"),
        version === "1.0.0",
        lines.join("\n"),
      );
      assertEquals(readPending(dir), null, exe);
      assertMatch(lines.join("\n"), /1\.0\.0 → 2\.0\.0 confirmed healthy/);
      assert(
        !lines.join("\n").includes("did not take effect"),
        lines.join("\n"),
      );
      assertEquals(
        await Deno.stat(failedUpdatePath(dir)).catch(() => null),
        null,
        `${exe}: a healthy update was recorded as failed`,
      );
    } finally {
      await dropTempDir(dir);
    }
  }
});
