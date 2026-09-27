// A directory swap whose new version NEVER STARTS is put back by the swap
// helper itself.
//
// The two-boot rollback runs inside the new build, so a build macOS refuses to
// open (or one that dies before booting) never judged itself: the old version
// sat aside as `X.app.old-<v>` and the app was simply gone. The helper now
// waits for the new version's first boot to take the first-boot token. It
// takes the token itself when the wait runs out: one rename against one
// delete, so exactly one side wins even at the same instant. Both orders of
// that race are pinned below, on the real script and the real judge.
import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  failedUpdatePath,
  firstBootPath,
  pendingPath,
  swapDirectoryDetached,
} from "../src/server/updates-apply.ts";
import {
  beginUpdates,
  judgePendingUpdate,
  startUpdates,
} from "../src/server/updates-boot.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Swap = {
  current: string;
  data: string;
  ran: string;
  out: Deno.CommandOutput;
  ms: number;
};

/** Stage v1 (running) and v2 (staged), each with a run.sh; v2's body is
 *  `v2Body(token, dir)`. Every launch appends its version to `ran`. Then run
 *  the REAL helper script with the REAL arguments (predecessor already gone,
 *  `wait` shortened, `seam` applied to the script text). */
async function swapWith(
  dir: string,
  v2Body: (token: string, here: string) => string,
  waitS: number,
  opts: {
    dropToken?: boolean;
    seam?: (script: string) => string;
    /** Runs just before the helper does. */
    before?: () => Promise<void>;
    /** The helper's environment (the default: this process's). */
    env?: Record<string, string>;
    /** A launcher outside the install, as a macOS `.app` passes. */
    launch?: (current: string) => { launcher: string; args: string[] };
  } = {},
): Promise<Swap> {
  const current = join(dir, "My App");
  const staged = join(dir, "My App.staged-2.0.0");
  const data = join(dir, "data");
  const ran = join(dir, "ran.txt");
  for (
    const [d, v] of [[current, "1.0.0"], [staged, "2.0.0"]] as const
  ) {
    await Deno.mkdir(d, { recursive: true });
    await Deno.writeTextFile(join(d, "VERSION"), v);
  }
  await Deno.mkdir(data);
  const token = firstBootPath(data);
  const run = (v: string, body: string) =>
    `#!/bin/sh\necho ${v} >> '${ran}'\n${body}\n`;
  await Deno.writeTextFile(join(current, "run.sh"), run("1.0.0", "exit 0"));
  await Deno.writeTextFile(
    join(staged, "run.sh"),
    run("2.0.0", v2Body(token, `$(dirname "$0")`)),
  );
  await Deno.chmod(join(current, "run.sh"), 0o755);
  await Deno.chmod(join(staged, "run.sh"), 0o755);
  // A long-lived program INSIDE the new install, as a real app is.
  await Deno.copyFile("/bin/sleep", join(staged, "sleeper"));

  let call: { cmd: string; args: string[] } | null = null;
  swapDirectoryDetached({
    current,
    staged,
    fromVersion: "1.0.0",
    ...opts.launch?.(current),
    pending: { dataDir: data, from: "1.0.0", to: "2.0.0" },
    spawn: (cmd, args) => (call = { cmd, args }),
  });
  assertEquals(
    await Deno.readTextFile(token),
    await Deno.readTextFile(pendingPath(data)),
    "the token is a copy of the pending record",
  );
  const spawned = call as unknown as { cmd: string; args: string[] };
  const script = spawned.args[0]!;
  const patched = join(dir, "helper.sh");
  const text = (await Deno.readTextFile(script))
    .replace('kill -0 "$pid"', "false");
  await Deno.writeTextFile(patched, opts.seam ? opts.seam(text) : text);
  await Deno.remove(script);
  const args = spawned.args.slice(1);
  assertEquals(args[5], pendingPath(data));
  assertEquals(args[6], token, "the helper races for the first-boot token");
  assertEquals(args[7], failedUpdatePath(data));
  assertEquals(args[8], "120");
  args[8] = String(waitS);
  if (opts.dropToken) await Deno.remove(token);
  await opts.before?.();
  const t0 = Date.now();
  const out = await new Deno.Command("/bin/sh", {
    args: [patched, ...args],
    env: opts.env,
  }).output();
  return { current, data, ran, out, ms: Date.now() - t0 };
}

