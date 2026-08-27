// updates-apply.test.ts — the swap must leave the app runnable at every point,
// and a build that cannot come up must put itself back.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  awaitPredecessor,
  clearPending,
  installDir,
  judgePending,
  launchArtifactPath,
  MAX_BOOT_ATTEMPTS,
  type PendingUpdate,
  pruneKeepingNewest,
  pruneOld,
  readPending,
  RELAUNCH_FLAG,
  restoreArtifact,
  smokeTestArtifact,
  swapArtifact,
  swapDirectoryDetached,
  swapStrategy,
  sweepStaleSwaps,
  unpackArchive,
  writePending,
} from "../src/server/updates-apply.ts";

/** A real, runnable program that prints `body` and exits 0 — so a swap under
 *  test is a swap of something that actually runs, which is what the smoke test
 *  in `swapArtifact` measures. */
async function program(path: string, body: string): Promise<void> {
  await Deno.writeTextFile(path, `#!/bin/sh\necho ${body}\n`);
  await Deno.chmod(path, 0o755);
}

async function tmp(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "aio-updates-" });
}

Deno.test("swap: the artifact path is never missing, and the old one is kept", async () => {
  const dir = await tmp();
  try {
    const current = join(dir, "app");
    await Deno.writeTextFile(current, "v1");
    const staged = join(dir, "app.new");
    await Deno.writeTextFile(staged, "v2");

    const { previous } = await swapArtifact({
      current,
      staged,
      fromVersion: "1.0.0",
      smoke: false, // stand-ins: this pins the rename order, not executability
    });

    assertEquals(await Deno.readTextFile(current), "v2");
    assertEquals(await Deno.readTextFile(previous), "v1");
    // The staged file was renamed, not copied — nothing left behind to
    // re-install by accident on a later boot.
    assertEquals(await Deno.stat(staged).catch(() => null), null);

    // And the swap is reversible with no download.
    await restoreArtifact(current, previous);
    assertEquals(await Deno.readTextFile(current), "v1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("swap: on Unix, renaming over a file that is currently open still works", async () => {
  // The reason the strategy is `rename` and not `writeFile`: the kernel
  // refuses a write to a busy executable, but a rename only moves a directory
  // entry, so the running process keeps its inode while the path resolves to
  // the new version.
  //
  // This test used to run on Windows too and PASS — which was a lie. It opens a
  // DATA file, and a data file opened with Deno's default share mode permits
  // DELETE, so the rename succeeds. A running .EXE does not: Windows holds it
  // with no DELETE share and the rename is ERROR_ACCESS_DENIED. The false green
  // is why `binary` updates on Windows shipped broken. Windows now takes the
  // rename-self-aside path, pinned by its own tests below.
  if (Deno.build.os === "windows") return;
  const dir = await tmp();
  try {
    const current = join(dir, "app");
    await Deno.writeTextFile(current, "v1");
    const staged = join(dir, "app.new");
    await Deno.writeTextFile(staged, "v2");

    using open = await Deno.open(current, { read: true });
    await swapArtifact({ current, staged, fromVersion: "1.0.0", smoke: false });

    // The open handle still sees the OLD bytes (its inode is untouched)…
    const buf = new Uint8Array(2);
    await open.read(buf);
    assertEquals(new TextDecoder().decode(buf), "v1");
    // …while the path now resolves to the new version.
    assertEquals(await Deno.readTextFile(current), "v2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("swap: Windows renames the running image ASIDE, it never replaces it", async () => {
  // Windows permits renaming a running image; it does not permit replacing one.
  // The ordering is therefore inverted, and it is exercised HERE on every host
  // by naming the strategy explicitly — a Windows-only behaviour that only
  // Windows CI can see is a behaviour nobody sees.
  assertEquals(swapStrategy("windows"), "rename-self-aside");
  assertEquals(swapStrategy("linux"), "rename-over");
  assertEquals(swapStrategy("darwin"), "rename-over");

  const dir = await tmp();
  try {
    const current = join(dir, "app.exe");
    await Deno.writeTextFile(current, "v1");
    const staged = join(dir, "app.new");
    await Deno.writeTextFile(staged, "v2");

    const { previous } = await swapArtifact({
      current,
      staged,
      fromVersion: "1.0.0",
      strategy: "rename-self-aside",
      smoke: false,
    });

    assertEquals(await Deno.readTextFile(current), "v2");
    // The old image was MOVED, not copied — on Windows it could not have been
    // copied out from under itself either, and the moved file is what the next
    // boot renames back.
    assertEquals(await Deno.readTextFile(previous), "v1");
    await restoreArtifact(current, previous);
    assertEquals(await Deno.readTextFile(current), "v1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("swap: rename-self-aside puts the running image BACK if the move in fails", async () => {
  // The one moment the app has no artifact at its path. If the second move
  // fails, the first is undone — otherwise a failed update leaves nothing to
  // launch at all.
  const dir = await tmp();
  try {
    const current = join(dir, "app.exe");
    await Deno.writeTextFile(current, "v1");
    const staged = join(dir, "does-not-exist");

    let threw = false;
    try {
      await swapArtifact({
        current,
        staged,
        fromVersion: "1.0.0",
        strategy: "rename-self-aside",
        smoke: false,
      });
    } catch {
      threw = true;
    }
    assert(threw, "a missing staged artifact must fail loudly");
    assertEquals(
      await Deno.readTextFile(current),
      "v1",
      "the running image must be back at its own path",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("swap: an artifact that cannot exec is REFUSED before anything moves", async () => {
  // Bad architecture, a noexec mount, a missing +x. Nothing detected these: the
  // swap succeeded, the new build died before it could count a boot attempt,
  // and the app crash-looped forever with the rollback marker untouched. The
  // predecessor asks the question while it is still the thing that works.
  if (Deno.build.os === "windows") return; // no portable "cannot exec" stand-in
  const dir = await tmp();
  try {
    const current = join(dir, "app");
    await program(current, "v1");
    const staged = join(dir, "app.new");
    // Not a program: no shebang, no ELF header.
    await Deno.writeTextFile(staged, "\x7fnot-an-executable");

    let error = "";
    try {
      await swapArtifact({ current, staged, fromVersion: "1.0.0" });
    } catch (e) {
      error = String(e);
    }
    assert(error.includes("NOT installed"), `named the outcome: ${error}`);
    assertEquals(
      (await Deno.readTextFile(current)).includes("v1"),
      true,
      "the running version must be untouched",
    );
    assertEquals(
      await Deno.stat(`${current}.old-1.0.0`).catch(() => null),
      null,
      "nothing was moved aside — the refusal happened first",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("swap: a staged artifact that DOES run is installed", async () => {
  if (Deno.build.os === "windows") return; // the shell stand-in is Unix-only
  const dir = await tmp();
  try {
    const current = join(dir, "app");
    await program(current, "v1");
    const staged = join(dir, "app.new");
    await program(staged, "v2");

    await swapArtifact({ current, staged, fromVersion: "1.0.0" });
    assertEquals(
      (await Deno.readTextFile(current)).includes("v2"),
      true,
      "the smoke test must not stand in the way of a good update",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("smoke test: a hanging artifact is killed, not waited on forever", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tmp();
  try {
    const hang = join(dir, "hang");
    await Deno.writeTextFile(hang, "#!/bin/sh\nexec sleep 30\n");
    await Deno.chmod(hang, 0o755);
    const started = Date.now();
    const r = await smokeTestArtifact(hang, { timeoutMs: 300 });
    assertEquals(r.ok, false);
    assert(Date.now() - started < 10_000, "bounded");
    if (!r.ok) assert(r.error.includes("was killed"), r.error);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("swap: pruning keeps the N newest rollback targets", async () => {
  const dir = await tmp();
  try {
    const current = join(dir, "app");
    await Deno.writeTextFile(current, "v4");
    for (const [i, v] of ["1.0.0", "2.0.0", "3.0.0"].entries()) {
      const p = `${current}.old-${v}`;
      await Deno.writeTextFile(p, v);
      // Distinct mtimes so "newest" is well-defined.
      const t = new Date(2026, 0, 1 + i);
      await Deno.utime(p, t, t);
    }
    await pruneOld(current, 2);

    const left = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(left, ["app", "app.old-2.0.0", "app.old-3.0.0"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pending marker: round-trips and clears", async () => {
  const dir = await tmp();
  try {
    const p: PendingUpdate = {
      from: "1.0.0",
      to: "2.0.0",
      previous: "/x/app.old-1.0.0",
      attempts: 0,
      startedAt: "2026-08-08T00:00:00.000Z",
    };
    writePending(dir, p);
    assertEquals(readPending(dir)?.to, "2.0.0");
    clearPending(dir);
    assertEquals(readPending(dir), null);
    // Clearing an absent marker is not an error — a confirmed update clears
    // unconditionally and must not fail because it was already clean.
    clearPending(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("boot rollback: healthy confirms, unhealthy retries, then rolls back", () => {
  const base: PendingUpdate = {
    from: "1.0.0",
    to: "2.0.0",
    previous: "/x/app.old-1.0.0",
    backup: "/x/backup-1.0.0",
    attempts: 0,
    startedAt: "2026-08-08T00:00:00.000Z",
  };

  assertEquals(judgePending(null, false).action, "none");

  // Came up fine → the update is confirmed and the marker goes away.
  assertEquals(judgePending(base, true).action, "confirm");

  // First failure is not enough — a port collision or a machine still booting
  // would otherwise cause an outage of its own.
  const first = judgePending(base, false);
  assertEquals(first.action, "retry");
  if (first.action === "retry") assertEquals(first.attempt, 1);

  // Having spent its attempts, the NEW build puts the old one back itself —
  // nobody is watching an unattended service at 3am.
  const spent = judgePending({ ...base, attempts: MAX_BOOT_ATTEMPTS }, false);
  assertEquals(spent.action, "rollback");
  if (spent.action === "rollback") {
    assertEquals(spent.to, "1.0.0");
    assertEquals(spent.previous, "/x/app.old-1.0.0");
    // A forward migration cannot be undone by swapping the binary back, so the
    // backup taken before it is part of the rollback.
    assertEquals(spent.backup, "/x/backup-1.0.0");
  }
});

Deno.test("relaunch: the successor waits for the predecessor to release the lock", async () => {
  // aio refuses to start while another instance holds the appId lock, so a
  // naive spawn-then-exit races itself out of existence.
  let alive = true;
  const started = Date.now();
  setTimeout(() => (alive = false), 150);
  await awaitPredecessor([`${RELAUNCH_FLAG}=4242`], {
    timeoutMs: 5000,
    isAlive: () => alive,
  });
  assert(Date.now() - started >= 100, "returned before the predecessor exited");
});

Deno.test("relaunch: a normal launch carries no flag and never waits", async () => {
  const started = Date.now();
  await awaitPredecessor(["--port=0"], {
    timeoutMs: 5000,
    isAlive: () => true,
  });
  assert(Date.now() - started < 50);
});

Deno.test("relaunch: a hung predecessor times out instead of hanging forever", async () => {
  // Better to start and let the lock's own diagnostics explain a refusal than
  // to sit in a state with no UI and no logs.
  const started = Date.now();
  await awaitPredecessor([`${RELAUNCH_FLAG}=4242`], {
    timeoutMs: 200,
    isAlive: () => true,
  });
  assert(Date.now() - started >= 200);
});

// ── directory targets (electron-zip) ────────────────────────────────────────

Deno.test("install dir: found only when the launcher AND electron/ are both there", async () => {
  const dir = await tmp();
  try {
    const root = join(dir, "MyApp");
    const launcher = Deno.build.os === "windows" ? "run.bat" : "run.sh";
    await Deno.mkdir(join(root, "electron"), { recursive: true });
    await Deno.writeTextFile(join(root, launcher), "#!/bin/sh\n");
    // The executable lives deep inside the bundle, not at the root.
    const exe = join(root, "electron", "electron");
    await Deno.writeTextFile(exe, "");
    assertEquals(installDir(exe), root);

    // A lone launcher is NOT an install root — replacing the wrong directory
    // is the most expensive mistake this code could make.
    const bare = join(dir, "bare");
    await Deno.mkdir(bare, { recursive: true });
    await Deno.writeTextFile(join(bare, launcher), "#!/bin/sh\n");
    assertEquals(installDir(join(bare, "thing")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("directory swap: a path with a space and a quote survives it", async () => {
  // The old string-concatenated script broke on the first space. An install
  // directory chosen by a user, or a version string from a manifest, is not
  // ours to assume anything about.
  if (Deno.build.os === "windows") return; // the cmd.exe branch is asserted above
  const dir = await tmp();
  try {
    const current = join(dir, `My App "v1"`);
    const staged = join(dir, `My App "v1".staged-2.0.0`);
    await Deno.mkdir(current, { recursive: true });
    await Deno.mkdir(staged, { recursive: true });
    await Deno.writeTextFile(join(current, "VERSION"), "1.0.0");
    await Deno.writeTextFile(join(staged, "VERSION"), "2.0.0");

    let call: { cmd: string; args: string[] } | null = null;
    const { previous } = swapDirectoryDetached({
      current,
      staged,
      fromVersion: "1.0.0",
      spawn: (cmd, args) => (call = { cmd, args }),
    });
    const spawned = call as unknown as { cmd: string; args: string[] };
    const body = (await Deno.readTextFile(spawned.args[0]!))
      .replace(/^exec .*$/m, "true")
      .replace('kill -0 "$pid"', "false");
    const patched = `${spawned.args[0]}.patched`;
    await Deno.writeTextFile(patched, body);
    const out = await new Deno.Command("/bin/sh", {
      args: [patched, ...spawned.args.slice(1)],
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    assertEquals(await Deno.readTextFile(join(current, "VERSION")), "2.0.0");
    assertEquals(await Deno.readTextFile(join(previous, "VERSION")), "1.0.0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("directory swap: handed to a shell OUTSIDE both directories", async () => {
  // The constraint that shapes this: a process cannot move the directory it is
  // running from, and on Windows the running .exe inside it is locked outright.
  // So neither the old install nor the new one can perform the swap.
  const dir = await tmp();
  try {
    const current = join(dir, "MyApp");
    const staged = join(dir, "MyApp.staged-2.0.0");
    await Deno.mkdir(current, { recursive: true });
    await Deno.mkdir(staged, { recursive: true });

    let spawned: { cmd: string; args: string[] } | null = null;
    const { previous } = swapDirectoryDetached({
      current,
      staged,
      fromVersion: "1.0.0",
      spawn: (cmd, args) => (spawned = { cmd, args }),
    });

    assertEquals(previous, `${current}.old-1.0.0`);
    const call = spawned as unknown as { cmd: string; args: string[] };
    assert(
      call.cmd === "/bin/sh" || call.cmd === "cmd.exe",
      "the swapper must be the system shell, which lives in neither directory",
    );
    // Every value is a POSITIONAL ARGUMENT. It used to be concatenated into a
    // `/bin/sh -c` string, so an install directory containing a space broke the
    // update outright and one containing `"; rm -rf ~; #` was a self-injection
    // sink reachable from a manifest field.
    const script = call.args.find((a) => /aio-swap-.*\.(sh|bat)$/.test(a));
    assert(
      script,
      `the script is a FILE, not a string: ${call.args.join(" ")}`,
    );
    const body = await Deno.readTextFile(script);
    for (const value of [current, staged, previous, String(Deno.pid)]) {
      assert(
        !body.includes(value),
        `"${value}" must never appear inside the script body`,
      );
      assert(call.args.includes(value), `"${value}" is passed as an argument`);
    }
    assert(
      call.args.some((a) => a.endsWith("run.sh") || a.endsWith("run.bat")),
      "starts the new launcher",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("directory swap: the generated script really performs the swap", async () => {
  if (Deno.build.os === "windows") return; // the cmd.exe branch is asserted above
  const dir = await tmp();
  try {
    const current = join(dir, "MyApp");
    const staged = join(dir, "MyApp.staged-2.0.0");
    await Deno.mkdir(current, { recursive: true });
    await Deno.mkdir(staged, { recursive: true });
    await Deno.writeTextFile(join(current, "VERSION"), "1.0.0");
    await Deno.writeTextFile(join(staged, "VERSION"), "2.0.0");

    let call: { cmd: string; args: string[] } | null = null;
    swapDirectoryDetached({
      current,
      staged,
      fromVersion: "1.0.0",
      spawn: (cmd, args) => (call = { cmd, args }),
    });
    const spawned = call as unknown as { cmd: string; args: string[] };
    const script = spawned.args[0]!;
    // Run the REAL script with the REAL arguments, minus the exec of a launcher
    // that does not exist, and against a pid that is already gone so the wait
    // loop falls straight through.
    const body = (await Deno.readTextFile(script))
      .replace(/^exec .*$/m, "true")
      .replace('kill -0 "$pid"', "false");
    const patched = `${script}.patched`;
    await Deno.writeTextFile(patched, body);
    const out = await new Deno.Command("/bin/sh", {
      args: [patched, ...spawned.args.slice(1)],
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));

    assertEquals(await Deno.readTextFile(join(current, "VERSION")), "2.0.0");
    assertEquals(
      await Deno.readTextFile(join(`${current}.old-1.0.0`, "VERSION")),
      "1.0.0",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unpack: a missing tool is named, not swallowed", async () => {
  const dir = await tmp();
  try {
    // Not an archive — the tool runs and fails, and the reason survives.
    const bogus = join(dir, "not.zip");
    await Deno.writeTextFile(bogus, "definitely not a zip");
    const r = await unpackArchive(bogus, join(dir, "out"));
    assertEquals(r.ok, false);
    if (!r.ok) assert(r.error.length > 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pruneKeepingNewest: pre-migration store backups do not accumulate", async () => {
  // Superseded ARTIFACTS were pruned from the start; the store backups a
  // migrating update takes were not. On an app with a multi-gigabyte store that
  // is unbounded growth inside `data/` — the backup unit — so every `am backup`
  // then copied every historical snapshot as well. One retention rule, both
  // kinds.
  const dir = await Deno.makeTempDir({ prefix: "aio-prune-" });
  try {
    const names = [
      "pre-1.0.0-state.db",
      "pre-1.1.0-state.db",
      "pre-1.2.0-state.db",
      "pre-1.3.0-state.db",
      "pre-1.4.0-state.db",
    ];
    for (const [i, n] of names.entries()) {
      const p = join(dir, n);
      await Deno.writeTextFile(p, n);
      // Distinct mtimes: newest last, so "newest kept" is a real assertion and
      // not filesystem-ordering luck.
      await Deno.utime(p, new Date(), new Date(1_700_000_000_000 + i * 60_000));
    }
    // A file that is not ours stays, whatever the retention.
    await Deno.writeTextFile(join(dir, "state.db"), "live");

    await pruneKeepingNewest(dir, "pre-", 3);

    const left = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(left, [
      "pre-1.2.0-state.db",
      "pre-1.3.0-state.db",
      "pre-1.4.0-state.db",
      "state.db",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pruneKeepingNewest: a directory that never existed is not an error", async () => {
  await pruneKeepingNewest("/nonexistent-aio-prune-dir", "pre-", 3);
});

// ── the marker, and the path a rollback aims at ─────────────────────────────

Deno.test("pending marker: written atomically — a torn write is never mistaken for 'no update'", async () => {
  // A plain write leaves a window in which the file exists and is EMPTY, and an
  // empty marker parses as "nothing in flight" — so a power cut one second
  // after a swap used to erase the only record that a rollback was possible.
  const dir = await tmp();
  try {
    const p: PendingUpdate = {
      from: "1.0.0",
      to: "2.0.0",
      artifact: "/x/app",
      previous: "/x/app.old-1.0.0",
      attempts: 0,
      startedAt: "2026-08-08T00:00:00.000Z",
    };
    writePending(dir, p);
    // Nothing partial is left behind: the temp file is renamed, not kept.
    const names = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(names, ["update-pending.json"]);
    assertEquals(readPending(dir)?.artifact, "/x/app");

    // A truncated marker is not silently "no update in flight".
    await Deno.writeTextFile(join(dir, "update-pending.json"), "");
    assertEquals(readPending(dir), null);
    // …and neither is a well-formed JSON object missing what a rollback needs.
    await Deno.writeTextFile(join(dir, "update-pending.json"), '{"from":"1"}');
    assertEquals(readPending(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("swap: the marker goes down BEFORE anything moves, naming the stable path", async () => {
  // A crash between the swap and the marker left a new binary with no attempt
  // counter and no way back, permanently. The marker is therefore written
  // first, and it records WHICH path was replaced rather than leaving the next
  // boot to guess.
  const dir = await tmp();
  const data = await tmp();
  try {
    const current = join(dir, "app");
    await program(current, "v1");
    const staged = join(dir, "app.new");
    await program(staged, "v2");

    const { previous } = await swapArtifact({
      current,
      staged,
      fromVersion: "1.0.0",
      pending: { dataDir: data, from: "1.0.0", to: "2.0.0" },
    });

    const marker = readPending(data);
    assertEquals(marker?.artifact, current, "the STABLE path is recorded");
    assertEquals(marker?.previous, previous);
    assertEquals(marker?.attempts, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("swap: a refused artifact leaves no marker at all", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tmp();
  const data = await tmp();
  try {
    const current = join(dir, "app");
    await program(current, "v1");
    const staged = join(dir, "app.new");
    await Deno.writeTextFile(staged, "not-an-executable");

    await swapArtifact({
      current,
      staged,
      fromVersion: "1.0.0",
      pending: { dataDir: data, from: "1.0.0", to: "2.0.0" },
    }).catch(() => {});
    assertEquals(
      readPending(data),
      null,
      "nothing was installed, so nothing is pending",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("sweep: interrupted-swap leftovers are removed, live ones are not", async () => {
  // `.old-` is the rollback and stays. `.new-`, `.staged-` and `.zip-` are
  // debris nothing ever removed — on the electron-zip target, one full unpacked
  // install per interrupted attempt.
  const dir = await tmp();
  try {
    const current = join(dir, "app");
    await Deno.writeTextFile(current, "v1");
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const n of ["app.new-2.0.0", "app.zip-2.0.0", "app.rollback"]) {
      await Deno.writeTextFile(join(dir, n), "x");
      await Deno.utime(join(dir, n), old, old);
    }
    // A whole staged DIRECTORY, which is the electron-zip case.
    await Deno.mkdir(join(dir, "app.staged-2.0.0"));
    await Deno.writeTextFile(join(dir, "app.staged-2.0.0", "f"), "x");
    await Deno.utime(join(dir, "app.staged-2.0.0"), old, old);
    // A swap happening RIGHT NOW must not be deleted out from under itself.
    await Deno.writeTextFile(join(dir, "app.new-3.0.0"), "live");
    // The rollback is not debris.
    await Deno.writeTextFile(join(dir, "app.old-1.0.0"), "keep");
    await Deno.utime(join(dir, "app.old-1.0.0"), old, old);

    const removed = await sweepStaleSwaps(current);
    assertEquals(removed.sort(), [
      "app.new-2.0.0",
      "app.rollback",
      "app.staged-2.0.0",
      "app.zip-2.0.0",
    ]);
    const left = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(left, ["app", "app.new-3.0.0", "app.old-1.0.0"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prune: `.old-` DIRECTORIES are pruned too, not just files", async () => {
  // electron-zip keeps its rollback as a whole unpacked install. Skipping
  // directories meant that target leaked one complete copy of the app per
  // update, forever — nothing failed, the disk just filled.
  const dir = await tmp();
  try {
    const current = join(dir, "MyApp");
    await Deno.mkdir(current);
    for (const [i, v] of ["1.0.0", "2.0.0", "3.0.0"].entries()) {
      const p = `${current}.old-${v}`;
      await Deno.mkdir(p);
      await Deno.writeTextFile(join(p, "VERSION"), v);
      const t = new Date(2026, 0, 1 + i);
      await Deno.utime(p, t, t);
    }
    await pruneOld(current, 1);
    const left = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(left, ["MyApp", "MyApp.old-3.0.0"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("launch path: an install reached through a symlink reports the SYMLINK", async () => {
  // `Deno.execPath()` is /proc/self/exe — already resolved. Launched through
  // `~/app/notes/notes → versions/1.0.0/notes` it answers with the versioned
  // file, so every one-liner install wrote 2.0.0 INTO the directory named
  // 1.0.0, left the stable name pointing at a lie, and never pruned anything.
  // `$APPIMAGE` is resolved the same way, which is why AppImage exports ARGV0.
  const dir = await tmp();
  try {
    const target = join(dir, "versions", "1.0.0", "notes");
    await Deno.mkdir(join(dir, "versions", "1.0.0"), { recursive: true });
    await Deno.writeTextFile(target, "x");
    const link = join(dir, "notes");
    await Deno.symlink(target, link);

    assertEquals(
      launchArtifactPath({ execPath: target, appImage: null, argv0: link }),
      link,
      "ARGV0 wins — it is the path the user actually invoked",
    );
    assertEquals(
      launchArtifactPath({
        execPath: target,
        appImage: null,
        argv0: null,
        procArgv0: link,
      }),
      link,
      "argv[0] as the kernel recorded it is the next best answer",
    );
    // Nothing to go on: the resolved path, exactly as before.
    assertEquals(
      launchArtifactPath({
        execPath: target,
        appImage: null,
        argv0: null,
        procArgv0: null,
      }),
      target,
    );
    // A candidate that is NOT this process must never aim an update at itself.
    const other = join(dir, "unrelated");
    await Deno.writeTextFile(other, "y");
    assertEquals(
      launchArtifactPath({
        execPath: target,
        appImage: null,
        argv0: other,
        procArgv0: null,
      }),
      target,
      "a candidate resolving to a different file is discarded",
    );
    // A bare name off $PATH is not a path.
    assertEquals(
      launchArtifactPath({
        execPath: target,
        appImage: null,
        argv0: "notes",
        procArgv0: null,
      }),
      target,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("launch path: inside an AppImage the .AppImage file wins over the mount", async () => {
  // execPath points into the read-only squashfs mount, which vanishes with the
  // process. Writing an update there loses it silently.
  const dir = await tmp();
  try {
    const appImage = join(dir, "Notes.AppImage");
    await Deno.writeTextFile(appImage, "x");
    assertEquals(
      launchArtifactPath({
        execPath: "/tmp/.mount_Notesab12/usr/bin/notes",
        appImage,
        argv0: null,
        procArgv0: null,
      }),
      appImage,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
