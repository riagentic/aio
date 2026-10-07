// `am start` background spawn, per OS. It used sh -c "nohup … & echo $!"
// unconditionally — Windows has no sh, so am start failed outright there
//. The spec builder is pure so BOTH
// shapes are pinned on any OS; the POSIX contract is additionally proven by
// executing it for real.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { detachedSpawnSpec, launchDetached } from "../src/am/am-cmd-process.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { isProcessAlive } from "../src/server/single-instance-lock.ts";
import { SLEEP_ARGS } from "./proc-helper.ts";

Deno.test("windows spec: PowerShell Start-Process, one pre-quoted command line", () => {
  const spec = detachedSpawnSpec(
    "windows",
    ["run", "-A", "src/app.ts", "--port=8123"],
    "C:\\logs\\out.log",
  );
  assertEquals(spec.cmd, "powershell");
  const ps = spec.args.join(" ");
  assert(!ps.includes("nohup"), "no POSIX-isms");
  assertStringIncludes(ps, "Start-Process");
  assertStringIncludes(ps, "-PassThru"); // the PID comes back in a file
  // ONE string, already MSVC-quoted. `-ArgumentList @(…)` joins the elements
  // with spaces and does not quote them, so a value with a space was split by
  // the child — the app never booted.
  assertStringIncludes(
    ps,
    "-ArgumentList 'run -A src/app.ts --port=8123'",
  );
  const spaced = detachedSpawnSpec(
    "windows",
    ["run", "-A", "C:\\Users\\John Doe\\app.ts"],
    "l.log",
  );
  assertStringIncludes(
    spaced.args.join(" "),
    "-ArgumentList 'run -A \"C:\\Users\\John Doe\\app.ts\"'",
    "a space-bearing argument must be quoted once, before Start-Process",
  );
  assertStringIncludes(ps, "-RedirectStandardOutput 'C:\\logs\\out.log'");
  assertStringIncludes(ps, "-RedirectStandardError 'C:\\logs\\out.log.err'");
  // A FILE, never stdout: the child inherits PowerShell's handles, and a
  // stdout pipe held by the app kept `am start` waiting for its lifetime.
  assertStringIncludes(
    ps,
    "[IO.File]::WriteAllText('C:\\logs\\out.log.pid', [string]$p.Id)",
  );
  assert(!ps.includes("Write-Output"), ps);
  // A launch that fails says why where `am start` reads it (`<log>.err`).
  assertStringIncludes(
    ps,
    "catch { [IO.File]::WriteAllText('C:\\logs\\out.log.err', [string]$_); exit 1 }",
  );
  // Embedded single quotes are doubled (PowerShell escaping), never raw.
  const evil = detachedSpawnSpec("windows", ["--title=o'brien"], "l.log");
  assertStringIncludes(evil.args.join(" "), "'--title=o''brien'");
  // …and so are the TYPOGRAPHIC ones: PowerShell closes a single-quoted
  // string at U+2018/2019/201A/201B as well, so `Don’t; calc` in a title or a
  // path ended the string and ran the rest.
  for (const quote of ["\u2018", "\u2019", "\u201A", "\u201B"]) {
    const spec = detachedSpawnSpec(
      "windows",
      [`--title=a${quote}; calc #`],
      `C:\\l${quote}g\\out.log`,
      `C:\\d${quote}no.exe`,
    );
    const line = spec.args.join(" ");
    assertStringIncludes(line, `'"--title=a${quote}${quote}; calc #"'`);
    assertStringIncludes(line, `'C:\\l${quote}${quote}g\\out.log'`);
    assertStringIncludes(line, `-FilePath 'C:\\d${quote}${quote}no.exe'`);
    // No quote character of any kind is left undoubled inside a string.
    assertEquals(
      line.replace(/(['\u2018\u2019\u201A\u201B])\1/g, "").match(
        /[\u2018\u2019\u201A\u201B]/g,
      ),
      null,
      line,
    );
  }
});

Deno.test("posix spec: sh -c nohup … & echo $! >pid file (detached, log-merged)", () => {
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
  // The PID goes to a FILE, last — never to the launcher's stdout.
  assert(
    cmd.trimEnd().endsWith("; echo $! >'/tmp/o.log.pid'"),
    "the PID is the last word, into <log>.pid",
  );
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
      stdout: "null",
      stderr: "null",
    }).spawn();
    let pid = NaN;
    for (let i = 0; i < 250 && !(pid > 0); i++) {
      try {
        pid = parseInt(Deno.readTextFileSync(`${log}.pid`).trim(), 10);
      } catch { /* not yet written */ }
      if (!(pid > 0)) await new Promise((r) => setTimeout(r, 20));
    }
    assert(Number.isFinite(pid) && pid > 0, "child PID came back in the file");
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
  name:
    "this OS's spec EXECUTES: detached child, real PID in <log>.pid, log written",
  async fn() {
    const dir = await tempDir("am-detached-");
    const log = join(dir, "out.log");
    // A stand-in "deno" invocation the spec runs verbatim: print + linger
    // briefly so we can prove the PID is the CHILD's and it outlives am.
    const spec = detachedSpawnSpec(
      Deno.build.os,
      // (5 s: Windows' launcher is a PowerShell, which takes its time to go.)
      [
        "eval",
        "console.log('alive'); await new Promise(r=>setTimeout(r,5000))",
      ],
      log,
    );
    const pid = await launchDetached(spec, log); // "am" is done here
    assert(Number.isFinite(pid) && pid > 0, "child PID came back");
    // The child is alive after the spawner exited (detachment contract)…
    assert(isProcessAlive(pid), "child survives the spawning shell's exit");
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

// ── am never waits on the app's lifetime ────────────────────────────────────
// Measured on Windows: `Start-Process` creates the app with handle
// inheritance on, so the app held PowerShell's stdout — am's pipe — and `am
// start` (reading it to EOF for the pid) ran for as long as the app did.

Deno.test({
  name:
    "launchDetached: a child that would hold the launcher's stdout does not hold am",
  async fn() {
    const dir = await tempDir("am-detached-");
    const log = join(dir, "out.log");
    // The stand-in: the child keeps every handle the launcher had, for 20 s.
    // (A deno, not `sh -c "sleep 20 & echo $!"`: Windows has neither.)
    const spec = {
      cmd: Deno.execPath(),
      args: [
        "eval",
        `const c = new Deno.Command(Deno.execPath(), {
           args: ${JSON.stringify(SLEEP_ARGS)},
           stdin: "inherit", stdout: "inherit", stderr: "inherit",
           detached: true, // Windows ends a child with its parent otherwise
         }).spawn();
         c.unref();
         Deno.writeTextFileSync(${JSON.stringify(log + ".pid")}, String(c.pid));
         Deno.exit(0);`,
      ],
    };
    const t0 = performance.now();
    const pid = await launchDetached(spec, log, {}, 10_000);
    const took = performance.now() - t0;
    try {
      assert(took < 5_000, `am waited on the child: ${took} ms`);
      assert(pid > 0);
      assert(isProcessAlive(pid), "the child is alive — it was not waited for");
    } finally {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch { /* gone */ }
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "launchDetached: a launcher that never returns is bounded — killed, and said",
  async fn() {
    const dir = await tempDir("am-detached-");
    const log = join(dir, "out.log");
    try {
      const t0 = performance.now();
      const e = await assertRejects(() =>
        launchDetached({ cmd: Deno.execPath(), args: SLEEP_ARGS }, log, {}, 300)
      );
      assert(performance.now() - t0 < 5_000);
      assertStringIncludes(String(e), "did not return within 0.3 s");
      assertStringIncludes(String(e), log);
    } finally {
      await dropTempDir(dir);
    }
  },
});
