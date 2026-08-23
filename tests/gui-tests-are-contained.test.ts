// A test run must not touch the developer's desktop.
//
// The complaint this exists to make impossible, in the words it was reported
// in: "multiple instances are running and often browser instances, so not only
// unwanted instances are running but even multiple instances, and I cannot run
// my own before killing these zombies" — plus "many times I have 10 stacked
// tabs of the same app left".
//
// Three separate mechanisms produced that, and each is guarded here:
//
//  ① a test spawns a GUI (Electron, Chromium) with the developer's own DISPLAY
//    inherited, so the window opens on their desktop and takes focus — on every
//    run, and on every retry within a run;
//  ② a spawned app hands its URL to `xdg-open`, which reaches the REAL browser.
//    That tab is not aio's process and cannot be closed by it, so they stack;
//  ③ an Electron app whose Electron is missing used to fall back to opening a
//    browser tab, which is both ① and ② at once AND changes the client the
//    developer asked for.
//
// The rules are cheap to follow and easy to forget, which is exactly what a
// gate is for.
import { assert, assertEquals } from "@std/assert";
import { mayOpenExternal } from "../src/server/open-external.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { kill } from "./e2e-app-harness.ts";
import {
  isProcessAlive,
  killProcess,
} from "../src/server/single-instance-lock.ts";
import { hasDesktopSession } from "../src/server/open-external.ts";

/** Test files that launch a real GUI process. Named explicitly rather than
 *  detected: the list is short, and a new GUI test should have to think about
 *  which side of this line it is on. */
const GUI_TESTS = [
  "tests/electron-ipc.test.ts",
  "tests/ui-chrome-electron-e2e.test.ts",
  "tests/e2e-ui-chromium.test.ts",
  "tests/e2e-blank-screen.test.ts",
  "tests/e2e-sync-browser.test.ts",
];

