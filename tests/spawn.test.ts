// spawn.test.ts — the child-process API, and the bug it was written from.
//
// one GPU-pipeline app's hand-rolled version killed the parent and orphaned four Python CUDA
// workers holding GPU memory until reboot, because
// `Deno.Command("kill", ["-STOP", "-1234"])` exits 0 and signals NOTHING —
// procps kill does not read a negative pid as a group. It looked correct in
// review, with a confident comment above it.
//
// The tests therefore assert on the GRANDCHILD, not the child. A kill-the-tree
// test that only checks the process it started passes on code that has never
// worked.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { sessionLeaderSpec, spawn } from "../src/server/spawn.ts";

const posix = Deno.build.os !== "windows";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is this pid alive? `Deno.kill(pid, "SIGCONT")` throws NotFound if not. */
function alive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

/** The process state letter (`S` sleeping, `T` stopped) — the measurement the
 *  field report used to prove its kill was a no-op. */
async function state(pid: number): Promise<string> {
  const out = await new Deno.Command("ps", {
    args: ["-o", "stat=", "-p", String(pid)],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(out.stdout).trim().charAt(0);
}

/** A shell that starts a background grandchild, prints both pids, and waits. */
const TREE = `sleep 300 & echo "child:$$"; echo "grandchild:$!"; wait`;

async function spawnTree() {
  const pids: Record<string, number> = {};
  const h = await spawn("sh", {
    args: ["-c", TREE],
    onLine: (l) => {
      const m = l.match(/^(child|grandchild):(\d+)$/);
      if (m) pids[m[1]!] = Number(m[2]);
    },
  });
  for (let i = 0; i < 100 && !pids.grandchild; i++) await sleep(20);
  return { h, pids };
}

Deno.test({
  name: "spawn: kill() reaps the whole TREE, not just the child",
  ignore: !posix,
  fn: async () => {
    const { h, pids } = await spawnTree();
    assertEquals(typeof pids.grandchild, "number", "grandchild never started");
    assertEquals(alive(pids.grandchild!), true);

    await h.kill();
    await sleep(100);

    assertEquals(
      alive(pids.grandchild!),
      false,
      "the grandchild outlived kill() — this is the orphaned-GPU-worker bug: " +
        "signalling the child alone leaves the tree running",
    );
  },
});

Deno.test({
  name: "spawn: pause() really stops the group (state T), resume() restores it",
  ignore: Deno.build.os !== "linux", // `ps stat` letters are Linux-specific
  fn: async () => {
    const { h, pids } = await spawnTree();
    try {
      h.pause();
      await sleep(100);
      assertEquals(
        await state(pids.grandchild!),
        "T",
        "the GRANDCHILD must be stopped too — the field report measured a " +
          "three-process group that stayed in S through a kill(1) call and " +
          "went to T only through Deno.kill(-pid)",
      );
      assertEquals(h.paused, true);

      h.resume();
      await sleep(100);
      assertEquals(await state(pids.grandchild!), "S");
      assertEquals(h.paused, false);
    } finally {
      await h.kill();
    }
  },
});

Deno.test({
  name: "spawn: killing a PAUSED job works — SIGCONT goes first",
  ignore: !posix,
  fn: async () => {
    // A stopped process cannot handle SIGTERM. Without the CONT, this hangs
    // until the grace timer's SIGKILL — or forever, in a hand-rolled version
    // that has no grace timer.
    const { h, pids } = await spawnTree();
    h.pause();
    await sleep(50);

    const status = await Promise.race([
      h.kill(),
      sleep(5000).then(() => "TIMED OUT" as const),
    ]);
    assertEquals(status === "TIMED OUT", false, "kill() hung on a paused tree");
    await sleep(100);
    assertEquals(alive(pids.grandchild!), false);
  },
});

Deno.test({
  name: "spawn: an AbortSignal kills the tree — cancelOn needs no plumbing",
  ignore: !posix,
  fn: async () => {
    const ac = new AbortController();
    const pids: Record<string, number> = {};
    const h = await spawn("sh", {
      args: ["-c", TREE],
      signal: ac.signal,
      onLine: (l) => {
        const m = l.match(/^(child|grandchild):(\d+)$/);
        if (m) pids[m[1]!] = Number(m[2]);
      },
    });
    for (let i = 0; i < 100 && !pids.grandchild; i++) await sleep(20);

    ac.abort(); // this is what `s.$signal` does when cancelOn fires
    await h.status;
    await sleep(100);
    assertEquals(alive(pids.grandchild!), false);
  },
});

Deno.test({
  name: "spawn: \\r progress lines arrive as they happen",
  ignore: !posix,
  fn: async () => {
    // A progress bar rewrites ONE line and emits no \n for the whole job. A
    // reader that splits on \n alone shows nothing until the process exits,
    // which is the difference between a progress bar and a frozen window.
    const lines: string[] = [];
    const h = await spawn("sh", {
      args: ["-c", `printf '10%%\\r20%%\\r30%%\\n'`],
      onLine: (l, which) => {
        if (which === "stdout") lines.push(l);
      },
    });
    await h.status;
    assertEquals(lines, ["10%", "20%", "30%"]);
  },
});

Deno.test({
  name: "spawn: stderr is streamed too, and the pgid marker never leaks",
  ignore: !posix,
  fn: async () => {
    const seen: string[] = [];
    const h = await spawn("sh", {
      args: ["-c", `echo out; echo err >&2`],
      onLine: (l, w) => seen.push(`${w}:${l}`),
    });
    await h.status;
    assertEquals(seen.sort(), ["stderr:err", "stdout:out"]);
    assertEquals(
      seen.some((l) => l.includes("__aio_pgid")),
      false,
      "the group-id marker is framework plumbing and must never reach an app",
    );
  },
});

Deno.test({
  name: "spawn: the group id is the child's own, never this process's",
  ignore: !posix,
  fn: async () => {
    // The whole safety argument rests on this: Deno spawns children into the
    // CALLER's process group, so a negative-pid signal on an ungrouped child
    // would signal the app itself. If pid ever equals our own group, kill()
    // is a suicide button.
    const h = await spawn("sh", { args: ["-c", "sleep 5"] });
    try {
      assertEquals(h.pid === Deno.pid, false);
      const ourGroup = await new Deno.Command("ps", {
        args: ["-o", "pgid=", "-p", String(Deno.pid)],
        stdout: "piped",
      }).output();
      const mine = Number(new TextDecoder().decode(ourGroup.stdout).trim());
      assertEquals(
        h.pid === mine,
        false,
        "the child shares OUR process group — kill() would signal the app",
      );
    } finally {
      await h.kill();
    }
  },
});

Deno.test({
  name: "spawn: a missing command fails loudly instead of hanging",
  ignore: !posix,
  fn: async () => {
    // The launcher prints the marker and only then execs, so a bad command
    // exits after the marker — but a launcher that dies BEFORE it (bad cwd)
    // must not leave spawn() waiting on a marker that will never come.
    const e = await assertRejects(() =>
      spawn("definitely-not-a-real-binary-xyz", { cwd: "/nonexistent-dir-xyz" })
    );
    assertStringIncludes((e as Error).message, "definitely-not-a-real-binary");
  },
});

Deno.test({
  name: "spawn: a command that exits non-zero reports its code",
  ignore: !posix,
  fn: async () => {
    const h = await spawn("sh", { args: ["-c", "exit 3"] });
    const s = await h.status;
    assertEquals([s.code, s.success], [3, false]);
  },
});

Deno.test("sessionLeaderSpec: setsid waits, and the marker is the SHELL's pid", () => {
  const s = sessionLeaderSpec("setsid", "ffmpeg", ["-i", "a b.mp4"]);
  assertEquals(s.cmd, "setsid");
  assertEquals(
    s.args[0],
    "--wait",
    "without --wait, setsid forks and exits — the status would be lost",
  );
  assertStringIncludes(s.args[3]!, "__aio_pgid:$$");
  assertStringIncludes(
    s.args[3]!,
    'exec "$0" "$@"',
    "args must go through $0/$@ so a path with spaces survives",
  );
  assertEquals(s.args.slice(4), ["ffmpeg", "-i", "a b.mp4"]);
});

Deno.test("sessionLeaderSpec: perl sets the session in-process, then execs", () => {
  // macOS has no setsid binary; perl's POSIX::setsid() runs in the process we
  // spawned, so the pid we get IS the group leader.
  const s = sessionLeaderSpec("perl", "ffmpeg", ["-i", "in.mp4"]);
  assertEquals(s.cmd, "perl");
  assertStringIncludes(s.args[1]!, "POSIX::setsid()");
  assertStringIncludes(s.args[1]!, "exec @ARGV");
  assertEquals(s.args.slice(2), ["--", "ffmpeg", "-i", "in.mp4"]);
});
