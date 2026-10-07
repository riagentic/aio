// macos-move.test.ts — a macOS app opened from its disk image or Downloads
// offers, once, to move itself into Applications (src/server/macos-move.ts).
//
// Everything the decision depends on is handed in, so every row runs on any
// host. What only a Mac can show — the dialog, `ditto`, LaunchServices — was
// run on macOS 14 and is recorded in docs/build/targets.md.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  MOVE_DECLINED_FILE,
  moveAnswer,
  moveDialogArgs,
  moveOffer,
  offerMoveToApplications,
  openMovedCommand,
} from "../src/server/macos-move.ts";
import { RELAUNCH_FLAG } from "../src/server/updates-apply.ts";
import { log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const EXE = "/Volumes/Counter/Counter.app/Contents/MacOS/counter";
const facts = (over: Partial<Parameters<typeof moveOffer>[0]> = {}) => ({
  os: "darwin",
  execPath: EXE,
  home: "/Users/u",
  env: undefined,
  declined: false,
  exists: () => false,
  canWrite: () => true,
  ...over,
});

Deno.test("moveOffer: an app outside Applications is offered /Applications", () => {
  assertEquals(moveOffer(facts()), {
    app: "/Volumes/Counter/Counter.app",
    dest: "/Applications/Counter.app",
  });
  // App Translocation: the bundle keeps its name under the random folder.
  assertEquals(
    moveOffer(facts({
      execPath:
        "/private/var/folders/x/T/AppTranslocation/ABC/d/Counter.app/Contents/MacOS/counter",
    }))?.dest,
    "/Applications/Counter.app",
  );
});

Deno.test("moveOffer: /Applications not writable — the user's own Applications", () => {
  assertEquals(
    moveOffer(facts({ canWrite: (d) => d !== "/Applications" }))?.dest,
    "/Users/u/Applications/Counter.app",
  );
  // …and with no home to put it in, nothing is offered.
  assertEquals(
    moveOffer(facts({ canWrite: () => false, home: undefined })),
    null,
  );
});

Deno.test("moveOffer: nothing to offer", () => {
  const none: [string, Partial<Parameters<typeof moveOffer>[0]>][] = [
    ["not macOS", { os: "linux" }],
    ["not a bundle", { execPath: "/usr/local/bin/counter" }],
    ["already in /Applications", {
      execPath: "/Applications/Counter.app/Contents/MacOS/counter",
    }],
    ["in a folder of /Applications", {
      execPath: "/Applications/Tools/Counter.app/Contents/MacOS/counter",
    }],
    ["in ~/Applications", {
      execPath: "/Users/u/Applications/Counter.app/Contents/MacOS/counter",
    }],
    ["a copy is installed", {
      exists: (p) => p === "/Applications/Counter.app",
    }],
    ["a copy is in ~/Applications", {
      exists: (p) => p === "/Users/u/Applications/Counter.app",
    }],
    ["the user said Not Now", { declined: true }],
    ["switched off", { env: "never" }],
    ["switched off (0)", { env: "0" }],
  ];
  for (const [why, over] of none) {
    assertEquals(moveOffer(facts(over)), null, why);
  }
  // `move` is an instruction: it outranks an earlier "Not Now".
  assert(moveOffer(facts({ declined: true, env: "move" })) !== null);
  // A folder merely NAMED like Applications is not Applications.
  assert(
    moveOffer(facts({
      execPath: "/Applications2/Counter.app/Contents/MacOS/counter",
    })) !== null,
  );
});

Deno.test("moveAnswer: the three things osascript can say", () => {
  const r = (code: number, stdout = "", stderr = "") => ({
    code,
    stdout,
    stderr,
  });
  assertEquals(moveAnswer(r(0, "Move to Applications\n")), "move");
  assertEquals(
    moveAnswer(r(1, "", "execution error: User canceled. (-128)")),
    "later",
  );
  // Left alone until it gave up, or never shown: nothing is remembered.
  assertEquals(moveAnswer(r(0, "gave up\n")), "unanswered");
  assertEquals(
    moveAnswer(r(1, "", "no user interaction allowed (-1713)")),
    "unanswered",
  );
});

Deno.test("moveDialogArgs: the title is an argument, never script text", () => {
  const title = 'Dan’s "App" \\ end';
  const withIcon = moveDialogArgs(title, "/x/AppIcon.icns");
  const script = withIcon.filter((_, i) => withIcon[i - 1] === "-e").join("\n");
  assertEquals(script.includes("Dan"), false, script);
  assertEquals(withIcon.at(-2), title);
  assertEquals(withIcon.at(-1), "/x/AppIcon.icns");
  assert(script.includes("with icon POSIX file (item 3 of argv)"));
  const plain = moveDialogArgs(title, null);
  assertEquals(plain.at(-1), title);
  assertEquals(plain.join("\n").includes("with icon"), false);
});

Deno.test("openMovedCommand: through LaunchServices, waiting for this pid", () => {
  assertEquals(
    openMovedCommand("/Applications/Counter.app", [
      "--port=1",
      `${RELAUNCH_FLAG}=7`,
    ], 42),
    ["/usr/bin/open", [
      "-n",
      "/Applications/Counter.app",
      "--args",
      "--port=1",
      `${RELAUNCH_FLAG}=42`,
    ]],
  );
});

// ── the whole offer, with the Mac's tools stood in for ──────────────────────

async function harness(
  answer: { code: number; stdout: string; stderr: string } | null,
  over: {
    env?: string;
    shutdownFails?: boolean;
    dittoFails?: boolean;
    noWindow?: boolean;
    stopSignal?: AbortSignal;
  } = {},
) {
  const dir = await tempDir("macos-move-");
  // The product is macOS-only and spells its paths with `/`; so does this.
  const apps = `${dir}/Applications`;
  await Deno.mkdir(apps);
  const dataDir = join(dir, "data");
  await Deno.mkdir(dataDir);
  const calls: string[] = [];
  const spawned: string[][] = [];
  const exits: number[] = [];
  let stopped = 0;
  let dialogSignal: AbortSignal | undefined;
  const dest = `${apps}/Counter.app`;
  const result = await offerMoveToApplications({
    title: "Counter",
    dataDir,
    argv: ["--port=1"],
    log,
    shutdown: () => {
      stopped++;
      return over.shutdownFails
        ? Promise.reject(new Error("held"))
        : Promise.resolve();
    },
    windowUp: () => Promise.resolve(over.noWindow !== true),
    stopSignal: over.stopSignal,
    os: "darwin",
    execPath: EXE,
    home: dir,
    // "" and not undefined: unset falls back to this process's own
    // AIO_MOVE_TO_APPLICATIONS, and a lab that exports `never` decided the test.
    env: over.env ?? "",
    pid: 42,
    // `/Applications` is not ours to write in a test: the user's own folder.
    canWrite: (d) => d !== "/Applications",
    run: async (cmd, args, signal) => {
      calls.push(cmd.split("/").at(-1)!);
      if (cmd.endsWith("osascript")) {
        dialogSignal = signal;
        return answer!;
      }
      if (cmd.endsWith("ditto")) {
        if (over.dittoFails) return { code: 1, stdout: "", stderr: "no space" };
        await Deno.mkdir(args[1]!);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn: (cmd, args) => spawned.push([cmd, ...args]),
    exit: (code) => exits.push(code),
  });
  const there = async (p: string) => {
    try {
      await Deno.lstat(p);
      return true;
    } catch {
      return false;
    }
  };
  return {
    dir,
    result,
    calls,
    dialogSignal,
    spawned,
    exits,
    stopped,
    moved: await there(dest),
    declined: await there(join(dataDir, MOVE_DECLINED_FILE)),
    leftovers: [...Deno.readDirSync(apps)].map((e) => e.name),
    dest,
  };
}

Deno.test("offer: Move — copied, mark cleared, shut down, the copy opened, then exit", async () => {
  const h = await harness({
    code: 0,
    stdout: "Move to Applications\n",
    stderr: "",
  });
  try {
    assertEquals(h.result, "moved");
    assertEquals(h.calls, ["osascript", "ditto", "xattr"]);
    assertEquals(h.leftovers, ["Counter.app"]);
    assertEquals(h.stopped, 1);
    assertEquals(h.spawned, [[
      "/usr/bin/open",
      "-n",
      h.dest,
      "--args",
      "--port=1",
      `${RELAUNCH_FLAG}=42`,
    ]]);
    assertEquals(h.exits, [0]);
    assertEquals(h.declined, false);
  } finally {
    await dropTempDir(h.dir);
  }
});

Deno.test("offer: Not Now — remembered, nothing copied, the app runs on", async () => {
  const h = await harness({
    code: 1,
    stdout: "",
    stderr: "User canceled. (-128)",
  });
  try {
    assertEquals(h.result, "later");
    assertEquals(h.calls, ["osascript"]);
    assertEquals([h.moved, h.declined, h.stopped], [false, true, 0]);
    assertEquals([h.spawned, h.exits], [[], []]);
  } finally {
    await dropTempDir(h.dir);
  }
});

Deno.test("offer: a dialog nobody answered remembers nothing", async () => {
  const h = await harness({ code: 0, stdout: "gave up\n", stderr: "" });
  try {
    assertEquals(h.result, "unanswered");
    assertEquals([h.moved, h.declined, h.stopped], [false, false, 0]);
  } finally {
    await dropTempDir(h.dir);
  }
});

// Measured on a real Mac (macOS 26): the app quit and its question stayed on
// screen, an `osascript` owned by nobody, for up to its ten minutes.
Deno.test("offer: the dialog is handed the app's stop signal, and an app already stopping asks nothing", async () => {
  const ctl = new AbortController();
  // Ended by the signal: osascript dies of SIGTERM — nothing is remembered.
  const h = await harness({ code: 143, stdout: "", stderr: "" }, {
    stopSignal: ctl.signal,
  });
  ctl.abort();
  const late = await harness(null, { stopSignal: ctl.signal });
  try {
    assertEquals(h.dialogSignal, ctl.signal);
    assertEquals([h.result, h.moved, h.declined], ["unanswered", false, false]);
    assertEquals([late.result, late.calls], ["none", []]);
  } finally {
    await dropTempDir(h.dir);
    await dropTempDir(late.dir);
  }
});

Deno.test("offer: AIO_MOVE_TO_APPLICATIONS=move moves without asking", async () => {
  const h = await harness(null, { env: "move" });
  try {
    assertEquals(h.result, "moved");
    assertEquals(h.calls, ["ditto", "xattr"]);
    assertEquals(h.exits, [0]);
  } finally {
    await dropTempDir(h.dir);
  }
});

Deno.test("offer: a copy that fails leaves nothing behind and the app running", async () => {
  const h = await harness(null, { env: "move", dittoFails: true });
  try {
    assertEquals(h.result, "failed");
    assertEquals(h.leftovers, []);
    assertEquals([h.stopped, h.spawned, h.exits], [0, [], []]);
  } finally {
    await dropTempDir(h.dir);
  }
});

Deno.test("offer: a shutdown that fails opens nothing and does not exit", async () => {
  const h = await harness(null, { env: "move", shutdownFails: true });
  try {
    assertEquals(h.result, "failed");
    // The copy is a whole app and stays; this one is not abandoned half-stopped.
    assertEquals(h.moved, true);
    assertEquals([h.spawned, h.exits], [[], []]);
  } finally {
    await dropTempDir(h.dir);
  }
});

Deno.test("offer: no window, no question — the dialog must not come before it", async () => {
  const h = await harness(null, { env: "move", noWindow: true });
  try {
    assertEquals(h.result, "none");
    assertEquals([h.calls, h.moved, h.stopped], [[], false, 0]);
  } finally {
    await dropTempDir(h.dir);
  }
});
