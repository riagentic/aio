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
    "for ($i = 0; $i -lt 150 -and @(Get-Running).Count -gt 0; $i++) { Start-Sleep -Milliseconds 200 }",
    pid,
  );
  // An earlier copy under the old version's name goes first; one that
  // cannot go ends the swap there, with what Windows said.
  const cleared = at(
    "if (Test-There $prev) { Write-Failed ('an earlier copy of the app (' + $prev + ') could not be removed: ' + $script:held); Remove-Dir $new; Start-App; exit 1 }",
    at("if (Test-There $prev) { Remove-Dir $prev }", drain),
  );
  const aside = at("$r = Swap-In $cur $new $prev 150", cleared);
  at(
    "if ($r -eq 1) { Write-Failed ('the running version could not be moved aside' + (Get-Held)); Remove-Dir $new; Start-App; exit 1 }",
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
    at("$r = Swap-In $cur $prev $new 50", stop),
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
  const swapIn = lines.indexOf("function Swap-In($a, $b, $c, $tries) {");
  assert(swapIn >= 0, script);
  assertEquals(lines.slice(swapIn + 1, swapIn + 11), [
    "$r = 1",
    "for ($i = 0; $i -lt $tries; $i++) {",
    "if ($i -gt 0) { Start-Sleep -Milliseconds 200 }",
    "try { [IO.Directory]::Move($a, $c) } catch { $script:held = $_.Exception.GetBaseException().Message; continue }",
    "$r = 3",
    "try { [IO.Directory]::Move($b, $a); return 0 } catch { $script:held = $_.Exception.GetBaseException().Message }",
    "if (-not (Move-Dir $c $a)) { return 2 }",
    "}",
    "return $r",
    "}",
  ]);
  // Start-Any aims the launcher at the copy it found, the old one first —
  // handed to Start-App as an argument, never through a scope: run through
  // the cmd.exe bootstrap the script is a child scope, where `$script:launch`
  // set a variable Start-App did not read.
  assert(
    script.includes("foreach ($d in @($cur, $prev, $new)) {") &&
      script.includes(
        "{ $l = $d + $launch.Substring($cur.Length) }\n    Start-App $l; return",
      ) &&
      script.includes(
        "function Start-App($l) {\n  if (-not $l) { $l = $launch }",
      ) && !script.includes("$script:launch"),
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

// Measured on Windows 11: a process that only had its working directory in
// the install (no executable under it) was on no list the helper waited for,
// the move was retried for 10 s and given up, the old version came back, and
// the 434 MB staged tree stayed. The wait is for the FOLDER now — the move
// aside is retried for 30 s — and a swap that is given up says what Windows
// said and which processes are in the way, and removes what it staged.
Deno.test("swap spec (windows): a held install is waited for, and a swap given up says why and leaves no staged tree", () => {
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
  // 150 × 200 ms for the swap in; the rollback keeps its 10 s.
  assert(lines.includes("for ($i = 0; $i -lt $tries; $i++) {"), script);
  assert(lines.includes("$r = Swap-In $cur $new $prev 150"), script);
  assert(lines.includes("$r = Swap-In $cur $prev $new 50"), script);
  // Given up: the record (why, with what held it), the staged tree removed,
  // THEN the old version started — never a start before the cleanup.
  assert(
    lines.includes(
      "if ($r -eq 1) { Write-Failed ('the running version could not be moved aside' + (Get-Held)); Remove-Dir $new; Start-App; exit 1 }",
    ),
    script,
  );
  // What the move said is kept from the last refusal…
  assertEquals(
    lines.filter((l) =>
      l.includes("$script:held = $_.Exception.GetBaseException().Message")
    ).length,
    3, // the two moves, and a removal that failed
  );
  // …and read back under the same name (a bare `$held` in a function is a
  // local: it would always be empty).
  assert(lines.includes("if (-not $script:held) { return '' }"), script);
  assert(
    lines.includes("return ' after 30 s (' + $script:held + ' ' + $who + ')'"),
    script,
  );
  assertEquals(script.match(/\$held\b/g), null, "a local $held");
  // Processes are named by executable under the install OR its path on
  // their command line, as an array (one match has no .Count otherwise).
  assert(
    script.includes(
      "$n = @(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($cur + '\\', [StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($cur, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { $_.Name + ' (pid ' + $_.ProcessId + ')' })",
    ),
    script,
  );
  // The reason is Windows' own text — a path, quotes — inside a JSON string:
  // backslash first, then the quote, then control characters.
  assert(
    lines.includes(
      `function Get-JsonText($s) { (($s -replace '\\\\', '\\\\') -replace '"', '\\"') -replace '[\\x00-\\x1f]', ' ' }`,
    ),
    script,
  );
  assert(
    script.includes(`'  "swapFailed": "' + (Get-JsonText $why) + '",'`),
    script,
  );
  // CreateProcessW takes at most 32767 characters, and the script rides on
  // the command line.
  const line = [spec.cmd, ...spec.args].join(" ");
  assert(line.length < 32767, `${line.length} characters`);
});

/** The helper's script for an ordinary install, as lines. */
function helperLines(): string[] {
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
  return decode(spec.args[spec.args.indexOf("-EncodedCommand") + 1]!)
    .split("\n").map((l) => l.trim());
}

// `Remove-Item -Recurse` on Windows PowerShell 5.1 goes THROUGH a junction or
// a symbolic link to a folder and deletes what it points at. The helper
// removes two trees (the earlier copy, the staged one): a link inside either
// — a junction to the user's documents in an old install — took the target's
// contents with it.
Deno.test("swap spec (windows): a tree is removed without following a link in it", () => {
  const lines = helperLines();
  const code = lines.filter((l) => !l.startsWith("#"));
  assertEquals(code.filter((l) => /-Recurse\b/.test(l)), []);
  const at = lines.indexOf("function Remove-Tree($d) {");
  assert(at >= 0, lines.join("\n"));
  assertEquals(lines.slice(at + 1, at + 10), [
    "if ([IO.File]::Exists($d)) { [IO.File]::SetAttributes($d, 'Normal'); [IO.File]::Delete($d); return }",
    "$i = New-Object IO.DirectoryInfo($d)",
    "if (-not $i.Exists) { return }",
    // Only a real folder is looked into; a link is deleted as the link.
    "if (-not ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) {",
    "foreach ($e in $i.GetFileSystemInfos()) { Remove-Tree $e.FullName }",
    "$i.Attributes = 'Directory'",
    "}",
    "$i.Delete()",
    "}",
  ]);
  // The one caller: a failure is kept as the reason, never thrown.
  assert(
    lines.includes(
      "function Remove-Dir($d) { try { Remove-Tree $d } catch { $script:held = $_.Exception.GetBaseException().Message } }",
    ),
  );
  assertEquals(
    code.filter((l) => /\bRemove-Tree\b/.test(l)).length,
    3, // its definition, its recursion, Remove-Dir
  );
});

// An error the script does not expect (a path Windows refuses to look at
// under `$ErrorActionPreference = 'Stop'`) ended it where it stood: after
// the app had exited and before anything was started again.
Deno.test("swap spec (windows): no way out of the helper leaves no app started", () => {
  const lines = helperLines();
  // Everything after the start-file claim runs inside one try, and its catch
  // starts a copy unless one was started.
  const open = lines.indexOf("try {");
  assertEquals(lines[open - 1], "$script:started = $false");
  assertEquals(
    lines.slice(-5),
    [
      "} catch {",
      "if (-not $script:started) { try { Start-Any } catch {} }",
      "exit 1",
      "}",
    ].concat(""),
  );
  assert(
    lines.includes("$script:started = $true"),
    "Start-App does not say it started one",
  );
  // The new version is running from the plain `Start-App` to the moment the
  // helper stops it; outside that window every `exit` comes after a start on
  // its own line.
  const running = lines.indexOf("Start-App", open);
  const stopping = lines.indexOf("$script:started = $false", running);
  assert(running > open && stopping > running, "the watchdog moved");
  assert(
    lines[stopping + 1]!.startsWith("for (") &&
      lines[stopping + 4]!.includes("Stop-Process"),
    "the flag is not dropped where the new version is stopped",
  );
  const exits = lines.map((l, i) => [l, i] as const)
    .filter(([l]) => /\bexit\b/.test(l) && !l.startsWith("#"));
  // The claim of the start file (the app is still up), the three give-ups,
  // the earlier copy, no token, the watchdog's three, the claim race, the
  // three failed rollbacks, the catch.
  assertEquals(exits.length, 14);
  const bare = exits.filter(([l, i]) =>
    !(i > running && i < stopping) &&
    !/\b(Start-App|Start-Any|Set-Unrolled)\b.*\bexit\b/.test(l)
  ).map(([l]) => l);
  assertEquals(bare, [
    "if ($go) { try { [IO.File]::Move($go, $go + '.run') } catch { exit 0 }; try { [IO.File]::Delete($go + '.run') } catch {} }",
    "exit 1", // the catch: the line above it starts one
  ]);
  // Nothing that can throw under 'Stop' is asked about a path: the .NET
  // tests answer false instead.
  assertEquals(lines.filter((l) => /\bTest-Path\b/.test(l)), []);
});

// The list of who holds the install is every process found, to a bound.
Deno.test("swap spec (windows): every process found holding the install is named, to a bound", () => {
  const lines = helperLines();
  const at = lines.indexOf("if ($n.Count -gt 0) {");
  assert(at >= 0, lines.join("\n"));
  assertEquals(lines.slice(at + 1, at + 5), [
    "$who = 'still running from it or started with its path: ' + (@($n | Select-Object -First 8) -join ', ')",
    "if ($n.Count -gt 8) { $who = $who + ' and ' + ($n.Count - 8) + ' more' }",
    "$who = $who + ' - a program whose working directory is inside it holds it too, and is on no list'",
    "}",
  ]);
});
