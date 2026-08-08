// updates-apply.test.ts — the swap must leave the app runnable at every point,
// and a build that cannot come up must put itself back.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  awaitPredecessor,
  clearPending,
  installDir,
  judgePending,
  MAX_BOOT_ATTEMPTS,
  type PendingUpdate,
  pruneOld,
  readPending,
  RELAUNCH_FLAG,
  restoreArtifact,
  swapArtifact,
  swapDirectoryDetached,
  unpackArchive,
  writePending,
} from "../src/server/updates-apply.ts";

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

Deno.test("swap: renaming over a file that is currently open still works", async () => {
  // The reason the strategy is `rename` and not `writeFile`: the kernel
  // refuses a write to a busy executable, but a rename only moves a directory
  // entry, so the running process keeps its inode while the path resolves to
  // the new version.
  const dir = await tmp();
  try {
    const current = join(dir, "app");
    await Deno.writeTextFile(current, "v1");
    const staged = join(dir, "app.new");
    await Deno.writeTextFile(staged, "v2");

    using open = await Deno.open(current, { read: true });
    await swapArtifact({ current, staged, fromVersion: "1.0.0" });

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
    const script = call.args.join(" ");
    // Waits for us, moves both directories, and starts the new launcher.
    assert(script.includes(String(Deno.pid)), "waits for this process to exit");
    assert(script.includes(current) && script.includes(staged));
    assert(script.includes(previous), "keeps the old install for rollback");
    assert(
      script.includes("run.sh") || script.includes("run.bat"),
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

    let script = "";
    swapDirectoryDetached({
      current,
      staged,
      fromVersion: "1.0.0",
      // A pid that is already gone, so the wait loop falls straight through.
      spawn: (_cmd, args) => (script = args[1] ?? ""),
    });
    // Run the real script, minus the exec of a launcher that does not exist.
    const runnable = script.replace(/exec "[^"]*"[^;]*$/, "true");
    const out = await new Deno.Command("/bin/sh", {
      args: ["-c", runnable.replace(`kill -0 ${Deno.pid}`, "false")],
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
