// The Windows directory-swap helper and the run.bat it starts — pure specs,
// asserted from any OS. The live behavior (hostile install path swapped and
// relaunched with exact argv) was measured on a real Windows 11 VM.

import { assert, assertEquals } from "@std/assert";
import { _swapSpec } from "../src/server/updates-apply.ts";
import { _winLauncherBat } from "../src/build/build-electron.ts";

const HOSTILE = "C:\\apps\\A&md,pwned&x%PATH%!x![1]";

function decode(b64: string): string {
  const bin = atob(b64);
  let s = "";
  for (let i = 0; i < bin.length; i += 2) {
    s += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8));
  }
  return s;
}

Deno.test("swap spec (windows): no value reaches a command line cmd.exe re-parses", () => {
  const values = {
    pid: 4242,
    current: HOSTILE,
    previous: `${HOSTILE}.old-1.0.0`,
    staged: `${HOSTILE}.staged-2.0.0`,
    launcher: `${HOSTILE}\\run.bat`,
    args: ["--a=b&c", 'q"uote', "sp ace\\"],
  };
  const spec = _swapSpec("windows", values, "");
  // `cmd.exe /c <bat> …argv` re-parsed every value: `&` ran the rest as a
  // command, `%VAR%` expanded, `!` vanished under delayed expansion.
  assert(!/^cmd(\.exe)?$/i.test(spec.cmd), `the helper is ${spec.cmd}`);
  const line = spec.args.join(" ");
  for (
    const v of [
      values.current,
      values.previous,
      values.staged,
      values.launcher,
      ...values.args,
      String(values.pid),
    ]
  ) {
    assert(!line.includes(v), `"${v}" must not appear on the command line`);
  }
  // Every value arrives in the environment, verbatim.
  assertEquals(spec.env?.AIO_SWAP_CUR, values.current);
  assertEquals(spec.env?.AIO_SWAP_PREV, values.previous);
  assertEquals(spec.env?.AIO_SWAP_NEW, values.staged);
  assertEquals(spec.env?.AIO_SWAP_LAUNCH, values.launcher);
  assertEquals(spec.env?.AIO_SWAP_PID, "4242");
  assertEquals(spec.env?.AIO_SWAP_ARGC, "3");
  values.args.forEach((a, i) =>
    assertEquals(spec.env?.[`AIO_SWAP_ARG_${i}`], a)
  );
  // The script is a constant: nothing of the values inside it either.
  const i = spec.args.indexOf("-EncodedCommand");
  assert(i >= 0, "the script is passed encoded — nothing for a shell to parse");
  const script = decode(spec.args[i + 1]!);
  assert(script.includes("$env:AIO_SWAP_CUR"), script);
  assert(!script.includes("A&md"), "no value is interpolated into the script");
  // The helper's cwd must be OUTSIDE the install: Windows refuses to move a
  // directory that is some process's current directory (measured).
  assertEquals(spec.cwd, "C:\\apps");
});

Deno.test("swap spec (unix): a constant script file, every value a positional argument", () => {
  const spec = _swapSpec("linux", {
    pid: 7,
    current: "/opt/My App",
    previous: "/opt/My App.old-1",
    staged: "/opt/My App.staged",
    launcher: "/opt/My App/run.sh",
    args: ["--x"],
  }, "/tmp/aio-swap-1.sh");
  assertEquals(spec.cmd, "/bin/sh");
  assertEquals(spec.args, [
    "/tmp/aio-swap-1.sh",
    "7",
    "/opt/My App",
    "/opt/My App.old-1",
    "/opt/My App.staged",
    "/opt/My App/run.sh",
    "--x",
  ]);
  assertEquals(spec.cwd, "/opt");
});

Deno.test("run.bat: every SET is quoted, so an install path with & stays inert", () => {
  const bat = _winLauncherBat("myapp");
  // `SET HERE=%~dp0` expands first and parses after: a path holding `&` ended
  // the SET and ran the rest as a command (measured on Windows 11).
  const sets = bat.split("\n").filter((l) => /^SET /i.test(l));
  assert(sets.length > 0, `no SET line in: ${bat}`);
  for (const line of sets) {
    assert(/^SET "[A-Z_]+=.*"$/i.test(line), `unquoted SET: ${line}`);
  }
  assert(bat.includes('start "" "%HERE%myapp.exe" %*'), bat);
});