const version = (d: string) => Deno.readTextFile(join(d, "VERSION"));
const exists = (p: string) => Deno.stat(p).then(() => true, () => false);
const alive = (pid: number) => {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
};
const err = (o: Deno.CommandOutput) => new TextDecoder().decode(o.stderr);

Deno.test("first-boot rollback: a new version that never starts is put back and the old one relaunched", async () => {
  if (Deno.build.os === "windows") return; // the PowerShell twin: measured on the Windows VM
  const dir = await tempDir("aio-fbr-dead-");
  try {
    const { current, data, ran, out } = await swapWith(dir, () => "exit 1", 2);
    assert(out.success, err(out));
    assertEquals(await version(current), "1.0.0", "the old version is back");
    assertEquals(
      (await Deno.readTextFile(ran)).trim().split("\n"),
      ["2.0.0", "1.0.0"],
      "v2 was started, then v1",
    );
    assertEquals(await exists(pendingPath(data)), false);
    assertEquals(await exists(firstBootPath(data)), false);
    const rec = JSON.parse(await Deno.readTextFile(failedUpdatePath(data)));
    assertEquals([rec.from, rec.to, rec.attempts], ["1.0.0", "2.0.0", 0]);
    assertEquals(await exists(join(dir, "My App.staged-2.0.0")), false);
    assertEquals(await exists(join(dir, "My App.old-1.0.0")), false);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("first-boot rollback: a first boot that takes the token keeps the new version, without the wait", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tempDir("aio-fbr-live-");
  try {
    // A long wait: the hand-back must not wait it out.
    const { current, data, ran, out, ms } = await swapWith(
      dir,
      (token) => `rm '${token}'`,
      60,
    );
    assert(out.success, err(out));
    assert(ms < 30_000, `the helper waited out its timer (${ms} ms)`);
    assertEquals(await version(current), "2.0.0");
    assertEquals((await Deno.readTextFile(ran)).trim(), "2.0.0");
    assertEquals(await exists(failedUpdatePath(data)), false);
    assert(await exists(pendingPath(data)));
    assertEquals(await version(join(dir, "My App.old-1.0.0")), "1.0.0");
  } finally {
    await dropTempDir(dir);
  }
});

// Race, order 1: the helper claims first. The new version is still running
// (hung before its first boot) — it is stopped, and waited for, BEFORE any
// directory moves; its boot, arriving late, loses and touches nothing.
Deno.test("first-boot rollback: helper claims first — the running new version is stopped before the swap back, and its boot then loses", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tempDir("aio-fbr-race1-");
  try {
    const pidFile = join(dir, "v2.pid");
    const { current, data, ran, out, ms } = await swapWith(
      dir,
      (_t, here) =>
        `echo $$ > '${pidFile}'\nexec "${here}/sleeper" 60 >/dev/null 2>&1`,
      1,
    );
    assert(out.success, err(out));
    assert(ms < 20_000, `the helper waited out the hung v2 (${ms} ms)`);
    const pid = Number(await Deno.readTextFile(pidFile));
    assertEquals(alive(pid), false, "v2 still runs after the swap back");
    assertEquals(await version(current), "1.0.0");
    assertEquals(
      (await Deno.readTextFile(ran)).trim().split("\n"),
      ["2.0.0", "1.0.0"],
    );
    assertEquals(await exists(firstBootPath(data)), false);
    assert(await exists(failedUpdatePath(data)));
  } finally {
    await dropTempDir(dir);
  }
});

// Race, order 2: the new version claims at the very instant the wait runs
// out (a seam holds the helper between its last look and its claim). The
// helper's rename fails, and it steps aside: v2 keeps running, nothing moves.
Deno.test("first-boot rollback: new version claims first, even at the timeout instant — the helper steps aside", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tempDir("aio-fbr-race2-");
  let pid = 0;
  try {
    const pidFile = join(dir, "v2.pid");
    const claim = 'mv -f "$token" "$failed"';
    const { current, data, ran, out } = await swapWith(
      dir,
      (token, here) =>
        `rm '${token}'\necho $$ > '${pidFile}'\nexec "${here}/sleeper" 60 >/dev/null 2>&1`,
      0,
      {
        seam: (s) => {
          assert(s.includes(claim), "the claim line moved");
          return s.replace(claim, `sleep 1; ${claim}`);
        },
      },
    );
    assert(out.success, err(out));
    pid = Number(await Deno.readTextFile(pidFile));
    assertEquals(alive(pid), true, "the helper stopped a version that won");
    assertEquals(await version(current), "2.0.0");
    assertEquals((await Deno.readTextFile(ran)).trim(), "2.0.0");
    assertEquals(await exists(failedUpdatePath(data)), false);
    assert(await exists(pendingPath(data)), "the marker is v2's to judge");
    assertEquals(await version(join(dir, "My App.old-1.0.0")), "1.0.0");
  } finally {
    if (pid && alive(pid)) Deno.kill(pid, "SIGKILL");
    await dropTempDir(dir);
  }
});

