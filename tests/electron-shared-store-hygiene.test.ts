// A shared-runtime ("electronRuntime": "online") package starts ONLY the
// store's Electron its build pinned: an `$ELECTRON_PATH` inherited from a
// bundled package (an update from a bundled build, a start from a bundled
// app's process) is cleared by its launcher and ignored by `findElectronBin`.
// And its own start cleans the store of runtimes nothing installed names
// (src/electron/shared-prune.ts) — end users have no `am prune`.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import { _appRun, _winLauncherBat } from "../src/build/build-electron.ts";
import { findElectronBin } from "../src/electron/electron-spawn.ts";
import {
  _withRuntimeLock,
  electronSlug,
  RUNTIME_USE_STAMP,
} from "../src/electron/electron-runtime-fetch.ts";
import {
  AUTO_PRUNE_MIN_AGE_DAYS,
  AUTO_PRUNE_STAMP,
  autoPruneSharedStore,
} from "../src/electron/shared-prune.ts";
import {
  recordSharedUse,
  sharedElectronDir,
  sharedElectronRoot,
} from "../src/electron/shared-runtime.ts";
import type { Log } from "../src/electron/electron-shared.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const SLUG = electronSlug();
const DAY = 24 * 60 * 60_000;

Deno.test("the shared store under test is the sandbox's, never the user's", () => {
  const override = Deno.env.get("AIO_SHARED_ELECTRON_DIR");
  assert(override, "AIO_SHARED_ELECTRON_DIR is set by the test sandbox");
  assertEquals(sharedElectronRoot(), resolve(override));
  assertEquals(
    sharedElectronRoot({ env: () => undefined }) === sharedElectronRoot(),
    false,
  );
});

// ── A: the launchers ───────────────────────────────────────────────────────

Deno.test("AppRun: the shared one unsets an inherited ELECTRON_PATH before its marker; the bundled one clears the marker", () => {
  const shared = _appRun("notes", true);
  const unset = shared.indexOf("unset ELECTRON_PATH\n");
  const marker = shared.indexOf(`export AIO_ELECTRON_RUNTIME="shared:$HERE"`);
  assert(unset > 0 && marker > unset, shared);
  assert(!shared.includes("export ELECTRON_PATH"), shared);
  const bundled = _appRun("notes");
  assert(!bundled.includes("unset ELECTRON_PATH"), bundled);
  const clear = bundled.indexOf("unset AIO_ELECTRON_RUNTIME\n");
  const ep = bundled.indexOf(`export ELECTRON_PATH="$HERE/electron/electron"`);
  assert(clear > 0 && ep > clear, bundled);
});

Deno.test("run.bat: the shared one clears an inherited ELECTRON_PATH; the bundled one is as before", () => {
  const shared = _winLauncherBat("notes", true);
  const clear = shared.indexOf(`SET "ELECTRON_PATH="\n`);
  assert(clear > 0 && shared.indexOf(`start ""`) > clear, shared);
  assertEquals(
    _winLauncherBat("notes"),
    `@echo off\nSET "HERE=%~dp0"\nSET "ELECTRON_PATH=%HERE%electron\\electron.exe"\nstart "" "%HERE%notes.exe" %*\n`,
  );
});

Deno.test({
  name:
    "AppRun (run by bash): the app a shared AppRun starts sees no inherited ELECTRON_PATH",
  ignore: Deno.build.os === "windows", // an AppImage is Linux's
  fn: async () => {
    const tmp = await tempDir("apprun-env-");
    try {
      for (const shared of [true, false]) {
        await Deno.writeTextFile(join(tmp, "AppRun"), _appRun("notes", shared));
        await Deno.writeTextFile(
          join(tmp, "notes"),
          `#!/bin/sh\necho "EP=\${ELECTRON_PATH-unset} RT=\${AIO_ELECTRON_RUNTIME-unset}"\n`,
        );
        await Deno.chmod(join(tmp, "AppRun"), 0o755);
        await Deno.chmod(join(tmp, "notes"), 0o755);
        const out = await new Deno.Command(join(tmp, "AppRun"), {
          env: {
            ELECTRON_PATH: "/tmp/.mount_old/electron/electron",
            AIO_ELECTRON_RUNTIME: "shared:/tmp/.mount_other",
          },
          stdout: "piped",
        }).output();
        const line = new TextDecoder().decode(out.stdout).trim();
        const here = await Deno.realPath(tmp);
        assertEquals(
          line,
          shared
            ? `EP=unset RT=shared:${here}`
            : `EP=${here}/electron/electron RT=unset`,
        );
      }
    } finally {
      await dropTempDir(tmp);
    }
  },
});

// ── A: findElectronBin ─────────────────────────────────────────────────────

