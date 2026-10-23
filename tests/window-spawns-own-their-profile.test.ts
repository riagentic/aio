// A test that starts an app WITH A WINDOW gives it an account of its own.
//
// An app started with `--client=electron` writes its window's main script
// into the window's PROFILE directory, and a real Electron keeps a whole
// Chromium profile there: `~/.config/<name>` on Linux, `~/Library/Application
// Support/<name>` on macOS, `%APPDATA%\<name>` on Windows. `AIO_APPS_DIR` — the
// sandbox every test task sets — moves none of it, and a stand-in Electron
// (`$ELECTRON_PATH`) changes nothing: the script is written before anything
// is launched. MEASURED 2026-10-10: 178 `~/.config/aio-app@<hash>` and 73
// `app-<id>@<hash>` on one workstation, written by test files that spread the
// developer's own environment into such a launch — and, from the tests that
// start the Electron binary itself, real profiles (`~/.config/Electron`,
// `ipc-test`, `reload-cfg-e2e`, …) rewritten by every suite run.
//
// `check:home-clean` and the suite runner name such a leak after it happened.
// This refuses the test file that would make it: one that launches a window
// and takes the child's environment from none of the helpers that give it an
// account — nor is listed below with what makes it safe.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const TESTS = fromFileUrl(new URL(".", import.meta.url));

/** The forms a window launch takes in a test: the client flag as an argument
 *  of its own, an Electron named for the launcher, the launcher called in this
 *  process, the Electron binary started directly (`ELECTRON_BIN`, the name
 *  every such test gives it). */
