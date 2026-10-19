// A desktop app's update is proven by its WINDOW — and what an update did
// outside the install is undone by its rollback.
//
// A field report measured an update to an online-Electron build confirmed
// `healthy` 40 ms BEFORE its first start began downloading Electron: the
// confirm fired once `onStart` came through, and a clean exit confirmed at
// exit. A download that failed (a proxy) or was cancelled left a confirmed
// build that cannot open, with the working one in `old/`. Now a desktop
// app's update is confirmed only once its main window has loaded; a start
// whose window never did is a failed start the judge counts and rolls back.
// The Retry / Quit question offers "Start the previous version" while the
// version replaced is kept.
//
// The rollback also undoes what the update did OUTSIDE the install: the
// shared store's `pending` record of the version it removed, and a window
// profile the new build moved out of Electron's old per-OS place (the build
// put back reads it there).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  _confirm,
  confirmPendingUpdate,
  judgePendingUpdate,
  noteProfileMove,
  restoredLauncher,
  updateWindow,
  windowGate,
} from "../src/server/updates-boot.ts";
import {
  failedUpdatePath,
  MAX_BOOT_ATTEMPTS,
  oldCopyPath,
  type PendingUpdate,
  readPending,
  swapArtifact,
  writePending,
} from "../src/server/updates-apply.ts";
import { judgeKeepOld } from "../src/server/updates-core.ts";
import { _menuDeps } from "../src/server/app-dirs.ts";
import {
  readSharedUses,
  sharedUseKey,
} from "../src/electron/shared-runtime.ts";
import {
  formatRendererLine,
  mountLine,
} from "../src/electron/electron-renderer-log.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { childEnv } from "./e2e-app-harness.ts";
import { spec } from "./module-spec-helper.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

function recorder(): Log & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (...a: unknown[]) => {
    lines.push(`${level} ${a.map(String).join(" ")}`);
  };
  return {
    lines,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("debug"),
  } as unknown as Log & { lines: string[] };
}

const mark = (over: Partial<PendingUpdate>): PendingUpdate => ({
  from: "1.0.0",
  to: "2.0.0",
  previous: "/x/old/1.0.0/app",
  attempts: 1,
  startedAt: "2026-10-19T00:00:00.000Z",
  ...over,
});

// ── the gate ────────────────────────────────────────────────────────────────

Deno.test("windowGate: a start that opens a window holds the confirm until the window loaded — never at exit before it; no window, no hold", () => {
  // No window expected (a server, a CLI): nothing is held.
  const none = windowGate();
  assertEquals(none.holds(false, () => {}), false);
  assertEquals(none.holds(true, () => {}), false);

  // A window expected: the hook coming through waits, the load fires it.
  const g = windowGate();
  g.expect();
  let fired = 0;
  assertEquals(g.holds(false, () => fired++), true);
  assertEquals(fired, 0, "onStart came through: not yet");
  g.loaded();
  assertEquals(fired, 1, "the window loaded: confirmed");
  g.loaded();
  assertEquals(fired, 1, "once");
  assertEquals(g.holds(false, () => fired++), false, "loaded: no hold");

  // A clean exit before the window loaded confirms nothing — ever.
  const quit = windowGate();
  quit.expect();
  let late = 0;
  assertEquals(quit.holds(true, () => late++), true);
  quit.loaded();
  assertEquals(late, 0, "an exit's confirm is never run later");

  // The window loaded before the hook came through: no hold then.
  const early = windowGate();
  early.expect();
  early.loaded();
  assertEquals(early.holds(false, () => {}), false);
});

// ── end to end: a window that never loads is a failed start ────────────────

/** A source app with an `$ELECTRON_PATH` stub that opens nothing: it waits
 *  for the app's start, says the renderer mounted when `mounts`, and exits 0
 *  (the user closing it). */