// A new version built with aio <= 1.0.12 never takes the token: its boot
// rewrites the marker (an attempt) or removes it (confirmed). That is its
// claim — the helper used to wait out the timer, stop it and put the old
// version back over a build that was running fine.
const markOf = (token: string) =>
  token.replace(/update-first-boot\.json$/, "update-pending.json");

for (
  const [how, claim] of [
    ["rewrites", (m: string) => `echo '{"attempts":1}' > '${m}'`],
    ["removes", (m: string) => `rm '${m}'`],
  ] as const
) {
  Deno.test(`first-boot rollback: a new version that ${how} the marker (aio <= 1.0.12) keeps running, without the wait`, async () => {
    if (Deno.build.os === "windows") return;
    const dir = await tempDir("aio-fbr-legacy-");
    let pid = 0;
    try {
      const pidFile = join(dir, "v2.pid");
      const { current, data, ran, out, ms } = await swapWith(
        dir,
        (token, here) =>
          `${
            claim(markOf(token))
          }\necho $$ > '${pidFile}'\nexec "${here}/sleeper" 60 >/dev/null 2>&1`,
        20,
      );
      assert(out.success, err(out));
      assert(ms < 15_000, `the helper waited out its timer (${ms} ms)`);
      pid = Number(await Deno.readTextFile(pidFile));
      assertEquals(alive(pid), true, "the helper stopped a version that runs");
      assertEquals(await version(current), "2.0.0");
      assertEquals((await Deno.readTextFile(ran)).trim(), "2.0.0");
      assertEquals(await exists(failedUpdatePath(data)), false);
      assertEquals(await exists(firstBootPath(data)), false, "token left");
    } finally {
      if (pid && alive(pid)) Deno.kill(pid, "SIGKILL");
      await dropTempDir(dir);
    }
  });
}

// ...and at the very instant of the claim: the helper took the token, but the
// marker changed under it. It hands the claim back rather than stop a build
// that booted.
Deno.test("first-boot rollback: an aio <= 1.0.12 boot at the claim instant keeps the new version", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tempDir("aio-fbr-legacy-race-");
  let pid = 0;
  try {
    const pidFile = join(dir, "v2.pid");
    const claim = 'mv -f "$token" "$failed"';
    const { current, data, out } = await swapWith(
      dir,
      (token, here) =>
        `echo $$ > '${pidFile}'\nsleep 0.3\necho '{"attempts":1}' > '${
          markOf(token)
        }'\nexec "${here}/sleeper" 60 >/dev/null 2>&1`,
      0,
      {
        seam: (s) => {
          assert(s.includes(claim), "the claim line moved");
          return s.replace(claim, `sleep 1; ${claim}`);
        },
      },
    );
    assert(out.success, err(out));
    pid = Number(await Deno.readTextFile(pidFile));
    assertEquals(alive(pid), true, "the helper stopped a version that runs");
    assertEquals(await version(current), "2.0.0");
    assertEquals(await exists(failedUpdatePath(data)), false);
  } finally {
    if (pid && alive(pid)) Deno.kill(pid, "SIGKILL");
    await dropTempDir(dir);
  }
});

Deno.test("first-boot rollback: a missing token still launches the new version", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tempDir("aio-fbr-notoken-");
  try {
    const { current, data, ran, out } = await swapWith(
      dir,
      () => "exit 0",
      60,
      { dropToken: true },
    );
    assert(out.success, err(out));
    assertEquals(await version(current), "2.0.0");
    assertEquals((await Deno.readTextFile(ran)).trim(), "2.0.0");
    assertEquals(await exists(failedUpdatePath(data)), false);
  } finally {
    await dropTempDir(dir);
  }
});

