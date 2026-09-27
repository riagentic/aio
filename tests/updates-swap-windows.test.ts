// The Windows directory-swap helper and the run.bat it starts — pure specs,
// asserted from any OS. The live behavior (hostile install path swapped and
// relaunched with exact argv) was measured on a real Windows 11 VM.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { _swapSpec, spawnSwapHelper } from "../src/server/updates-apply.ts";
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
    mark: `${HOSTILE}\\data\\update-pending.json`,
    token: `${HOSTILE}\\data\\update-first-boot.json`,
    failed: `${HOSTILE}\\data\\update-failed.json`,
    waitS: 120,
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
      values.mark,
      values.token,
      values.failed,
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
  assertEquals(spec.env?.AIO_SWAP_MARK, values.mark);
  assertEquals(spec.env?.AIO_SWAP_TOKEN, values.token);
  assertEquals(spec.env?.AIO_SWAP_FAILED, values.failed);
  assertEquals(spec.env?.AIO_SWAP_WAIT, "120");
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

// No PowerShell here, so the Windows helper's ORDER is pinned as text; its
// behavior was run on Windows 11 (both first-boot outcomes, a failed swap).
// Each step is one line, and the order is the guarantee: the old version is
// never started while the new one could still be running, no directory moves
// while a process from it lives, and a failed move still starts something.
Deno.test("swap spec (windows): the first-boot watchdog and the swap-failure path, in order", () => {
  const spec = _swapSpec("windows", {
    pid: 1,
    current: "C:\\a\\App",
    previous: "C:\\a\\App.old-1",
    staged: "C:\\a\\App.staged",
    launcher: "C:\\a\\App\\run.bat",
    mark: "m",
    token: "t",
    failed: "f",
    waitS: 120,
    args: [],
  }, "");
  const script = decode(spec.args[spec.args.indexOf("-EncodedCommand") + 1]!);
  const lines = script.split("\n").map((l) => l.trim());
  const at = (line: string, from = 0) => {
    const i = lines.indexOf(line, from);
    assert(i >= 0, `missing: ${line}\n${script}`);
    return i;
  };
  // A failed move starts the version in place and records why.
  // Nothing moves while a process from the install lives (Electron outlives
  // the server that spawned the helper): the move would fail.
  const pid = at(
    "while (Get-Process -Id $p -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }",
  );
  const drain = at(
    "for ($i = 0; $i -lt 150 -and (Get-Running).Count -gt 0; $i++) { Start-Sleep -Milliseconds 200 }",
    pid,
  );
  const aside = at(
    "if (-not (Test-Path -LiteralPath $prev)) { $r = Swap-In $cur $new $prev }",
    drain,
  );
  at(
    "if ($r -eq 1) { Write-Failed 'the running version could not be moved aside'; Start-App; exit 1 }",
    aside,
  );
  const into = at(
    "if ($r -eq 3) { Write-Failed 'the new version could not be moved into place'; Remove-Dir $new; Start-App; exit 1 }",
    aside,
  );
  // The watchdog: start, wait for the token to go, claim it, stop, swap back.
  const start = at("Start-App", into);
  const loop = at("for ($i = 0; $i -lt $wait; $i++) {", start);
  at("if (-not [IO.File]::Exists($token)) { exit 0 }", loop);
  const claim = at(
    "try { [IO.File]::Move($token, $failed) } catch { exit 0 }",
    loop,
  );
  const stop = at(
    "$ps | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    claim,
  );
  // A move back that fails starts the version still in place, and says so.
  const back = at(
    "if ($r -eq 1) { Set-Unrolled 'the new version could not be moved out of the way'; exit 1 }",
    at("$r = Swap-In $cur $prev $new", stop),
  );
  at(
    "if ($r -eq 3) { Set-Unrolled 'the old version could not be moved back into place'; exit 1 }",
    back,
  );
  assert(
    /function Set-Unrolled\(\$why\) \{[\s\S]*?"rollbackFailed"[\s\S]*?Start-Any\n\}/
      .test(script),
    "Set-Unrolled records the failed rollback and starts the app",
  );
  assertEquals(
    lines.lastIndexOf("Start-App") > back,
    true,
    "v1 is started last",
  );
  // Every running process is matched by its executable under the install.
  assert(script.includes("$_.ExecutablePath.StartsWith($cur + '\\'"), script);
});

