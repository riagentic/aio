// "Home" on Windows is two variables. aio's `homedir()` prefers `%HOME%`; the
// PowerShell installers used `%USERPROFILE%`. With a custom HOME (Git Bash, a
// login script) aio was cloned into one folder and looked for in the other,
// and an app's data lived where Explorer would never show it — with nothing
// saying so. The resolver is NOT changed (that would move existing data): the
// installers follow it, and the mismatch is said — at boot, by `am doctor`,
// and by the installers.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { homeMismatch, homeMismatchNote } from "../src/server/paths.ts";
import { upgradeCommand } from "../src/am/am-cmd-remove.ts";
import { aioHome } from "../src/am/am-cmd-meta.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = join(import.meta.dirname!, "..");
const env = (o: Record<string, string>) => (n: string) => o[n];

Deno.test("home mismatch: only on Windows, only when both are set and name different folders", () => {
  const two = env({ HOME: "C:\\msys\\home\\me", USERPROFILE: "C:\\Users\\me" });
  assertEquals(homeMismatch("windows", two), {
    used: "C:\\msys\\home\\me",
    other: "C:\\Users\\me",
  });
  // The same folder, spelled as Windows allows: not a mismatch.
  for (
    const same of [
      { HOME: "C:\\Users\\me", USERPROFILE: "C:\\Users\\me" },
      { HOME: "c:/users/ME/", USERPROFILE: "C:\\Users\\me" },
      { HOME: "C:\\Users\\me\\", USERPROFILE: "C:\\Users\\me" },
    ]
  ) {
    assertEquals(homeMismatch("windows", env(same)), null, same.HOME);
  }
  assertEquals(homeMismatch("windows", env({ USERPROFILE: "C:\\U" })), null);
  assertEquals(homeMismatch("windows", env({ HOME: "C:\\H" })), null);
  // Elsewhere USERPROFILE means nothing.
  assertEquals(homeMismatch("linux", two), null);
  assertEquals(homeMismatch("darwin", two), null);
});

Deno.test("home mismatch: the sentence names both folders and the one aio uses", () => {
  const note = homeMismatchNote(
    "windows",
    env({ HOME: "D:\\h", USERPROFILE: "C:\\Users\\me" }),
  )!;
  assertStringIncludes(note, "%HOME% (D:\\h)");
  assertStringIncludes(note, "%USERPROFILE% (C:\\Users\\me)");
  assertStringIncludes(note, "aio uses %HOME%");
  // True with a checkout under either: `aioHome` keeps one an older
  // installer cloned under %USERPROFILE%, so the sentence does not place it.
  assertStringIncludes(
    note,
    "so does the aio checkout, unless one is kept at " +
      "C:\\Users\\me\\.local\\lib\\aio",
  );
  assert(!note.includes("the aio checkout and its versions live under"));
  assertEquals(homeMismatchNote("linux", env({ HOME: "/h" })), null);
});

Deno.test("home mismatch: the boot report and am doctor both say it", async () => {
  const server = await Deno.readTextFile(
    join(ROOT, "src/server/aio-server.ts"),
  );
  assert(
    /const note = homeMismatchNote\(\);\s*if \(note\) log\.warn\(note\)/.test(
      server,
    ),
  );
  const doctor = await Deno.readTextFile(join(ROOT, "src/am/am-cmd-doctor.ts"));
  assert(/const home = homeMismatchNote\(\)/.test(doctor));
  assert(doctor.includes("...(home ? [home] : [])"), "the note is not a hint");
});