const LAUNCH = [
  /["'`]--client=electron["'`]/,
  /\bELECTRON_PATH\s*:|\.set\(\s*"ELECTRON_PATH"/,
  /\b(launchElectron|spawnElectron)\(/,
  /\bELECTRON_BIN\b/,
];

/** …and it starts something at all. */
const STARTS = /new Deno\.Command\(|\b(launchElectron|spawnElectron)\(/;

/** The helpers that give a launch its own account: `childEnv()` (a child's
 *  whole floor), `accountEnv()` (the account alone, for a cleared env),
 *  `ownAccount()` (this process, for an in-process launch) — all in
 *  tests/e2e-app-harness.ts — and `ownHome()` (an installer's HOME). */
const HELPER = /\b(childEnv|accountEnv|ownAccount|ownHome)\(/;

/** Files with a launch form and NO helper, each with what makes that safe:
 *  text that must be in it (`has`) and launch forms that must stay out of it
 *  (`never`). Both are checked, so an entry cannot outlive its reason. */
const SAFE: Record<string, { why: string; has?: RegExp[]; never?: RegExp[] }> =
  {
    "am-build-unified.test.ts": {
      why: "the flag is data handed to pure planners; the one spawn is `am`",
      has: [/planTask\("dev", \["--client=electron"/],
      never: [LAUNCH[1]!, LAUNCH[2]!],
    },
    "am-onboard.test.ts": {
      why: "the flag is read out of a scaffolded deno.json, never run",
      has: [
        /assertStringIncludes\(tasks\("electron"\)\.dev!, "--client=electron"\)/,
      ],
      never: [LAUNCH[1]!, LAUNCH[2]!],
    },
    "am-surface-no-ui-app.test.ts": {
      why: "the flag is text the reply must NOT contain, never run",
      has: [/assert\(!r\.text\.includes\("--client=electron"\), r\.text\)/],
      never: [LAUNCH[1]!, LAUNCH[2]!],
    },
    "one-vocabulary.test.ts": {
      why: "the flag is read out of a scaffolded deno.json, never run",
      has: [
        /assertStringIncludes\(cfg\.tasks\["dev"\]!, "--client=electron"\)/,
      ],
      never: [LAUNCH[1]!, LAUNCH[2]!],
    },
    "update-confirm-after-app-onstart.test.ts": {
      why: "the flag is an argument list handed to the pure `replayArgs`",
      has: [/replayArgs\(\["--client=electron"/],
      never: [LAUNCH[1]!, LAUNCH[2]!],
    },
    "updates-e2e.test.ts": {
      why: "the flag is the argv of a relaunch PLAN that is asserted, not run",
      has: [/argv: \["--client=electron"\]/],
      never: [LAUNCH[1]!, LAUNCH[2]!],
    },
    "electron-runtime-fetch.test.ts": {
      why: "resolves which Electron would run; launches none",
      never: [LAUNCH[0]!, LAUNCH[2]!],
    },
    "electron-shared-store-hygiene.test.ts": {
      why: "the AppRun it starts runs a fake app that only echoes its env",
      has: [/`#!\/bin\/sh\\necho "EP=\\\$\{ELECTRON_PATH-unset\}/],
      never: [LAUNCH[0]!, LAUNCH[2]!],
    },
    "electron-main-script-litter.test.ts": {
      why: "its own `inHome()` points every profile parent into a temp dir",
      has: [
        /Deno\.env\.set\("HOME", dir\)/,
        /Deno\.env\.set\("XDG_CONFIG_HOME", join\(dir, "\.config"\)\)/,
        /Deno\.env\.set\("APPDATA", join\(dir, "AppData"\)\)/,
      ],
    },
  };

/** Source with its comment lines dropped: a file that only TALKS about a
 *  launch is not one. */
const code = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** THE scan: the files that launch a window (`launching`), and those of them
 *  with neither a helper nor a SAFE entry whose reasons still hold
 *  (`offenders`). Pure. */
function scan(
  files: { name: string; src: string }[],
  safeList: typeof SAFE = SAFE,
): { launching: string[]; offenders: string[] } {
  const launching: string[] = [];
  const offenders: string[] = [];
  for (const { name, src } of files) {
    const c = code(src);
    if (!STARTS.test(c) || !LAUNCH.some((re) => re.test(c))) continue;
    launching.push(name);
    if (HELPER.test(c)) continue;
    const safe = safeList[name];
    if (!safe) offenders.push(name);
    else if (
      !(safe.has ?? []).every((re) => re.test(c)) ||
      (safe.never ?? []).some((re) => re.test(c))
    ) {
      offenders.push(
        `${name} (listed as safe — "${safe.why}" — but that no longer holds)`,
      );
    }
  }
  return { launching, offenders };
}

Deno.test("tests: a file that launches a window takes the child's account from childEnv() / accountEnv() / ownAccount()", async () => {
  const files: { name: string; src: string }[] = [];
  for await (const e of Deno.readDir(TESTS)) {
    if (!e.isFile || !/\.tsx?$/.test(e.name)) continue;
    if (e.name === "window-spawns-own-their-profile.test.ts") continue;
    files.push({
      name: e.name,
      src: await Deno.readTextFile(join(TESTS, e.name)),
    });
  }
  const { launching, offenders } = scan(files);
  assert(launching.length >= 20, `the scan found only ${launching.join(", ")}`);
  assertEquals(
    offenders,
    [],
    "these test files launch an app with a window (`--client=electron`, " +
      "`$ELECTRON_PATH`, `launchElectron()`) without an account of its own, " +
      "so the window's profile is written into the developer's real one. " +
      "Wrap the child's env in `childEnv({ … })` (tests/e2e-app-harness.ts); " +
      "under `clearEnv` spread `...accountEnv()` last; for an in-process " +
      "launch, `using _home = ownAccount();` — or list the file in SAFE with " +
      "the text that proves it cannot write there",
  );
  // A listed file that no longer has a launch form is a stale exemption.
  assertEquals(Object.keys(SAFE).filter((f) => !launching.includes(f)), []);
});

// The control: the scan above is green today, and a scan that can only be
// green proves nothing. These are the files it exists to refuse.
Deno.test("tests: the window scan REFUSES each launch form without a helper, and a SAFE entry whose reason is gone", () => {
  const spawn = (env: string, arg = `"--client=electron"`) =>
    `await new Deno.Command(Deno.execPath(), {\n` +
    `  args: ["run", "-A", "app.ts", ${arg}],\n  env: ${env},\n}).output();\n`;
  const safe = {
    "data.test.ts": { why: "data", has: [/plan\(\[/], never: [LAUNCH[1]!] },
    "rotted.test.ts": { why: "data", has: [/plan\(\[/] },
    "grew.test.ts": { why: "data", never: [LAUNCH[1]!] },
  };
  const { launching, offenders } = scan([
    // The 2026-10-10 shape: the developer's env, HOME and all, into a launch.
    { name: "leaks.test.ts", src: spawn("{ ...Deno.env.toObject() }") },
    // A stand-in Electron is still a launch: the script is written first.
    {
      name: "stub.test.ts",
      src: spawn("{ ELECTRON_PATH: fake, AIO_APPS_DIR: apps }", `"--port=1"`),
    },
    // The binary itself: a REAL window, and a whole Chromium profile.
    {
      name: "binary.test.ts",
      src:
        `new Deno.Command(ELECTRON_BIN, { env: { ...testDisplayEnv() } });\n`,
    },
    // In this process.
    {
      name: "inproc.test.ts",
      src: `const p = await launchElectron("http://127.0.0.1:1/", log);\n`,
    },
    { name: "owns.test.ts", src: spawn("childEnv({ ELECTRON_PATH: fake })") },
    {
      name: "cleared.test.ts",
      src: spawn("{ PATH, ELECTRON_PATH: bin, ...accountEnv() }"),
    },
    {
      name: "inproc-owns.test.ts",
      src: `using _home = ownAccount();\nawait launchElectron(url, log);\n`,
    },
    {
      name: "data.test.ts",
      src: `plan(["--client=electron"]);\nnew Deno.Command("git");\n`,
    },
    // Listed, and the text that made it safe is gone.
    { name: "rotted.test.ts", src: spawn("{}") },
    // Listed as never naming an Electron — and now it does.
    { name: "grew.test.ts", src: spawn("{ ELECTRON_PATH: fake }") },
    // Talks about a launch in a comment; starts nothing with a window.
    {
      name: "talks.test.ts",
      src: `// run with "--client=electron"\nnew Deno.Command("git");\n`,
    },
    // The flag as text, and nothing started at all.
    { name: "text.test.ts", src: `assertEquals(f, "--client=electron");\n` },
  ], safe);
  assertEquals(launching, [
    "leaks.test.ts",
    "stub.test.ts",
    "binary.test.ts",
    "inproc.test.ts",
    "owns.test.ts",
    "cleared.test.ts",
    "inproc-owns.test.ts",
    "data.test.ts",
    "rotted.test.ts",
    "grew.test.ts",
  ]);
  assertEquals(offenders, [
    "leaks.test.ts",
    "stub.test.ts",
    "binary.test.ts",
    "inproc.test.ts",
    'rotted.test.ts (listed as safe — "data" — but that no longer holds)',
    'grew.test.ts (listed as safe — "data" — but that no longer holds)',
  ]);
});