// A swap that cannot be made (a move still failing after its retries) used to
// `exit 1` with nothing running and the marker left behind. It now starts the
// version that is in place and leaves the failed record, with why.
const fewRetries = (s: string) => {
  const r = '[ "$i" -lt 50 ] || return 1';
  assert(s.includes(r), "the retry bound moved");
  return s.replace(r, '[ "$i" -lt 2 ] || return 1');
};

Deno.test("swap failure: the new version cannot be moved into place — the old one is started, and the record says why", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tempDir("aio-swapfail-new-");
  try {
    const staged = join(dir, "My App.staged-2.0.0");
    const { current, data, ran, out } = await swapWith(
      dir,
      () => "exit 0",
      60,
      {
        seam: fewRetries,
        before: () => Deno.remove(staged, { recursive: true }),
      },
    );
    assert(out.success, err(out));
    assertEquals(await version(current), "1.0.0");
    assertEquals((await Deno.readTextFile(ran)).trim(), "1.0.0");
    const rec = JSON.parse(await Deno.readTextFile(failedUpdatePath(data)));
    assertEquals(
      [rec.swapFailed, rec.from, rec.to],
      ["the new version could not be moved into place", "1.0.0", "2.0.0"],
    );
    assertEquals(await exists(pendingPath(data)), false);
    assertEquals(await exists(firstBootPath(data)), false);
    assertEquals(await exists(join(dir, "My App.old-1.0.0")), false);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("swap failure: an earlier copy that cannot be removed — nothing moves, the old one is started", async () => {
  if (Deno.build.os === "windows" || Deno.uid() === 0) return; // root ignores the mode
  const dir = await tempDir("aio-swapfail-prev-");
  const locked = join(dir, "My App.old-1.0.0", "locked");
  try {
    const { current, data, ran, out } = await swapWith(
      dir,
      () => "exit 0",
      60,
      {
        seam: fewRetries,
        before: async () => {
          await Deno.mkdir(locked, { recursive: true });
          await Deno.writeTextFile(join(locked, "f"), "x");
          await Deno.chmod(locked, 0o500);
        },
      },
    );
    assert(out.success, err(out));
    assertEquals(await version(current), "1.0.0");
    assertEquals((await Deno.readTextFile(ran)).trim(), "1.0.0");
    const rec = JSON.parse(await Deno.readTextFile(failedUpdatePath(data)));
    assertEquals(
      rec.swapFailed,
      "the running version could not be moved aside",
    );
    assertEquals(await exists(pendingPath(data)), false);
    assertEquals(
      await exists(join(dir, "My App.old-1.0.0", "My App")),
      false,
      "moved INTO the leftover copy",
    );
  } finally {
    // Wherever a broken swap moved it (the ledger's mutants move it INTO the
    // current version): every directory writable again, or it stays behind.
    await openAll(dir);
    await dropTempDir(dir);
  }
});

async function openAll(dir: string): Promise<void> {
  await Deno.chmod(dir, 0o700).catch(() => {});
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory) await openAll(join(dir, e.name));
  }
}

// A rollback whose move back fails used to `exit 1` after stopping the new
// version: no app running, and a record saying "rolled back". It now starts
// the version still in place, and the record says the rollback failed.
for (
  const [step, from, why] of [
    [
      "the new version cannot be moved out",
      'try_mv "$cur" "$new" ||',
      "the new version could not be moved out of the way",
    ],
    [
      "the old version cannot be moved back",
      'if ! try_mv "$prev" "$cur"; then',
      "the old version could not be moved back into place",
    ],
  ] as const
) {
  Deno.test(`first-boot rollback: ${step} — the version in place is started, and the record says the rollback failed`, async () => {
    if (Deno.build.os === "windows") return;
    const dir = await tempDir("aio-fbr-unrolled-");
    try {
      const { current, data, ran, out } = await swapWith(
        dir,
        () => "exit 1",
        1,
        {
          seam: (s) => {
            assert(s.includes(from), "the move moved");
            return s.replace(
              from,
              from.startsWith("if") ? "if ! false; then" : "false ||",
            );
          },
        },
      );
      assertEquals(await version(current), "2.0.0");
      assertEquals(
        (await Deno.readTextFile(ran)).trim().split("\n"),
        ["2.0.0", "2.0.0"],
        "the version in place is started again",
      );
      const rec = JSON.parse(await Deno.readTextFile(failedUpdatePath(data)));
      assertEquals([rec.rollbackFailed, rec.from, rec.to], [
        why,
        "1.0.0",
        "2.0.0",
      ]);
      assertEquals(await version(join(dir, "My App.old-1.0.0")), "1.0.0");
      // The helper ends by exec'ing the app: its status is the app's (exit 1).
      assert(!out.success, err(out));
    } finally {
      await dropTempDir(dir);
    }
  });
}