Deno.test("install.ps1 + run.ps1: aio is installed under the RUNTIME's home (HOME, else USERPROFILE), and the home is printed", async () => {
  for (const script of ["install.ps1", "run.ps1"]) {
    const ps = await Deno.readTextFile(join(ROOT, script));
    const fn = /function Get-AioUserHome\(\) \{([\s\S]*?)\n\}/.exec(ps);
    assert(fn, `${script}: no Get-AioUserHome`);
    // HOME first — the order `homedir()` reads them in.
    assert(
      fn[1]!.indexOf("$env:HOME") >= 0 &&
        fn[1]!.indexOf("$env:HOME") < fn[1]!.indexOf("$env:USERPROFILE"),
      `${script}: HOME must be tried before USERPROFILE`,
    );
    // …for a machine with no checkout yet. One an installer before 1.0.20
    // left under %USERPROFILE% stays THE checkout: asked first.
    assertStringIncludes(
      ps,
      "$AioHome = if ($env:AIO_HOME) { $env:AIO_HOME } else { Get-AioDefaultHome }",
      `${script}: the default aio home`,
    );
    const dflt = /function Get-AioDefaultHome\(\) \{([\s\S]*?)\n\}/.exec(ps);
    assert(dflt, `${script}: no Get-AioDefaultHome`);
    const old = dflt[1]!.indexOf(
      "if (Test-Path -LiteralPath (Join-Path $old '.git')) { return $old }",
    );
    const fresh = dflt[1]!.indexOf(
      "return [System.IO.Path]::Combine((Get-AioUserHome), '.local\\lib\\aio')",
    );
    assert(old > 0 && fresh > old, `${script}: ${dflt[1]}`);
    assertStringIncludes(
      dflt[1]!,
      "$old = Join-Path $env:USERPROFILE '.local\\lib\\aio'",
    );
    assert(
      /\n  Show-AioHome \$AioHome\n/.test(ps),
      `${script}: the home is not printed`,
    );
    assertStringIncludes(ps, "differs from %USERPROFILE%");
    assertStringIncludes(ps, "it is the one used and updated");
    assert(!ps.includes("is NOT the one used"), script);
    // Windows PowerShell 5.1 has no `??`.
    assert(
      !/\?\?/.test(ps.replace(/#.*$/gm, "")),
      `${script}: a PowerShell 7 operator`,
    );
  }
});

// `am update` (is this checkout the canonical install?) and `am upgrade`
// (where is run.sh / run.ps1?) both derive the aio home. With `HOME` alone it
// was `/.local/lib/aio` on a stock Windows, where only USERPROFILE is set.
Deno.test("install.ps1: the header says where aio is cloned by the rule the code uses", async () => {
  const head = (await Deno.readTextFile(join(ROOT, "install.ps1")))
    .split("$ErrorActionPreference")[0]!;
  assert(!head.includes("%USERPROFILE%\\.local\\lib\\aio"), "the old claim");
  assertStringIncludes(head, "<home>\\.local\\lib\\aio");
  assertStringIncludes(head, "%HOME% when that is set");
});

Deno.test("am update + am upgrade: the aio home is the installers' ONE rule — AIO_HOME, a kept %USERPROFILE% checkout, else HOME, else USERPROFILE", async () => {
  const P = "C:\\Users\\me", H = "D:\\h";
  const kept = `${P}/.local/lib/aio`;
  const at = (
    os: string,
    e: Record<string, string>,
    checkouts: string[] = [],
  ) => aioHome(os, env(e), (d) => checkouts.includes(d));
  // A 1.0.19 install (always under %USERPROFILE%) is found, HOME set or not.
  assertEquals(at("windows", { USERPROFILE: P }, [kept]), kept);
  assertEquals(at("windows", { HOME: H, USERPROFILE: P }, [kept]), kept);
  // No checkout there: the runtime's home — HOME first.
  assertEquals(
    at("windows", { HOME: H, USERPROFILE: P }),
    `${H}/.local/lib/aio`,
  );
  assertEquals(at("windows", { USERPROFILE: P }), kept);
  // A checkout under HOME does not send a fresh machine anywhere else.
  assertEquals(
    at("windows", { HOME: H, USERPROFILE: P }, [`${H}/.local/lib/aio`]),
    `${H}/.local/lib/aio`,
  );
  // AIO_HOME wins over everything.
  assertEquals(
    at("windows", { AIO_HOME: "E:\\aio", HOME: H, USERPROFILE: P }, [kept]),
    "E:\\aio",
  );
  // Elsewhere USERPROFILE is never asked first: as before.
  for (const os of ["linux", "darwin"]) {
    assertEquals(
      at(os, { HOME: "/h", USERPROFILE: "/p" }, ["/p/.local/lib/aio"]),
      "/h/.local/lib/aio",
    );
    assertEquals(at(os, { USERPROFILE: "/p" }), "/p/.local/lib/aio");
  }
  // The default probe is the scripts': a `.git` in the folder.
  const dir = await tempDir("aio-home-rule-");
  try {
    const profile = join(dir, "profile");
    const win = (e: Record<string, string>) => aioHome("windows", env(e));
    const both = { HOME: join(dir, "home"), USERPROFILE: profile };
    assertEquals(win(both), `${both.HOME}/.local/lib/aio`);
    await Deno.mkdir(join(profile, ".local/lib/aio/.git"), { recursive: true });
    assertEquals(win(both), `${profile}/.local/lib/aio`);
  } finally {
    await dropTempDir(dir);
  }

  // PARITY: this is `Get-AioDefaultHome`, statement for statement. A change
  // to either script's function is a change to `aioHome` — or a second rule.
  for (const script of ["install.ps1", "run.ps1"]) {
    const ps = await Deno.readTextFile(join(ROOT, script));
    const body = /function Get-AioDefaultHome\(\) \{([\s\S]*?)\n\}/.exec(ps);
    assertEquals(
      body![1]!.split("\n").map((l) => l.trim()).filter(Boolean),
      [
        "if ($env:USERPROFILE) {",
        "$old = Join-Path $env:USERPROFILE '.local\\lib\\aio'",
        "if (Test-Path -LiteralPath (Join-Path $old '.git')) { return $old }",
        "}",
        "return [System.IO.Path]::Combine((Get-AioUserHome), '.local\\lib\\aio')",
      ],
      script,
    );
  }
  // …and both commands ask it, and nothing else.
  for (const file of ["src/am/am-cmd-meta.ts", "src/am/am-cmd-remove.ts"]) {
    const src = await Deno.readTextFile(join(ROOT, file));
    assert(/\baioHome\(\)/.test(src), `${file}: does not ask aioHome()`);
    assertEquals(
      src.split(".local/lib/aio`;").length - 1,
      file.endsWith("meta.ts") ? 2 : 0,
      `${file}: a second place derives the aio home`,
    );
    assert(!src.includes('".local/lib/aio"'), file);
  }
});

Deno.test("am upgrade <app>: run.sh under sh — and on Windows run.ps1 under PowerShell", () => {
  assertEquals(upgradeCommand("/a/run.sh", "https://x/y", false, "linux"), {
    script: "run.sh",
    cmd: "sh",
    args: ["/a/run.sh", "https://x/y", "--no-run"],
  });
  assertEquals(upgradeCommand("/a/run.sh", "/src", true, "darwin").args, [
    "/a/run.sh",
    "--no-run",
  ]);
  const win = upgradeCommand("C:\\a\\run.ps1", "owner/repo", false, "windows");
  assertEquals(win.script, "run.ps1");
  assertEquals(win.cmd, "powershell");
  assertEquals(win.args.slice(-5), [
    "-File",
    "C:\\a\\run.ps1",
    "-NoRun",
    "-Git",
    "owner/repo",
  ]);
  assertEquals(
    upgradeCommand("C:\\a\\run.ps1", "C:\\src", true, "windows").args.slice(-3),
    ["-File", "C:\\a\\run.ps1", "-NoRun"],
  );
});