async function desktopApp(dir: string, mounts: boolean) {
  await Deno.mkdir(dir, { recursive: true });
  const ready = join(dir, "ready");
  const stub = join(dir, "electron");
  await Deno.writeTextFile(
    stub,
    `#!/bin/sh
i=0
while [ ! -f '${ready}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
${
      mounts
        ? `echo '${formatRendererLine("info", mountLine(3))}' >&2\nsleep 1`
        : ""
    }
exit 0
`,
  );
  await Deno.chmod(stub, 0o755);
  const app = join(dir, "app");
  await Deno.mkdir(join(app, "src"), { recursive: true });
  const head = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
  const imports: Record<string, string> = {};
  for (const [k, v] of Object.entries(head.imports as Record<string, string>)) {
    imports[k] = v.startsWith("./") ? `${spec(ROOT)}/${v.slice(2)}` : v;
  }
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify({ compilerOptions: head.compilerOptions, imports }),
  );
  await Deno.writeTextFile(
    join(app, "src", "cell.ts"),
    `import { cell } from "aio";\nexport const c = cell("c", { state: { v: 0 }, methods: { inc(s) { s.v++; } } });\n`,
  );
  await Deno.writeTextFile(
    join(app, "src", "App.tsx"),
    `import { c } from "./cell.ts";\nexport default function App() { return <p>{c.v}</p>; }\n`,
  );
  await Deno.writeTextFile(
    join(app, "src", "app.ts"),
    `import { c } from "./cell.ts";
import { aio } from "aio";
await aio.run({ appId: "deskconfirm", cells: [c] });
Deno.writeTextFileSync(Deno.env.get("READY")!, "1");
`,
  );
  const home = join(dir, "home");
  const data = join(home, "deskconfirm", "data");
  await Deno.mkdir(data, { recursive: true });
  const start = async () => {
    await Deno.remove(ready).catch(() => {});
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "src/app.ts",
        "--client=electron",
        `--port=${freePort()}`,
      ],
      cwd: app,
      env: childEnv({
        ...testDisplayEnv(),
        ELECTRON_PATH: stub,
        AIO_APPS_DIR: home,
        READY: ready,
      }),
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(90_000),
    }).output();
    const dec = new TextDecoder();
    return {
      code: out.code,
      log: dec.decode(out.stdout) + dec.decode(out.stderr),
    };
  };
  return { data, start };
}

Deno.test({
  name:
    "desktop update e2e: a window that never loads is NOT confirmed by a clean exit — counted, and rolled back after the attempts; one that loads is confirmed",
  ignore: Deno.build.os !== "linux", // the shell stub; the gate itself is pure (above)
  async fn() {
    const dir = await tempDir("desk-confirm-");
    try {
      // The install the update replaced, and the version kept in old/.
      const install = join(dir, "install", "app");
      const previous = oldCopyPath(install, "1.0.0");
      await Deno.mkdir(join(dir, "install", "old", "1.0.0"), {
        recursive: true,
      });
      await Deno.writeTextFile(install, "the 2.0.0 build");
      await Deno.writeTextFile(previous, "the 1.0.0 build");
      const never = await desktopApp(join(dir, "never"), false);
      writePending(
        never.data,
        mark({ artifact: install, previous, attempts: 0 }),
      );
      for (let i = 1; i <= MAX_BOOT_ATTEMPTS; i++) {
        const r = await never.start();
        assert(r.log.includes("launching Electron"), r.log.slice(-3000));
        assertEquals(r.code, 0, r.log.slice(-3000));
        const p = readPending(never.data);
        assertEquals(p?.attempts, i, `boot ${i}:\n${r.log.slice(-3000)}`);
        assertEquals(p?.confirmedAt, undefined, "a clean exit is no proof");
        assert(!r.log.includes("confirmed healthy"), r.log.slice(-3000));
      }
      // Attempts spent: the next start puts 1.0.0 back.
      const back = await never.start();
      assertEquals(back.code, 1, back.log.slice(-3000));
      assertEquals(await Deno.readTextFile(install), "the 1.0.0 build");
      assertEquals(readPending(never.data), null);
      assert(Deno.statSync(failedUpdatePath(never.data)).isFile);

      // A window that loads proves the build.
      await Deno.writeTextFile(install, "the 2.0.0 build");
      await Deno.mkdir(join(dir, "install", "old", "1.0.0"), {
        recursive: true,
      });
      await Deno.writeTextFile(previous, "the 1.0.0 build");
      const loads = await desktopApp(join(dir, "loads"), true);
      writePending(
        loads.data,
        mark({ artifact: install, previous, attempts: 0 }),
      );
      const ok = await loads.start();
      assertStringIncludes(ok.log, "confirmed healthy");
      assertEquals(readPending(loads.data), null, ok.log.slice(-3000));
    } finally {
      await dropTempDir(dir);
    }
  },
});

// ── "Start the previous version" ───────────────────────────────────────────