// The aio <= 1.0.12 claim was `cmp -s mark token || claimed`: ANY non-zero
// exit — cmp missing (127), a read error (2) — read as the new version's
// claim, so on a box without diffutils (or with an unreadable marker) the
// rollback watchdog was silently off and a build that never started stayed.
for (const how of ["cmp fails to run", "the marker cannot be read"] as const) {
  Deno.test(`first-boot rollback: ${how} — still no claim, the dead version is put back`, async () => {
    if (Deno.build.os === "windows" || Deno.uid() === 0) return; // root reads any mode
    const dir = await tempDir("aio-fbr-nocmp-");
    const bin = join(dir, "bin");
    try {
      await Deno.mkdir(bin);
      await Deno.writeTextFile(join(bin, "cmp"), "#!/bin/sh\nexit 127\n");
      await Deno.chmod(join(bin, "cmp"), 0o755);
      const { current, ran, out } = await swapWith(dir, () => "exit 1", 2, {
        env: { PATH: `${bin}:${Deno.env.get("PATH")}` },
        before: how === "the marker cannot be read"
          ? () => Deno.chmod(join(dir, "data", "update-pending.json"), 0)
          : undefined,
      });
      assert(out.success, err(out));
      assertEquals(await version(current), "1.0.0", "the old version is back");
      assertEquals(
        (await Deno.readTextFile(ran)).trim().split("\n"),
        ["2.0.0", "1.0.0"],
      );
    } finally {
      await dropTempDir(dir);
    }
  });
}

// Neither move could put an install back in place: the helper used to
// `exit 1` — no app running, and a record saying "rolled back". It records
// that FIRST, then starts the copy that is left (the old one first).
const stuckAtCur = (phase: "swap" | "rollback") => (s: string) => {
  const head = "try_mv() {\n  i=0";
  assert(s.includes(head), "try_mv moved");
  return s.replace(
    head,
    `try_mv() {\n  [ "$2" = "$cur" ] ${
      phase === "rollback" ? '&& [ -e "$failed" ] ' : ""
    }&& return 1\n  i=0`,
  );
};

