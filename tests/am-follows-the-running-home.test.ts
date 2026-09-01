// `am` reads the invoking user's HOME, not the running instance's.
//
// Field report, filed TWICE from two different apps: `am logs` answers
//
//     no log file at ~/.<appId>/logs/stdout.log
//
// about an app that is up and writing — because every `am` reader of an app's
// files computed its directory from the environment of the process the command
// was TYPED in (`$HOME`, `$AIO_APPS_DIR`), not from where the app it is
// inspecting actually lives. The two agree in the common case and part company
// exactly when it matters: an app booted with `appDir` (the packaged Electron
// shape), one started by a service manager, an `am` run as another user.
//
// It is the same root cause as a compiled binary serving `<cwd>/src` and the
// generated systemd unit's `User=$USER`: an environment that was true where the
// command was typed, applied to a process that lives somewhere else.
//
// The lock already carries the answer (`LockData.home`), and `targetHome` was
// already the one seam that makes every `appDirs()` reader follow it. So the
// fix applies an existing rule without being asked, and these tests pin the
// four cases where it must NOT.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  _resetHomePin,
  adoptRunningHome,
  targetHome,
} from "../src/am/am-utils.ts";
import { logPathFor } from "../src/am/am-cmd-inspect.ts";
import { _resetAppDirs, appDirs } from "../src/server/app-dirs.ts";
import {
  type LockData,
  lockDir,
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";

const APP = "homeprobe";

/** A lock for a live instance of `APP` running from `home`. Owned by THIS
 *  process, so the liveness check (by owner, not by pid) says alive. */
function liveLockAt(home: string): () => void {
  const data: LockData = {
    appId: APP,
    pid: Deno.pid,
    port: 0,
    startedAt: Date.now(),
    status: "started",
    cwd: Deno.cwd(),
    home,
  };
  writeLock(data);
  return () => removeLock(lockKey(APP, home));
}

/** Run `fn` with a throwaway apps root — so "the home am computes" is a real
 *  directory that is NOT where the fake instance runs from. */
async function withApps(
  fn: (opts: { computed: string; foreign: string }) => void | Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "aio-amhome-" });
  const foreign = await Deno.makeTempDir({ prefix: "aio-amhome-foreign-" });
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", root);
  _resetAppDirs();
  _resetHomePin();
  try {
    const computed = appDirs(APP).home;
    Deno.mkdirSync(join(computed, "logs"), { recursive: true });
    Deno.mkdirSync(join(foreign, "logs"), { recursive: true });
    await fn({ computed, foreign });
  } finally {
    // The LOCK dir too, while AIO_APPS_DIR still names it: `lockDir()` scopes
    // its name by that variable, so a test that points it at a temp home
    // leaves a `<runtime>/aio-<scope>` directory behind that removing the apps
    // dir does not touch. `check:orphans` counts those, and they are exactly
    // what it means by "invisible one at a time".
    await Deno.remove(lockDir(), { recursive: true }).catch(() => {});
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    _resetAppDirs();
    _resetHomePin();
    await Deno.remove(root, { recursive: true }).catch(() => {});
    await Deno.remove(foreign, { recursive: true }).catch(() => {});
  }
}

Deno.test("am: the running instance's home wins over the computed one", () =>
  withApps(async ({ computed, foreign }) => {
    // The app is up, from a home `am` would never have guessed, and it is
    // logging there.
    const drop = liveLockAt(foreign);
    Deno.writeTextFileSync(join(foreign, "logs", "app.log"), "real\n");
    try {
      adoptRunningHome(APP);
      const p = logPathFor({ app: APP } as never);
      assertStringIncludes(p, foreign);
      assert(
        !p.startsWith(computed),
        `am must not report a path under the home it computed for itself: ${p}`,
      );
      // Not just `am logs` — the adoption is at the directory decider, so
      // every reader of the app's files follows the same instance.
      assertEquals(appDirs(APP).home, foreign);
    } finally {
      drop();
      await Promise.resolve();
    }
  }));

Deno.test("am: `--home` still wins — adoption never retargets an operator", () =>
  withApps(async ({ foreign }) => {
    const pinned = await Deno.makeTempDir({ prefix: "aio-amhome-pinned-" });
    const drop = liveLockAt(foreign);
    try {
      // `am --home=X logs` means X's instance. Silently answering with a
      // different one is exactly the failure `--home` exists to prevent.
      targetHome(APP, pinned);
      adoptRunningHome(APP);
      assertEquals(appDirs(APP).home, pinned);
    } finally {
      drop();
      await Deno.remove(pinned, { recursive: true }).catch(() => {});
    }
  }));

Deno.test("am: nothing running changes nothing", () =>
  withApps(({ computed }) => {
    // The default home is the only answer here — and the right one for
    // `am remove` / `am logs` after a crash, where the files outlive the app.
    adoptRunningHome(APP);
    assertEquals(appDirs(APP).home, computed);
  }));

Deno.test("am: two instances of one id are an ambiguity, not a guess", () =>
  withApps(async ({ computed, foreign }) => {
    const second = await Deno.makeTempDir({ prefix: "aio-amhome-second-" });
    const dropA = liveLockAt(foreign);
    const dropB = liveLockAt(second);
    try {
      // `liveLock` already names the `--home=` that resolves this. Picking one
      // here would be a silent retarget that reads as a working command.
      adoptRunningHome(APP);
      assertEquals(appDirs(APP).home, computed);
    } finally {
      dropA();
      dropB();
      await Deno.remove(second, { recursive: true }).catch(() => {});
    }
  }));