Deno.test("previous version: offered only while the replaced version is kept; chosen, it is rolled back now and started from where it was put back", async () => {
  const dir = await tempDir("desk-previous-");
  try {
    const data = join(dir, "data");
    await Deno.mkdir(data);
    const install = join(dir, "app");
    const previous = oldCopyPath(install, "1.0.0");
    await Deno.mkdir(join(dir, "old", "1.0.0"), { recursive: true });
    await Deno.writeTextFile(install, "the 2.0.0 build");
    await Deno.writeTextFile(previous, "the 1.0.0 build");
    writePending(data, mark({ artifact: install, previous }));
    const started: Array<{ artifact: string; args: string[] }> = [];
    const log = recorder();
    const w = updateWindow(data, log, windowGate(), ["--x"], {
      relaunch: (o) => void started.push(o),
      sharedStore: join(dir, "store"),
    });
    assert(w.hooks.previous, "offered: 1.0.0 is in old/");
    assertEquals(await w.hooks.previous(), true);
    assertEquals(await Deno.readTextFile(install), "the 1.0.0 build");
    assertEquals(started, [{ artifact: install, args: ["--x"] }]);
    assertEquals(readPending(data), null, "kept as the FAILED record");
    assert(Deno.statSync(failedUpdatePath(data)).isFile);
    assert(log.lines.some((l) => l.includes("start the previous version")));
    // Nothing kept, nothing offered.
    writePending(
      data,
      mark({ artifact: install, previous: join(dir, "gone") }),
    );
    assertEquals(
      updateWindow(data, log, windowGate(), []).hooks.previous,
      undefined,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("restoredLauncher: a .app through open -n, an unpacked folder through its launcher, a file itself", () => {
  assertEquals(restoredLauncher("/A/Notes.app", ["-v"], true, "darwin"), {
    artifact: "/usr/bin/open",
    args: ["-n", "/A/Notes.app", "--args", "-v"],
  });
  assertEquals(restoredLauncher("/opt/notes", [], true, "linux"), {
    artifact: join("/opt/notes", "run.sh"),
    args: [],
  });
  // The launcher is the one of the OS asked about, not the host's.
  assertEquals(restoredLauncher("/opt/notes", [], true, "windows"), {
    artifact: join("/opt/notes", "run.bat"),
    args: [],
  });
  assertEquals(restoredLauncher("/a/notes.AppImage", ["x"], false, "linux"), {
    artifact: "/a/notes.AppImage",
    args: ["x"],
  });
});

// ── what the rollback undoes outside the install ───────────────────────────

Deno.test("rollback: the shared store's pending record of the version removed goes, a started one stays; a profile the update moved goes back to where the restored build reads it", async () => {
  const dir = await tempDir("desk-undo-");
  try {
    const data = join(dir, "data");
    await Deno.mkdir(data);
    const install = join(dir, "app");
    const previous = oldCopyPath(install, "1.0.0");
    await Deno.mkdir(join(dir, "old", "1.0.0"), { recursive: true });
    await Deno.writeTextFile(install, "the 2.0.0 build");
    await Deno.writeTextFile(previous, "the 1.0.0 build");
    // The store: 2.0.0's update wrote a pending record (its runtime never
    // started); 1.0.0's own start record; another app's pending one.
    const store = join(dir, "store");
    await Deno.mkdir(join(store, "apps"), { recursive: true });
    const rec = async (exe: string, v: string, pending: boolean) =>
      await Deno.writeTextFile(
        join(store, "apps", `${await sharedUseKey(exe)}-${v}.json`),
        JSON.stringify({
          exe,
          version: v,
          slug: "s",
          at: "2026-10-19",
          ...(pending ? { pending: true } : {}),
        }),
      );
    await rec(install, "44.0.0", true);
    await rec(install, "38.0.0", false);
    await rec(join(dir, "other"), "44.0.0", true);
    // The profile 2.0.0 moved into the home on its first start.
    const from = join(dir, "config", "app");
    const to = join(dir, "home", "electron");
    await Deno.mkdir(to, { recursive: true });
    await Deno.writeTextFile(join(to, "Local State"), "signed-in");
    writePending(
      data,
      mark({
        artifact: install,
        previous,
        attempts: MAX_BOOT_ATTEMPTS,
        profileMoved: { from, to },
      }),
    );
    const log = recorder();
    assertEquals(
      await judgePendingUpdate(data, log, "2.0.0", { sharedStore: store }),
      true,
    );
    assertEquals(await Deno.readTextFile(install), "the 1.0.0 build");
    const left = (await readSharedUses(store))
      .map((u) =>
        `${u.use?.exe === install ? "app" : "other"} ${u.use?.version} ${!!u.use
          ?.pending}`
      )
      .sort();
    assertEquals(left, ["app 38.0.0 false", "other 44.0.0 true"]);
    assertEquals(
      await Deno.readTextFile(join(from, "Local State")),
      "signed-in",
    );
    assert(
      log.lines.some((l) => l.includes("moved back")),
      log.lines.join("\n"),
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("noteProfileMove: only on the marker this boot judged, and only the first move", async () => {
  const dir = await tempDir("desk-note-");
  try {
    const judged = mark({});
    writePending(dir, judged);
    const log = recorder();
    noteProfileMove(dir, judged, "/c/app", "/h/electron", log);
    assertEquals(readPending(dir)?.profileMoved, {
      from: "/c/app",
      to: "/h/electron",
    });
    noteProfileMove(dir, judged, "/c/other", "/h/electron", log);
    assertEquals(readPending(dir)?.profileMoved?.from, "/c/app");
    // Another update's marker (written since) is not this boot's.
    writePending(dir, mark({ startedAt: "2026-10-20T00:00:00.000Z" }));
    noteProfileMove(dir, judged, "/c/app", "/h/electron", log);
    assertEquals(readPending(dir)?.profileMoved, undefined);
  } finally {
    await dropTempDir(dir);
  }
});

// ── the review batch ────────────────────────────────────────────────────────

Deno.test(
  "renamed swap: a staged file that cannot be made executable leaves NO marker — the version stays on offer, never judged 'did not take effect'",
  {
    ignore: Deno.build.os === "windows", // no chmod there
  },
  async () => {
    const dir = await tempDir("desk-chmod-");
    try {
      const data = join(dir, "data");
      await Deno.mkdir(data);
      const v1 = join(dir, "app-1.0.0-x86_64.AppImage");
      await Deno.writeTextFile(v1, "the 1.0.0 build");
      let threw = false;
      try {
        await swapArtifact({
          current: v1,
          staged: join(dir, "missing.new-2.0.0"),
          next: join(dir, "app-2.0.0-x86_64.AppImage"),
          fromVersion: "1.0.0",
          toVersion: "2.0.0",
          smoke: false,
          pending: { dataDir: data, from: "1.0.0", to: "2.0.0" },
        });
      } catch {
        threw = true;
      }
      assert(threw);
      assertEquals(readPending(data), null);
      assertEquals(await Deno.readTextFile(v1), "the 1.0.0 build");
    } finally {
      await dropTempDir(dir);
    }
  },
);

Deno.test("judgeKeepOld: an invalid keepOld never stops the judge — said, and the default used", () => {
  const said: string[] = [];
  assertEquals(
    judgeKeepOld({ source: "x", keepOld: 0 }, (m) => said.push(m)),
    1,
  );
  assertStringIncludes(said[0]!, "keepOld");
  assertEquals(
    judgeKeepOld({ source: "x", keepOld: 3 }, (m) => said.push(m)),
    3,
  );
  assertEquals(said.length, 1);
});

Deno.test("renamed update confirmed: a WARNING naming both paths; the menu entry is claimed only where it starts the new one (Linux)", async () => {
  const dir = await tempDir("desk-menu-");
  const real = _menuDeps.path;
  _menuDeps.path = (base) => join(dir, "applications", `${base}.desktop`);
  try {
    const data = join(dir, "data");
    await Deno.mkdir(data);
    const v1 = join(dir, "app-1.0.0-x86_64.AppImage");
    const v2 = join(dir, "app-2.0.0-x86_64.AppImage");
    const previous = oldCopyPath(v1, "1.0.0");
    await Deno.mkdir(join(dir, "old", "1.0.0"), { recursive: true });
    await Deno.writeTextFile(previous, "the 1.0.0 build");
    const confirm = async (menu: string | null) => {
      await Deno.writeTextFile(v2, "the 2.0.0 build");
      await Deno.remove(join(dir, "applications"), { recursive: true })
        .catch(() => {});
      if (menu) {
        await Deno.mkdir(join(dir, "applications"));
        await Deno.writeTextFile(
          join(dir, "applications", "app.desktop"),
          `[Desktop Entry]\nExec=${menu} %U\n`,
        );
      }
      writePending(data, mark({ artifact: v2, restoreTo: v1, previous }));
      const log = recorder();
      confirmPendingUpdate(data, log);
      await _confirm.pruned;
      const said = log.lines.filter((l) => l.includes("made by hand"));
      assertEquals(said.length, 1, log.lines.join("\n"));
      assert(said[0]!.startsWith("warn"), said[0]);
      assertStringIncludes(said[0]!, v1);
      assertStringIncludes(said[0]!, v2);
      return said[0]!;
    };
    assert(!(await confirm(null)).includes("menu entry"));
    assert(!(await confirm(v1)).includes("menu entry"), "not rewritten");
    assertEquals(
      (await confirm(v2)).includes("menu entry"),
      Deno.build.os === "linux",
    );
  } finally {
    _menuDeps.path = real;
    await dropTempDir(dir);
  }
});