Deno.test("first-boot rollback: neither version can be moved back — the record says so, and the old one is started where it is", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tempDir("aio-fbr-stuck-");
  try {
    const { current, data, ran } = await swapWith(dir, () => "exit 1", 1, {
      seam: stuckAtCur("rollback"),
    });
    assertEquals(await exists(current), false);
    assertEquals(
      (await Deno.readTextFile(ran)).trim().split("\n"),
      ["2.0.0", "1.0.0"],
      "the old version is started from where it was set aside",
    );
    const rec = JSON.parse(await Deno.readTextFile(failedUpdatePath(data)));
    assertEquals(
      rec.rollbackFailed,
      "the old version could not be moved back into place, nor the new one",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("swap failure: neither version can be moved into place — the record says why, and the old one is started where it is", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tempDir("aio-swapfail-stuck-");
  try {
    const { current, data, ran, out } = await swapWith(
      dir,
      () => "exit 0",
      60,
      { seam: stuckAtCur("swap") },
    );
    assert(out.success, err(out));
    assertEquals(await exists(current), false);
    assertEquals((await Deno.readTextFile(ran)).trim(), "1.0.0");
    const rec = JSON.parse(await Deno.readTextFile(failedUpdatePath(data)));
    assertEquals(
      rec.swapFailed,
      "the new version could not be moved into place, nor the old one back",
    );
    assertEquals(await exists(pendingPath(data)), false);
  } finally {
    await dropTempDir(dir);
  }
});

// A launcher OUTSIDE the install (macOS: `/usr/bin/open -n <app> --args …`)
// names the install as an argument: that argument is re-aimed too.
Deno.test("swap failure: a launcher outside the install is handed the copy that is left", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await tempDir("aio-swapfail-open-");
  try {
    const { ran, out } = await swapWith(dir, () => "exit 0", 60, {
      seam: stuckAtCur("swap"),
      launch: (current) => ({
        launcher: "/bin/sh",
        args: ["-c", 'exec "$0/run.sh" "$@"', current, "--flag"],
      }),
    });
    assert(out.success, err(out));
    assertEquals((await Deno.readTextFile(ran)).trim(), "1.0.0");
  } finally {
    await dropTempDir(dir);
  }
});

// LaunchServices opens a bundle only under a `.app` name, so `open -n` on the
// set-aside `X.app.old-1.0.0` fails (measured, macOS 14): that copy is
// started by its own executable, with the app's arguments.
Deno.test("swap failure (macOS): a set-aside .app copy is started by its executable", async () => {
  if (Deno.build.os !== "darwin") return; // PlistBuddy and LaunchServices
  const dir = await tempDir("aio-swapfail-app-");
  try {
    const { ran, out } = await swapWith(dir, () => "exit 0", 60, {
      seam: stuckAtCur("swap"),
      launch: (current) => ({
        launcher: "/usr/bin/open",
        args: ["-n", current, "--args", "--flag"],
      }),
      before: async () => {
        const c = join(dir, "My App", "Contents");
        await Deno.mkdir(join(c, "MacOS"), { recursive: true });
        await Deno.writeTextFile(
          join(c, "Info.plist"),
          `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>T</string></dict></plist>\n`,
        );
        await Deno.writeTextFile(
          join(c, "MacOS", "T"),
          `#!/bin/sh\necho "1.0.0 bundle $*" >> '${join(dir, "ran.txt")}'\n`,
        );
        await Deno.chmod(join(c, "MacOS", "T"), 0o755);
      },
    });
    assert(out.success, err(out));
    assertEquals((await Deno.readTextFile(ran)).trim(), "1.0.0 bundle --flag");
  } finally {
    await dropTempDir(dir);
  }
});

const quiet = () => {
  const errors: string[] = [];
  const log = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: (...a: string[]) => errors.push(a.join(" ")),
  } as unknown as Log;
  return { log, errors };
};

/** A data dir as `swapDirectoryDetached` leaves it: marker + token. */
async function swappedData(): Promise<string> {
  const dir = await tempDir("aio-fbr-judge-");
  await Deno.mkdir(join(dir, "app"));
  swapDirectoryDetached({
    current: join(dir, "app"),
    staged: join(dir, "app.staged"),
    fromVersion: "1.0.0",
    pending: { dataDir: dir, from: "1.0.0", to: "2.0.0" },
    // Nothing is spawned; the unix helper script it wrote is removed.
    spawn: (_c, args) =>
      Deno.build.os !== "windows" && Deno.removeSync(args[0]!),
  });
  return dir;
}

const listing = async (d: string) =>
  (await Array.fromAsync(Deno.readDir(d))).map((e) => e.name).sort();

// The judge's side of order 1: the helper renamed the token first. This boot
// exits (true) and writes nothing — not an attempt, not a byte.
Deno.test("first-boot rollback: a boot that lost the token exits without touching the data dir", async () => {
  const dir = await swappedData();
  try {
    Deno.renameSync(firstBootPath(dir), failedUpdatePath(dir)); // the helper's claim
    const before = await Deno.readTextFile(pendingPath(dir));
    const names = await listing(dir);
    const { log, errors } = quiet();
    assertEquals(await judgePendingUpdate(dir, log), true, "it kept booting");
    assertEquals(await Deno.readTextFile(pendingPath(dir)), before);
    assertEquals(await listing(dir), names);
    assertMatch(errors.join(" | "), /rolled back by the update helper/);
  } finally {
    await dropTempDir(dir);
  }
});

// The judge's side of order 2: this boot took the token first. It counts its
// attempt as always, and the helper's claim — the same rename it runs — fails.
Deno.test("first-boot rollback: a boot that took the token first makes the helper's claim fail", async () => {
  const dir = await swappedData();
  try {
    const { log } = quiet();
    assertEquals(await judgePendingUpdate(dir, log), false);
    assertEquals(
      JSON.parse(await Deno.readTextFile(pendingPath(dir))).attempts,
      1,
    );
    assertThrows(
      () => Deno.renameSync(firstBootPath(dir), failedUpdatePath(dir)),
      Deno.errors.NotFound,
    );
  } finally {
    await dropTempDir(dir);
  }
});