Deno.test("swap spec (unix): a constant script file, every value a positional argument", () => {
  const spec = _swapSpec("linux", {
    pid: 7,
    current: "/opt/My App",
    previous: "/opt/My App.old-1",
    staged: "/opt/My App.staged",
    launcher: "/opt/My App/run.sh",
    mark: "/d/update-pending.json",
    token: "/d/update-first-boot.json",
    failed: "/d/update-failed.json",
    waitS: 120,
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
    "/d/update-pending.json",
    "/d/update-first-boot.json",
    "/d/update-failed.json",
    "120",
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

// Three ways the Windows helper used to END with no app running, or roll back
// one that ran: a broken WMI threw out of Get-Running (after the old version
// exited, before anything was started); a marker held by a scanner threw out
// of a bare Delete; and a new version built with aio <= 1.0.12, which claims
// by rewriting or removing the marker, never by the token, was stopped after
// the wait. Each was run on Windows 11; pinned here as text.
Deno.test("swap spec (windows): WMI failure, a held file, and an aio <= 1.0.12 claim never end with no app", () => {
  const spec = _swapSpec("windows", {
    pid: 1,
    current: "C:\\a\\App",
    previous: "C:\\a\\App.old-1",
    staged: "C:\\a\\App.staged",
    launcher: "C:\\a\\App\\run.bat",
    mark: "m",
    token: "t",
    failed: "f",
    waitS: 120,
    args: [],
  }, "");
  const script = decode(spec.args[spec.args.indexOf("-EncodedCommand") + 1]!);
  const raw = script.split("\n");
  const lines = raw.map((l) => l.trim());
  assert(
    script.includes("  try { @(Get-CimInstance Win32_Process") &&
      script.includes("}) } catch { @() }"),
    "Get-Running is guarded",
  );
  // No top-level Delete: each is inside a try, or retried by Remove-File.
  assertEquals(
    raw.filter((l) => /^(try \{ )?\[IO\.File\]::Delete/.test(l)),
    [],
  );
  const loop = lines.indexOf("for ($i = 0; $i -lt $wait; $i++) {");
  const legacy = lines.indexOf(
    "if (Test-Claimed $token) { Remove-File $token; exit 0 }",
  );
  const claim = lines.indexOf(
    "try { [IO.File]::Move($token, $failed) } catch { exit 0 }",
  );
  const after = lines.indexOf(
    "if (Test-Claimed $failed) { Remove-File $failed; exit 0 }",
  );
  const mark = lines.indexOf("Remove-File $mark");
  assert(loop >= 0 && legacy > loop && claim > legacy, script);
  assertEquals(after, claim + 1, "the claim-instant check follows the claim");
  assert(mark > after, script);
  assert(script.includes("-cne (Read-Shared $t)"), "case-exact");
});

// Two more ways the helper ended with no app, or broke the new build: when
// neither version could be moved back it `exit 1`ed (the record still said
// "rolled back"); and `ReadAllText` held the marker without FileShare.Delete,
// so a new build renaming it at that instant failed its write. Run on
// Windows 11; pinned here as text.
Deno.test("swap spec (windows): no move back still starts a copy, and every read lets the app rename the file", () => {
  const spec = _swapSpec("windows", {
    pid: 1,
    current: "C:\\a\\App",
    previous: "C:\\a\\App.old-1",
    staged: "C:\\a\\App.staged",
    launcher: "C:\\a\\App\\run.bat",
    mark: "m",
    token: "t",
    failed: "f",
    waitS: 120,
    args: [],
  }, "");
  const script = decode(spec.args[spec.args.indexOf("-EncodedCommand") + 1]!);
  const lines = script.split("\n").map((l) => l.trim());
  assert(!script.includes("ReadAllText"), "a read that locks out a rename");
  assert(
    script.includes(
      "[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete",
    ),
    script,
  );
  // The swap: the record first, then whichever copy is left.
  assert(
    lines.includes(
      "if ($r -eq 2) { Write-Failed 'the new version could not be moved into place, nor the old one back'; Start-Any; exit 1 }",
    ),
    script,
  );
  // The rollback: both moves back failed is said, and a copy is started.
  assert(
    lines.includes(
      "if ($r -eq 2) { Set-Unrolled 'the old version could not be moved back into place, nor the new one'; exit 1 }",
    ),
    script,
  );
  // A failed move INTO the name is undone at once, before any retry: the
  // name was empty for up to 10 s of retries, and a kill there left no app.
  const swapIn = lines.indexOf("function Swap-In($a, $b, $c) {");
  assert(swapIn >= 0, script);
  assertEquals(lines.slice(swapIn + 1, swapIn + 11), [
    "$r = 1",
    "for ($i = 0; $i -lt 50; $i++) {",
    "if ($i -gt 0) { Start-Sleep -Milliseconds 200 }",
    "try { [IO.Directory]::Move($a, $c) } catch { continue }",
    "$r = 3",
    "try { [IO.Directory]::Move($b, $a); return 0 } catch {}",
    "if (-not (Move-Dir $c $a)) { return 2 }",
    "}",
    "return $r",
    "}",
  ]);
  // Start-Any aims the launcher at the copy it found, the old one first.
  assert(
    script.includes("foreach ($d in @($cur, $prev, $new)) {") &&
      script.includes(
        "{ $script:launch = $d + $launch.Substring($cur.Length) }",
      ),
    script,
  );
});

// The claim is the Move alone: a Delete that throws after the Move succeeded
// (antivirus, a held handle) used to share its `catch { exit 0 }` — the
// updater saw "claimed" and exited, and nothing swapped.
Deno.test("swap spec (windows): the start-file claim is the Move alone; a failed cleanup Delete never ends the swap", () => {
  const spec = _swapSpec("windows", {
    pid: 1,
    current: "C:\\a\\App",
    previous: "C:\\a\\App.old-1",
    staged: "C:\\a\\App.staged",
    launcher: "C:\\a\\App\\run.bat",
    mark: "m",
    token: "t",
    failed: "f",
    waitS: 120,
    args: [],
  }, "");
  const script = decode(spec.args[spec.args.indexOf("-EncodedCommand") + 1]!);
  assert(
    script.includes(
      "if ($go) { try { [IO.File]::Move($go, $go + '.run') } catch { exit 0 }; " +
        "try { [IO.File]::Delete($go + '.run') } catch {} }",
    ),
    script.split("\n").find((l) => l.includes("$go)")),
  );
});

// At the bound only a start file that is GONE means the helper claimed it; a
// removal that fails for any other reason proves nothing, and counting it as
// "claimed" quit the app with no helper running.
Deno.test("swap handoff (windows): an unremovable start file at the bound is NOT a claim", () => {
  let go = "";
  try {
    assertThrows(
      () =>
        spawnSwapHelper("powershell.exe", [], {}, {
          os: "windows",
          claimWaitMs: 100,
          windowless: (_line, env) => {
            // The file stays, and cannot be removed (a non-empty directory).
            go = env.AIO_SWAP_GO!;
            Deno.removeSync(go);
            Deno.mkdirSync(go);
            Deno.writeTextFileSync(`${go}/x`, "");
            return 1;
          },
        }),
      Error,
      "never ran the update helper",
    );
  } finally {
    if (go) Deno.removeSync(go, { recursive: true });
  }
});
