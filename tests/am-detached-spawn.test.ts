// `am start` background spawn, per OS. It used sh -c "nohup … & echo $!"
// unconditionally — Windows has no sh, so am start failed outright there
//. The spec builder is pure so BOTH
// shapes are pinned on any OS; the POSIX contract is additionally proven by
// executing it for real.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { detachedSpawnSpec } from "../src/am/am-cmd-process.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("windows spec: PowerShell Start-Process, no sh/nohup, PID out", () => {
  const spec = detachedSpawnSpec(
    "windows",
    ["run", "-A", "src/app.ts", "--port=8123"],
    "C:\\logs\\out.log",
  );
  assertEquals(spec.cmd, "powershell");
  const ps = spec.args.join(" ");
  assert(!ps.includes("nohup"), "no POSIX-isms");
  assertStringIncludes(ps, "Start-Process");
  assertStringIncludes(ps, "-PassThru"); // the PID comes back on stdout
  assertStringIncludes(ps, "'src/app.ts'");
  assertStringIncludes(ps, "-RedirectStandardOutput 'C:\\logs\\out.log'");
  assertStringIncludes(ps, "-RedirectStandardError 'C:\\logs\\out.log.err'");
  assertStringIncludes(ps, "Write-Output $p.Id");
  // Embedded single quotes are doubled (PowerShell escaping), never raw.
  const evil = detachedSpawnSpec("windows", ["--title=o'brien"], "l.log");
  assertStringIncludes(evil.args.join(" "), "'--title=o''brien'");
});

Deno.test("posix spec: sh -c nohup … & echo $! (detached, log-merged)", () => {
  const spec = detachedSpawnSpec(
    "linux",
    ["run", "-A", "app.ts"],
    "/tmp/o.log",
  );
  assertEquals(spec.cmd, "sh");
  const cmd = spec.args[1]!;
  // The BINARY is absolute and quoted — never the bare word `deno`, which the
  // child shell would resolve from ITS PATH, yielding a pid for a process that
  // never execs (see am-process-safety.test.ts).
  assertStringIncludes(cmd, `nohup '${Deno.execPath()}' 'run' '-A' 'app.ts'`);
  assertStringIncludes(cmd, ">'/tmp/o.log' 2>&1 &");
  assert(cmd.trimEnd().endsWith("; echo $!"), "the PID is the last word");
  // Its OWN session where the box has setsid (cc §7: a runner that kills its
  // process group when a command ends killed the app with it), and plain
  // nohup where it does not (macOS ships no setsid binary).
  assertStringIncludes(
    cmd,
    "if command -v setsid >/dev/null 2>&1; then setsid nohup",
  );
  assertStringIncludes(cmd, "else nohup");
});

Deno.test({
  name:
    "posix spec EXECUTES: the child is in its OWN session, so killing the caller's process group cannot reach it (cc §7)",
  ignore: Deno.build.os !== "linux", // reads /proc; setsid is util-linux
  async fn() {
    const dir = await tempDir("am-detached-");
    const log = join(dir, "out.log");
    const spec = detachedSpawnSpec(
      Deno.build.os,
      ["eval", "await new Promise(r=>setTimeout(r,20000))"],
      log,
    );
    // The "runner": a shell that owns a process group of its own, starts the
    // app the way `am start` does, then lingers — long enough for us to kill
    // the whole group the way a CI step or an agent harness does.
    const runner = new Deno.Command("setsid", {
      args: [
        "sh",
        "-c",
        `${spec.cmd} ${
          spec.args.map((a) => "'" + a.replace(/'/g, "'\\''") + "'").join(" ")
        }; sleep 20`,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const reader = runner.stdout.getReader();
    const first = await reader.read();
    // Not read past the PID: cancel so the pipe is closed when the runner dies.
    await reader.cancel();
    const pid = parseInt(new TextDecoder().decode(first.value).trim(), 10);
    assert(Number.isFinite(pid) && pid > 0, "child PID came back on stdout");
    const stat = (p: number) => {
      // /proc/<pid>/stat: `pid (comm) state ppid pgrp session …` — comm may
      // hold spaces, so split after the last `)`.
      const s = Deno.readTextFileSync(`/proc/${p}/stat`);
      const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
      return { pgrp: Number(f[2]), session: Number(f[3]) };
    };
    // POLL for the session to be established, do not read once. `echo $!`
    // reports the PID the moment the shell forks the background job, and
    // `setsid` calls setsid(2) a moment LATER — a single read raced it and
    // failed under the loaded full suite while passing in isolation. Bounded,
    // so a real regression still fails.
    const mine = stat(Deno.pid);
    let child = stat(pid);
    const deadline = Date.now() + 5_000;
    while (child.session !== pid && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      try {
        child = stat(pid);
      } catch {
        break; // the child went away — the asserts below say so
      }
    }
    assertEquals(child.session, pid, "the app leads its own session");
    assertEquals(child.pgrp, pid, "…and its own process group");
    assert(child.session !== mine.session, "not the runner's session");
    // Kill the RUNNER's whole group, as a group-killing harness does.
    await new Deno.Command("kill", { args: ["-TERM", "--", `-${runner.pid}`] })
      .output();
    await runner.status;
    await new Promise((r) => setTimeout(r, 200));
    let alive = true;
    try {
      Deno.kill(pid, "SIGCONT");
    } catch {
      alive = false;
    }
    assert(alive, "the app outlives the group that started it");
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
    await dropTempDir(dir);
  },
});

Deno.test({
  name: "posix spec EXECUTES: detached child, real PID on stdout, log written",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("am-detached-");
    const log = join(dir, "out.log");
    // A stand-in "deno" invocation the spec runs verbatim: print + linger
    // briefly so we can prove the PID is the CHILD's and it outlives am.
    const spec = detachedSpawnSpec(
      Deno.build.os,
      ["eval", "console.log('alive'); await new Promise(r=>setTimeout(r,300))"],
      log,
    );
    const proc = new Deno.Command(spec.cmd, {
      args: spec.args,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const out = await proc.output(); // "am" is done here — child keeps running
    const pid = parseInt(new TextDecoder().decode(out.stdout).trim(), 10);
    assert(Number.isFinite(pid) && pid > 0, "child PID came back on stdout");
    // The child is alive after the spawner exited (detachment contract)…
    let alive = true;
    try {
      Deno.kill(pid, "SIGCONT");
    } catch {
      alive = false;
    }
    assert(alive, "child survives the spawning shell's exit");
    // …and its output lands in the log.
    for (let i = 0; i < 50; i++) {
      try {
        if ((await Deno.readTextFile(log)).includes("alive")) break;
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 20));
    }
    assertStringIncludes(await Deno.readTextFile(log), "alive");
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* already exited */ }
    await dropTempDir(dir);
  },
});