Deno.test("findElectronBin: a shared app ignores an inherited, EXISTING $ELECTRON_PATH (said once); a bundled one still takes it", async () => {
  const tmp = await tempDir("shared-inherited-");
  const saved = ["ELECTRON_PATH", "APPDIR", "APPIMAGE"].map((
    k,
  ) => [k, Deno.env.get(k)] as const);
  try {
    // Another package's Electron, still there (its mount not gone yet).
    const other = join(tmp, ".mount_old", "electron", "electron");
    await Deno.mkdir(join(tmp, ".mount_old", "electron"), { recursive: true });
    await Deno.writeTextFile(other, "");
    Deno.env.set("ELECTRON_PATH", other);
    Deno.env.delete("APPDIR");
    Deno.env.delete("APPIMAGE");
    const dist = (runtime: string) => join(tmp, `dist-${runtime}`);
    for (const r of ["shared", "bundled"]) {
      await Deno.mkdir(dist(r));
      await Deno.writeTextFile(
        join(dist(r), "electron.json"),
        JSON.stringify({ version: "9.9.9", runtime: r }),
      );
    }
    const find = async (runtime: string) => {
      const info: string[] = [], errors: string[] = [];
      let asked = 0;
      const bin = await findElectronBin(
        { info: (m) => info.push(m), error: (m) => errors.push(m) } as Log,
        {
          distDir: dist(runtime),
          compiled: true,
          execPath: join(tmp, "pkg", "app"),
          title: "Notes",
          sharedRuntime: () => {
            asked++;
            return Promise.resolve("/store/electron");
          },
        },
      );
      return { bin, info, errors, asked };
    };
    const shared = await find("shared");
    assertEquals(shared.bin, "/store/electron");
    assertEquals(shared.asked, 1);
    const said = shared.info.filter((m) => m.includes("ELECTRON_PATH"));
    assertEquals(said.length, 1, shared.info.join("\n"));
    assertStringIncludes(said[0]!, other);
    assertEquals(shared.errors, []);

    const bundled = await find("bundled");
    assertEquals(bundled.bin, other);
    assertEquals(bundled.asked, 0);
    assertEquals(bundled.info.filter((m) => m.includes("ELECTRON_PATH")), []);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await dropTempDir(tmp);
  }
});

// ── B: the auto-prune ──────────────────────────────────────────────────────

/** A complete-looking runtime `v` in `root`, last started `daysAgo`. */
async function runtime(root: string, v: string, daysAgo: number) {
  const dir = sharedElectronDir(v, SLUG, root);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "payload"), "x".repeat(1000));
  await Deno.writeTextFile(
    join(dir, RUNTIME_USE_STAMP),
    new Date(Date.now() - daysAgo * DAY).toISOString(),
  );
  return dir;
}

const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

Deno.test("auto-prune: only runtimes nothing installed names, unused past the grace, not locked, not the running one — once a day", async () => {
  const tmp = await tempDir("shared-auto-prune-");
  try {
    const root = join(tmp, "store");
    const old = AUTO_PRUNE_MIN_AGE_DAYS + 5;
    const nobody = await runtime(root, "1.0.0", old);
    const uninstalled = await runtime(root, "2.0.0", old);
    const installed = await runtime(root, "3.0.0", old);
    // Inside the grace even on the "next day" below.
    const recent = await runtime(root, "4.0.0", AUTO_PRUNE_MIN_AGE_DAYS - 3);
    const locked = await runtime(root, "5.0.0", old);
    const running = await runtime(root, "6.0.0", old);
    // The record of an app whose install path is gone counts as gone.
    await recordSharedUse(
      { exe: join(tmp, "deleted.AppImage"), version: "2.0.0", slug: SLUG },
      { root },
    );
    const live = join(tmp, "live.AppImage");
    await Deno.writeTextFile(live, "");
    await recordSharedUse({ exe: live, version: "3.0.0", slug: SLUG }, {
      root,
    });
    // recordSharedUse stamps nothing; the records alone decide naming.
    await Deno.writeTextFile(
      join(installed, RUNTIME_USE_STAMP),
      new Date(Date.now() - old * DAY).toISOString(),
    );

    const info: string[] = [], errors: string[] = [];
    const log = {
      info: (m: string) => info.push(m),
      error: (m: string) => errors.push(m),
    };
    // Another process is downloading / installing 5.0.0: its lock is held.
    const removed = await _withRuntimeLock(
      `${locked}.lock`,
      (held) => {
        assert(held);
        return autoPruneSharedStore({ running, log, root });
      },
    );
    assertEquals(removed.sort(), [nobody, uninstalled].sort());
    assertEquals(errors, []);
    assertEquals(info.length, 2, info.join("\n"));
    assert(info.some((m) => m.includes(`1.0.0-${SLUG}`)));
    assert(info.some((m) => m.includes(`2.0.0-${SLUG}`)));
    for (const kept of [installed, recent, locked, running]) {
      assert(await exists(kept), kept);
    }
    assert(!await exists(nobody) && !await exists(uninstalled));
    // Nothing of the removed ones is left behind under another name.
    const names = (await Array.fromAsync(Deno.readDir(root))).map((e) =>
      e.name
    );
    assert(!names.some((n) => n.includes(".incoming.")), names.join(", "));
    assert(names.includes(AUTO_PRUNE_STAMP));

    // Once a day: the same day's next start removes nothing, though the lock
    // is free now…
    assertEquals(await autoPruneSharedStore({ running, log, root }), []);
    assert(await exists(locked));
    // …and the next day's does.
    assertEquals(
      await autoPruneSharedStore({
        running,
        log,
        root,
        now: new Date(Date.now() + DAY + 60_000),
      }),
      [locked],
    );
    assert(await exists(running) && await exists(installed));
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("auto-prune: an unreadable record keeps everything; a broken store is logged, never thrown", async () => {
  const tmp = await tempDir("shared-auto-prune-bad-");
  try {
    const root = join(tmp, "store");
    const old = await runtime(root, "1.0.0", AUTO_PRUNE_MIN_AGE_DAYS + 5);
    await Deno.mkdir(join(root, "apps"), { recursive: true });
    await Deno.writeTextFile(join(root, "apps", "broken.json"), "{not json");
    const log = { info: () => {}, error: () => {} };
    assertEquals(
      await autoPruneSharedStore({ running: "", log, root }),
      [],
    );
    assert(await exists(old));

    const file = join(tmp, "not-a-dir");
    await Deno.writeTextFile(file, "");
    const errors: string[] = [];
    assertEquals(
      await autoPruneSharedStore({
        running: "",
        log: { info: () => {}, error: (m) => errors.push(m) },
        root: file,
      }),
      [],
    );
    assertEquals(errors.length, 1, errors.join("\n"));
  } finally {
    await dropTempDir(tmp);
  }
});
