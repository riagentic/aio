// A `server` target built for macOS or Windows used to get one log line —
// "no systemd unit … systemd is Linux-only" — and nothing to run it under.
// It gets the supervisor file its OS has now, with the systemd unit's
// contract: `AIO_SUPERVISED=1`, started again after any exit but 143, the
// same runtime flags from the same decider, the same stable default port.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  LAUNCHD_LOOP,
  launchdPlist,
  serviceExecFlags,
  windowsTaskScript,
  writeServiceFile,
} from "../src/build/build-compile.ts";
import { DEFAULT_PORT_ENV } from "../src/server/aio-cli.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const FLAGS = serviceExecFlags({ doRemote: true, doHeadless: true });
const base = { binaryName: "svc", title: "Svc", flags: FLAGS };

/** The `<string>` values of a plist `<array>`, unescaped. */
function programArguments(plist: string): string[] {
  const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/
    .exec(plist)![1]!;
  return [...arr.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    m[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll(
      "&amp;",
      "&",
    )
  );
}

Deno.test("launchd plist: the systemd unit's contract, in launchd's terms", () => {
  const plist = launchdPlist({ ...base, defaultPort: 3000 });
  const args = programArguments(plist);
  // The job is the loop; the binary and ITS flags are the loop's arguments —
  // the same flags the systemd unit's ExecStart carries.
  assertEquals(args.slice(0, 2), ["/bin/sh", "-c"]);
  assertEquals(args[2], LAUNCHD_LOOP);
  assertEquals(args.slice(4), [
    "/usr/local/bin/svc",
    "--expose",
    "--client=server-only",
  ]);
  assert(
    /<key>AIO_SUPERVISED<\/key>\s*<string>1<\/string>/.test(plist),
    "AIO_SUPERVISED=1 is missing",
  );
  // New in 1.0.20, so it can ask for the stop that holds from its first day.
  assert(
    /<key>AIO_STOP_STAYS_DOWN<\/key>\s*<string>1<\/string>/.test(plist),
    "am stop would exit 0 and the loop would start the app again",
  );
  assert(
    new RegExp(`<key>${DEFAULT_PORT_ENV}</key>\\s*<string>3000</string>`)
      .test(plist),
    "the stable default port is missing",
  );
  // launchd restarts the LOOP only when it died; the loop decides about the app.
  assert(
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/
      .test(plist),
  );
  assert(/<key>RunAtLoad<\/key>\s*<true\/>/.test(plist));
  assertStringIncludes(plist, "<string>app.aio.svc</string>");
  // A pinned port is a flag, and then no default is set — as in the unit.
  const pinned = launchdPlist({
    ...base,
    flags: serviceExecFlags({ doRemote: false, doHeadless: true, port: 8443 }),
  });
  assert(!pinned.includes(DEFAULT_PORT_ENV));
  assertEquals(programArguments(pinned).slice(4), [
    "/usr/local/bin/svc",
    "--port=8443",
    "--client=server-only",
  ]);
});

Deno.test("launchd plist: well-formed whatever the title holds", () => {
  const plist = launchdPlist({
    ...base,
    title: `A & B <i>"x"</i> -- \u0007 --> done`,
  });
  // Nothing of the title may close the comment or open an element.
  const comment = /<!--([\s\S]*?)-->/.exec(plist.slice(plist.indexOf("<!--")))!;
  assert(!comment[1]!.includes("--"), "a `--` inside an XML comment");
  assert(!/<i>/.test(plist));
  assertEquals(plist.match(/<plist /g)?.length, 1);
  assert(plist.trimEnd().endsWith("</plist>"));
  // The loop's `&` and `>` are escaped in the file and come back whole.
  assert(!/<string>[^<]*&(?!amp;|lt;|gt;)/.test(plist), "a bare & in a string");
  assertEquals(programArguments(plist)[2], LAUNCHD_LOOP);
});

/** Run the launchd loop under a real `sh` with a stand-in program. */
async function runLoop(
  program: string,
  opts: { termAfterLine?: string } = {},
): Promise<{ code: number; out: string }> {
  const dir = await tempDir("aio-launchd-loop-");
  try {
    const bin = join(dir, "app");
    await Deno.writeTextFile(bin, `#!/bin/sh\n${program}\n`);
    await Deno.chmod(bin, 0o755);
    // `sleep 5` between restarts is the plist's ThrottleInterval twin; a test
    // must not wait for it, and must not change what the loop decides.
    const loop = LAUNCHD_LOOP.replace("sleep 5", "sleep 0");
    assert(loop !== LAUNCHD_LOOP);
    const p = new Deno.Command("/bin/sh", {
      args: ["-c", loop, "aio-supervise", bin, join(dir, "count")],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    // A loop that never ends is a FAILED test (its exit code is the kill's),
    // not a hung one — and the app it started goes too: alive, it held the
    // pipe open and the read below waited forever (a suite hung 90 min).
    const bound = setTimeout(() => {
      p.kill("SIGKILL");
      new Deno.Command("pkill", { args: ["-KILL", "-f", bin] }).outputSync();
    }, 10_000);
    let out = "";
    const dec = new TextDecoder();
    const reader = p.stdout.getReader();
    let sent = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += dec.decode(value);
        if (opts.termAfterLine && !sent && out.includes(opts.termAfterLine)) {
          sent = true;
          p.kill("SIGTERM");
        }
      }
      await p.stderr.cancel();
      return { code: (await p.status).code, out };
    } finally {
      clearTimeout(bound);
    }
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "launchd loop: exit 0 and a crash start the app again; 143 ends the loop with 0",
  ignore: Deno.build.os === "windows", // the loop is /bin/sh text for macOS
  async fn() {
    // Run 1 exits 0 (an update), run 2 crashes, run 3 is stopped (143).
    const r = await runLoop(
      `n=$(cat "$1" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$1"; echo "run $n"
case $n in 1) exit 0;; 2) exit 7;; *) exit 143;; esac`,
    );
    assertEquals(r.out.trim().split("\n"), ["run 1", "run 2", "run 3"]);
    assertEquals(r.code, 0, "the loop must END CLEAN on 143");
  },
});

Deno.test({
  name:
    "launchd loop: SIGTERM (launchctl bootout) reaches the app, is waited for, and is not followed by a restart",
  ignore: Deno.build.os === "windows", // the loop is /bin/sh text for macOS
  async fn() {
    // The app's clean stop takes a moment and exits 0 — the code that, from
    // the app alone, means "start me again".
    const r = await runLoop(
      `trap 'echo stopping; sleep 0.3; echo flushed; exit 0' TERM
echo up
while :; do sleep 0.05; done`,
      { termAfterLine: "up" },
    );
    assertEquals(r.out.trim().split("\n"), ["up", "stopping", "flushed"]);
    assertEquals(r.code, 0);
  },
});

Deno.test("windows task script: the loop honours 143 and AIO_SUPERVISED, with the unit's flags", () => {
  const ps = windowsTaskScript({ ...base, defaultPort: 3000 });
  assertStringIncludes(ps, "$env:AIO_SUPERVISED = '1'");
  assertStringIncludes(ps, "$env:AIO_STOP_STAYS_DOWN = '1'");
  assertStringIncludes(ps, `$env:${DEFAULT_PORT_ENV} = '3000'`);
  assertStringIncludes(ps, "& $Exe '--expose' '--client=server-only'");
  assertStringIncludes(ps, "if ($code -ne 143) { Start-Sleep -Seconds 5 }");
  assertStringIncludes(ps, "} while ($code -ne 143)");
  // The supervised env is set BEFORE the app starts, and only on the loop's
  // path — never while installing.
  assert(ps.indexOf("$env:AIO_SUPERVISED") > ps.indexOf("if ($Install)"));
  assert(ps.indexOf("$env:AIO_SUPERVISED") < ps.indexOf("& $Exe"));
  // The settings without which a task dies after three days.
  assertStringIncludes(ps, "-ExecutionTimeLimit 0");
  assertStringIncludes(ps, "-AtLogOn");
  // Windows PowerShell 5.1: no operator it does not have, ASCII only (the
  // title aside), no POSIX line continuation.
  assert(!/\?\?|&&|\|\|/.test(ps), "a PowerShell 7 operator");
  const lines = ps.split("\n");
  assert(lines.length > 20, "the script is not a script");
  for (const line of lines) {
    assert(!/\\\s*$/.test(line), `a line ends in a backslash: ${line}`);
  }
  // deno-lint-ignore no-control-regex
  assert(/^[\x00-\x7f]*$/.test(ps), "non-ASCII text in the script body");
  const pinned = windowsTaskScript({
    ...base,
    flags: serviceExecFlags({ doRemote: false, doHeadless: true, port: 8443 }),
  });
  assert(!pinned.includes(DEFAULT_PORT_ENV));
  assertStringIncludes(pinned, "& $Exe '--port=8443' '--client=server-only'");
});

// The template is a JS template literal: `\${name}` there is an escaped `$`
// and `\p`, `\t` are escapes — the script said `'Programs${name}${name}.exe'`
// and its install line held a TAB, so `-Install` without `-Exe` never found
// the program.
Deno.test("windows task script: the default -Exe is where run.ps1 installs, and the usage lines are real paths", () => {
  const ps = windowsTaskScript({ ...base, defaultPort: 3000 });
  const n = base.binaryName;
  assertStringIncludes(
    ps,
    `[string]$Exe = (Join-Path $env:LOCALAPPDATA 'Programs\\${n}\\${n}.exe')`,
  );
  assertStringIncludes(
    ps,
    `#   powershell -ExecutionPolicy Bypass -File .\\${n}.ps1 -Install -Exe C:\\path\\to\\${n}.exe\n`,
  );
  assertStringIncludes(
    ps,
    `# Remove it: powershell -ExecutionPolicy Bypass -File .\\${n}.ps1 -Uninstall\n`,
  );
  assert(!ps.includes("${"), "a template placeholder reached the script");
  assert(!ps.includes("\t"), "a TAB in the script");
});

// Generated scripts are PARSED by the shell that runs them, and run.
Deno.test({
  name:
    "windows task script (run under Windows PowerShell): it parses, and -Install without -Exe looks in Programs\\<name>",
  ignore: Deno.build.os !== "windows", // Windows PowerShell is the subject
  async fn() {
    const dir = await tempDir("aio-task-script-");
    try {
      const n = base.binaryName;
      const file = join(dir, `${n}.ps1`);
      // As the build writes it: with a BOM, so PowerShell 5 reads UTF-8.
      await Deno.writeTextFile(
        file,
        "\uFEFF" + windowsTaskScript({ ...base, defaultPort: 3000 }),
      );
      const ps = (args: string[]) =>
        new Deno.Command("powershell", {
          args: ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args],
          env: { LOCALAPPDATA: dir },
          stdout: "piped",
          stderr: "piped",
        }).output();
      const parse = await ps([
        "-Command",
        "$e = $null; [void][System.Management.Automation.Language.Parser]::" +
        "ParseFile($env:AIO_T, [ref]$null, [ref]$e); $e | % { $_.Message }; " +
        "exit $e.Count",
      ].map((a) => a.replace("$env:AIO_T", `'${file}'`)));
      assertEquals(
        [parse.code, new TextDecoder().decode(parse.stdout).trim()],
        [0, ""],
      );
      const r = await ps(["-File", file, "-Install"]);
      const said = new TextDecoder().decode(r.stdout);
      assertEquals(r.code, 1, said);
      assertStringIncludes(
        said,
        `no program at ${join(dir, "Programs", n, `${n}.exe`)} `,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test("windows task script: a title cannot leave its quotes or its comment line", () => {
  const ps = windowsTaskScript({
    ...base,
    title: "It's\n$(Remove-Item x) `n",
  });
  // One comment line, and one single-quoted literal with the quote doubled.
  assertEquals(
    ps.split("\n")[0],
    "# It's $(Remove-Item x) `n (aio): keeps the server running under Windows Task Scheduler.",
  );
  assertStringIncludes(ps, "-Description 'It''s $(Remove-Item x) `n (aio)'");
});

Deno.test("build: a macOS server target gets <artifact>.plist, a Windows one <artifact>.ps1 — and no .service", async () => {
  const dir = await tempDir("aio-supervisor-files-");
  try {
    const cfg = (os: string, platform: string) =>
      ({
        binaryName: "svc",
        appTitle: "Svc",
        outDir: dir,
        root: dir,
        doRemote: true,
        doHeadless: true,
        os,
        platform,
      }) as unknown as Parameters<typeof writeServiceFile>[0];
    await writeServiceFile(cfg("darwin", "macos-arm64"));
    await writeServiceFile(cfg("windows", "windows-x64"));
    const names = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(names.filter((n) => n.endsWith(".service")), []);
    const plistName = names.find((n) => n.endsWith(".plist"))!;
    const psName = names.find((n) => n.endsWith(".ps1"))!;
    // Named like the binary each runs, as the unit is.
    assert(/^svc(-macos-arm64)?\.plist$/.test(plistName), plistName);
    assert(/^svc(-windows-x64)?\.ps1$/.test(psName), psName);
    assertEquals(names.length, 2);
    const plist = Deno.readTextFileSync(join(dir, plistName));
    assertEquals(plist, launchdPlist({ ...base, defaultPort: 3000 }));
    // …and macOS itself, where there is one, agrees it is a property list —
    // with a title that needs every escape.
    if (Deno.build.os === "darwin") {
      const hard = join(dir, "hard.plist");
      Deno.writeTextFileSync(
        hard,
        launchdPlist({ ...base, title: `A & B <i>"x"</i> -- --> é` }),
      );
      for (const f of [join(dir, plistName), hard]) {
        const o = await new Deno.Command("plutil", {
          args: ["-lint", f],
          stdout: "piped",
          stderr: "piped",
        }).output();
        const said = new TextDecoder().decode(o.stdout) +
          new TextDecoder().decode(o.stderr);
        assertEquals(o.code, 0, said);
        assertStringIncludes(said, "OK");
      }
      // What launchd will run, read back by the system's own parser.
      const o = await new Deno.Command("plutil", {
        args: ["-extract", "ProgramArguments.2", "raw", "-o", "-", hard],
        stdout: "piped",
      }).output();
      assertEquals(new TextDecoder().decode(o.stdout).trimEnd(), LAUNCHD_LOOP);
    }
    const ps = Deno.readTextFileSync(join(dir, psName));
    // A BOM, so Windows PowerShell 5.1 reads a non-ASCII title as UTF-8.
    assertEquals(ps.charCodeAt(0), 0xfeff);
    assertEquals(
      ps.slice(1),
      windowsTaskScript({ ...base, defaultPort: 3000 }),
    );
  } finally {
    await dropTempDir(dir);
  }
});

// The systemd unit is the one supervisor file 1.0.19 already wrote, and
// services run under installed copies of it: what it asks of the app is a
// contract. `am stop` there exits 0 and `Restart=always` brings the app back
// (tests/am-stop-supervised.test.ts) — so the unit must not turn on the stop
// that holds; it only says how.
Deno.test("build: the systemd unit keeps the 1.0.19 contract — AIO_SUPERVISED=1, Restart=always, 143 stays down — and offers AIO_STOP_STAYS_DOWN as a comment", async () => {
  const dir = await tempDir("aio-supervisor-unit-");
  try {
    await writeServiceFile(
      {
        binaryName: "svc",
        appTitle: "Svc",
        outDir: dir,
        root: dir,
        doRemote: true,
        doHeadless: true,
        os: "linux",
        platform: "linux-x64",
      } as unknown as Parameters<typeof writeServiceFile>[0],
    );
    const name = [...Deno.readDirSync(dir)].map((e) => e.name)
      .find((n) => n.endsWith(".service"))!;
    const lines = Deno.readTextFileSync(join(dir, name)).split("\n");
    for (
      const kept of [
        "Restart=always",
        "RestartPreventExitStatus=143",
        "Environment=AIO_SUPERVISED=1",
      ]
    ) assert(lines.includes(kept), `the unit lost "${kept}"`);
    assert(lines.includes("#Environment=AIO_STOP_STAYS_DOWN=1"));
    assert(
      !lines.some((l) => /^\s*Environment=.*AIO_STOP_STAYS_DOWN/.test(l)),
      "the unit turned the switch on: `am stop` no longer comes back",
    );
  } finally {
    await dropTempDir(dir);
  }
});