/** Anything that starts a process which can map a window. */
const SPAWNS = /new Deno\.Command\(/;

Deno.test("gui tests: every window opens on the nested display, not yours", async () => {
  const offenders: string[] = [];
  for (const f of GUI_TESTS) {
    let src: string;
    try {
      src = await Deno.readTextFile(f);
    } catch {
      continue; // the file was renamed or removed — not this gate's business
    }
    if (!SPAWNS.test(src)) continue;
    // `testDisplayEnv()` is the ONE way to reach the nested display: it also
    // carries AIO_NO_OPEN, so a test cannot take the display containment
    // without also taking the no-stray-tabs rule.
    if (!/testDisplayEnv\s*\(/.test(src)) offenders.push(f);
  }
  assertEquals(
    offenders,
    [],
    `these tests launch a GUI with the developer's own DISPLAY inherited, so ` +
      `their windows open on the real desktop and steal focus:\n  ` +
      offenders.join("\n  ") +
      `\n\nSpread testDisplayEnv() into the child's env:\n` +
      `  env: { ...Deno.env.toObject(), ...testDisplayEnv() }`,
  );
});

Deno.test("open-external: a test process is never allowed to open a browser", () => {
  const prev = Deno.env.get("AIO_NO_OPEN");
  try {
    Deno.env.set("AIO_NO_OPEN", "1");
    const r = mayOpenExternal();
    assert(!r.ok, "AIO_NO_OPEN must refuse");
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_NO_OPEN");
    else Deno.env.set("AIO_NO_OPEN", prev);
  }
});

Deno.test("open-external: the test display implies no browser opening", () => {
  const prevNo = Deno.env.get("AIO_NO_OPEN");
  const prevDisp = Deno.env.get("AIO_TEST_DISPLAY");
  try {
    // The pairing that matters: a harness that only sets the display must not
    // leave the tab path open. Both facts travel together or neither does.
    Deno.env.delete("AIO_NO_OPEN");
    Deno.env.set("AIO_TEST_DISPLAY", ":77");
    const r = mayOpenExternal();
    assert(
      !r.ok,
      "a process running against the test display opened a real browser tab",
    );
    assert(/test display/.test(r.ok ? "" : r.why), r.ok ? "" : r.why);

    // …and the helper hands both to every child it spawns.
    assertEquals(testDisplayEnv().AIO_NO_OPEN, "1");
  } finally {
    if (prevNo === undefined) Deno.env.delete("AIO_NO_OPEN");
    else Deno.env.set("AIO_NO_OPEN", prevNo);
    if (prevDisp === undefined) Deno.env.delete("AIO_TEST_DISPLAY");
    else Deno.env.set("AIO_TEST_DISPLAY", prevDisp);
  }
});

Deno.test("open-external: refusal is loud, and names the URL", () => {
  // A refusal that says nothing is indistinguishable from a broken launcher.
  // Whatever the reason, the human must still be able to reach the app.
  const prev = Deno.env.get("AIO_NO_OPEN");
  try {
    Deno.env.set("AIO_NO_OPEN", "1");
    const r = mayOpenExternal();
    assert(!r.ok);
    assert(r.why.length > 0, "a refusal must say why");
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_NO_OPEN");
    else Deno.env.set("AIO_NO_OPEN", prev);
  }
});

// An electron app that cannot find Electron must stay a DESKTOP app. Falling
// back to a browser tab silently changed the target the developer chose, in
// the situation where they were least likely to be watching — and left a tab
// behind that aio cannot close.
Deno.test("lifecycle: a missing Electron never becomes a browser tab", async () => {
  const src = await Deno.readTextFile("src/server/aio-lifecycle.ts");
  const block = src.slice(
    src.indexOf("Electron unavailable"),
    src.indexOf("setElectronProc(proc)"),
  );
  assert(
    block.length > 0,
    "the Electron-missing branch moved — update this gate",
  );
  // Comments in this branch legitimately NAME the function while explaining
  // why it is not called; a gate that cannot tell a mention from a call fires
  // on its own documentation.
  const code = block.split("\n").filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert(
    !/openExternalBestEffort\s*\(/.test(code),
    "the Electron-missing branch opens a browser again: a desktop app must " +
      "not silently become a browser app, and the tab it leaves is one aio " +
      "cannot close",
  );
});

// ── The default: print the link, do not open it ─────────────────────────────

// Auto-opening a browser was a development convenience that quietly cost more
// than it gave. A tab handed to an already-running browser belongs to that
// browser: the app exits, the tab stays. A watch loop, a restart-on-crash or a
// suite that boots an app twenty times therefore leaves twenty tabs of the same
// app, each having taken focus as it mapped, none of them aio's to close.
//
// An Electron window is different IN KIND — a child process aio owns and closes
// with the app — which is why that still opens by default.
Deno.test("lifecycle: a browser client prints its URL instead of opening a tab", async () => {
  const src = await Deno.readTextFile("src/server/aio-lifecycle.ts");
  const i = src.indexOf("A browser client is a URL, printed");
  assert(i > 0, "the browser-client branch moved — update this gate");
  const branch = src.slice(i, i + 1600);
  const code = branch.split("\n").filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const call = code.indexOf("openExternalBestEffort(");
  assert(
    call > 0,
    "the browser branch no longer opens at all — did --open go?",
  );
  // The call must sit behind the opt-in, never on the default path.
  assert(
    /if\s*\(!cli\.open\)/.test(code),
    "the browser branch opens a tab without checking --open again",
  );
  assert(
    code.indexOf("cli.open") < call,
    "openExternalBestEffort is reached before the --open check",
  );
});

// A test that drives a browser must bring its OWN browser: its own process, its
// own throwaway profile, killed when the test ends. Reusing the developer's
// browser is what leaves tabs behind, and sharing their profile would put test
// state into it.
Deno.test("browser tests: own process, own profile, killed afterwards", async () => {
  const BROWSER_TESTS = [
    "tests/e2e-ui-chromium.test.ts",
    "tests/e2e-blank-screen.test.ts",
    "tests/e2e-sync-browser.test.ts",
  ];
  const bad: string[] = [];
  for (const f of BROWSER_TESTS) {
    let src: string;
    try {
      src = await Deno.readTextFile(f);
    } catch {
      continue;
    }
    const ownProfile = /--user-data-dir=/.test(src);
    const kills = /\.kill\(/.test(src);
    const headless = /headless/.test(src);
    if (!ownProfile || !kills || !headless) {
      bad.push(
        `${f} (own-profile=${ownProfile} kills=${kills} headless=${headless})`,
      );
    }
  }
  assertEquals(
    bad,
    [],
    `a browser a test opens must be the test's to close:\n  ${
      bad.join("\n  ")
    }`,
  );
});

// ── Nothing outlives the run ────────────────────────────────────────────────

// The zombie mechanism, reproduced exactly: a SHELL that starts the real app.
// Several tests spawn one — `run.sh`, an installer, a task runner — and killing
// only the direct child ends the shell while the app it started keeps running,
// still holding its port and its singleton lock. The next run then refuses to
// start ("Already running") and the developer has to hunt the process down
// before they can work.
Deno.test("kill(): a grandchild does not survive its parent", async () => {
  const proc = new Deno.Command("sh", {
    args: ["-c", "sleep 300 & echo $! ; wait"],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const rdr = proc.stdout.getReader();
  const { value } = await rdr.read();
  const grandchild = Number(new TextDecoder().decode(value!).trim());
  rdr.releaseLock();
  assert(Number.isInteger(grandchild) && grandchild > 0, "no grandchild pid");

  const alive = (pid: number) => {
    try {
      Deno.kill(pid, "SIGCONT" as Deno.Signal);
      return true;
    } catch {
      return false;
    }
  };
  assert(alive(grandchild), "fixture inert — the grandchild never started");

  await kill(proc);
  await new Promise((r) => setTimeout(r, 300));
  assertEquals(
    alive(grandchild),
    false,
    "the grandchild outlived kill() — this is the process a developer has to " +
      "find and kill by hand before their own run will start",
  );
});

// ── One killer, and it takes the window with it ─────────────────────────────

// `am stop` on a HEALTHY app is graceful: the app shuts down and closes its own
// Electron window (shutdown.ts has an "electron" phase). But a HUNG app never
// reaches its shutdown, so the SIGKILL that follows the grace period used to
// orphan the window — a desktop app left on screen with no server behind it,
// and a process the developer has to find and kill before their next run.
Deno.test("killProcess: a hung app does not orphan the window it opened", async () => {
  // A parent that ignores SIGTERM is exactly the "hung app" case: it forces the
  // SIGKILL path, which is the one that used to leave children behind.
  const proc = new Deno.Command("sh", {
    args: ["-c", "trap '' TERM; sleep 300 & echo $! ; wait"],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const rdr = proc.stdout.getReader();
  const { value } = await rdr.read();
  const child = Number(new TextDecoder().decode(value!).trim());
  rdr.releaseLock();
  assert(Number.isInteger(child) && child > 0, "no child pid");
  assert(isProcessAlive(child), "fixture inert — the child never started");

  // Short grace: the point is the SIGKILL path, not the wait.
  await killProcess(proc.pid, 300);
  await proc.status.catch(() => {});
  await new Promise((r) => setTimeout(r, 300));

  assertEquals(
    isProcessAlive(child),
    false,
    "the child outlived the kill — for a real app this is the Electron " +
      "window still on screen after `am stop`",
  );
});

Deno.test("killProcess: there is exactly one implementation", async () => {
  // Two copies had already drifted into agreeing on nothing but their shape:
  // same constants retyped, and neither knew about child processes.
  const am = await Deno.readTextFile("src/am/am-cmd-process.ts");
  assert(
    !/^export async function killProcess/m.test(am),
    "am has its own killProcess again — re-export the one in " +
      "server/single-instance-lock.ts instead",
  );
  const harness = await Deno.readTextFile("tests/e2e-app-harness.ts");
  assert(
    !/async function descendants\s*\(/.test(harness),
    "the harness has its own descendant walk again — import descendantPids",
  );
});

// ── A desktop app on a machine with no desktop ──────────────────────────────

// `isHeadless` answers "does this CLIENT have a UI" — a property of the app.
// Whether a window can open is a property of the MACHINE. The two shared an
// answer on a developer's laptop and diverged everywhere else: an electron app
// over ssh or in a container tried to launch Electron, failed, and since "the
// window went away" is what stops a desktop app, the whole app exited instead
// of serving.
Deno.test("desktop: an electron app on a headless box serves instead of dying", async () => {
  const src = await Deno.readTextFile("src/server/aio-lifecycle.ts");
  assert(
    /useElectron && !hasDesktopSession\(\)/.test(src),
    "the electron branch no longer checks for a desktop session",
  );
  const i = src.indexOf("useElectron && !hasDesktopSession()");
  const branch = src.slice(i, i + 1200);
  assert(
    /log\.warn/.test(branch),
    "degrading to no-window must be LOUD — silence here reads as a hang",
  );
  assert(
    !/Deno\.exit|shutdownAllRuntimes/.test(branch),
    "a missing desktop must not stop the app: the server is the useful half",
  );
});

Deno.test("desktop: hasDesktopSession reads the session, not the client", () => {
  const prevD = Deno.env.get("DISPLAY");
  const prevW = Deno.env.get("WAYLAND_DISPLAY");
  try {
    if (Deno.build.os !== "linux") {
      // Elsewhere a logged-in user always has a session; the launcher reports
      // its own failure rather than this guessing for it.
      assertEquals(hasDesktopSession(), true);
      return;
    }
    Deno.env.delete("DISPLAY");
    Deno.env.delete("WAYLAND_DISPLAY");
    assertEquals(hasDesktopSession(), false);
    Deno.env.set("DISPLAY", ":0");
    assertEquals(hasDesktopSession(), true);
    Deno.env.delete("DISPLAY");
    Deno.env.set("WAYLAND_DISPLAY", "wayland-0");
    assertEquals(hasDesktopSession(), true, "wayland is a session too");
  } finally {
    if (prevD === undefined) Deno.env.delete("DISPLAY");
    else Deno.env.set("DISPLAY", prevD);
    if (prevW === undefined) Deno.env.delete("WAYLAND_DISPLAY");
    else Deno.env.set("WAYLAND_DISPLAY", prevW);
  }
});
