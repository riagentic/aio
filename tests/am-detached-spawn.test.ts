// `am start` background spawn, per OS. It used sh -c "nohup … & echo $!"
// unconditionally — Windows has no sh, so am start failed outright there
//. The spec builder is pure so BOTH
// shapes are pinned on any OS; the POSIX contract is additionally proven by
// executing it for real.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { detachedSpawnSpec } from "../src/am/am-cmd-process.ts";

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
  assertStringIncludes(cmd, ">'/tmp/o.log' 2>&1 & echo $!");
});

Deno.test({
  name: "posix spec EXECUTES: detached child, real PID on stdout, log written",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir();
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
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  },
});