// No token and no matching failed record: a single-file swap, or a helper
// from a build before the token existed. Judged exactly as before.
Deno.test("first-boot rollback: no token (older helper, single-file swap) is judged as before", async () => {
  const dir = await swappedData();
  try {
    Deno.removeSync(firstBootPath(dir));
    // An older, unrelated failed record is not this swap's.
    await Deno.writeTextFile(
      failedUpdatePath(dir),
      JSON.stringify({ from: "0.9.0", to: "2.0.0", startedAt: "earlier" }),
    );
    const { log } = quiet();
    assertEquals(await judgePendingUpdate(dir, log), false);
    assertEquals(
      JSON.parse(await Deno.readTextFile(pendingPath(dir))).attempts,
      1,
    );
  } finally {
    await dropTempDir(dir);
  }
});

async function nextBoot(readyFails: boolean) {
  const errors: string[] = [];
  const warns: string[] = [];
  const log = {
    info: () => {},
    debug: () => {},
    error: (_c: string, m: string) => errors.push(m),
    warn: (_c: string, m: string) => warns.push(m),
  } as unknown as Log;
  let applies = 0;
  // What the boot handed `ready()` to dismiss; the stub cell answers a check
  // the way the real one does once a version is dismissed.
  let dismissed: string | undefined;
  const cell = {
    status: "idle",
    error: null,
    ready: () => {
      if (readyFails) return Promise.reject(new Error("dispatch failed"));
      dismissed = slot.rolledBack;
      return Promise.resolve();
    },
    check: () =>
      Promise.resolve(
        dismissed === "2.0.0"
          ? { kind: "current", reason: "2.0.0 was dismissed" }
          : { kind: "offer", update: { version: "2.0.0" } },
      ),
    apply: () => (applies++, Promise.resolve()),
  };
  const slot = { runtime: {}, cell } as unknown as UpdatesSlot;
  const data = await tempDir("aio-fbr-boot-");
  await Deno.writeTextFile(
    failedUpdatePath(data),
    JSON.stringify({
      from: "1.0.0",
      to: "2.0.0",
      previous: "/x.old-1.0.0",
      attempts: 0,
      startedAt: "",
    }),
  );
  await Deno.writeTextFile(
    join(data, "update-trust.json"),
    JSON.stringify({ installedSha256: "ab".repeat(32) }),
  );
  const started = startUpdates({
    updates: {
      source: "https://example.invalid/rel",
      check: 60_000,
      auto: true,
    },
    dataDir: data,
    appName: "demo",
    appVersion: "1.0.0",
    local: { schema: 1, cells: {} },
    exposed: false,
    log,
    argv: [],
    slot,
  });
  try {
    assertEquals(errors.length, 1, errors.join(" | "));
    assertMatch(
      errors[0]!,
      /update 1\.0\.0 → 2\.0\.0 was rolled back: it never started/,
    );
    const trust = JSON.parse(
      await Deno.readTextFile(join(data, "update-trust.json")),
    );
    assertEquals(
      trust.installedSha256,
      undefined,
      "the failed build's digest is forgotten",
    );
    beginUpdates(slot);
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(
      applies,
      0,
      "the version that never started was installed again",
    );
    assertMatch(warns.join(" | "), /not installing 2\.0\.0 again/);
    if (readyFails) {
      assertMatch(
        warns.join(" | "),
        /could not .*dismiss the rolled-back 2\.0\.0/,
      );
      assertEquals(await exists(failedUpdatePath(data)), true);
    } else {
      assertEquals(dismissed, "2.0.0");
      assertEquals(await exists(failedUpdatePath(data)), false);
    }
  } finally {
    started.stop();
    await dropTempDir(data);
  }
}

// aio-ok: the assertions are in nextBoot, shared by both cases
Deno.test(
  "first-boot rollback: the next boot names it and never auto-installs that version again",
  () => nextBoot(false),
);

// aio-ok: the assertions are in nextBoot, shared by both cases
Deno.test(
  "first-boot rollback: a dismissal that fails keeps the rolled-back record — the next boot dismisses it again",
  () => nextBoot(true),
);
