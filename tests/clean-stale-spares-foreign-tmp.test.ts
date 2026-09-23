// `check-orphans.ts --clean-stale` — which `deno task test` runs at the START of
// every suite — treated EVERY `/tmp/aio*` directory with no live lock in it as
// "a finished run's lock dir" and removed it, recursively, with no age check.
// Lock dirs are named `aio` / `aio-<scope>`, and so is every other aio temp dir:
// a macOS `.dmg` build staging `payload.tgz` under `/tmp/aio-dmg-*` lost it
// between `tar` and `scp` while a suite started beside it (a field report, #7).
//
// Pinned here by running the real script against `aio*` fixtures in a
// throwaway root it is told to scan INSTEAD of `/tmp` and the runtime dir
// (`AIO_ORPHANS_LOCK_ROOTS`) — a test never sweeps the machine's real dirs:
//   • a directory that holds anything a lock dir never holds is not a lock dir,
//     however old, and survives;
//   • a lock-shaped directory touched in the last ten minutes survives (a run
//     that is creating it right now);
//   • an old lock-shaped directory with no live lock is still swept — the job
//     the sweep exists for.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const OLD = new Date(Date.now() - 60 * 60_000); // an hour ago

/** The fake lock root this file's scans are pinned to. */
let ROOTDIR = "";
async function fixture(name: string, files: Record<string, string>) {
  const dir = join(ROOTDIR, name);
  await Deno.mkdir(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, f), body);
  }
  return dir;
}

const exists = (p: string) => Deno.stat(p).then(() => true).catch(() => false);

/** The script, pinned to ROOTDIR (and run FROM it, so the suite's own
 *  `.aio/lock-dirs-baseline.json` is never overwritten). */
function script(...args: string[]): Deno.Command {
  return new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${ROOT}scripts/check-orphans.ts`, ...args],
    cwd: ROOTDIR,
    env: {
      AIO_ORPHANS_LOCK_ROOTS: ROOTDIR,
      AIO_TEST_ROOT: join(ROOTDIR, "test-root"),
    },
    stdout: "piped",
    stderr: "piped",
  });
}

async function cleanStale(): Promise<string> {
  const out = await script("--clean-stale").output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 0, text);
  return text;
}

Deno.test({
  name:
    "clean-stale: an aio-* dir that is not a lock dir survives; a stale lock dir does not",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    ROOTDIR = await tempDir("orphans-root-");
    const tag = crypto.randomUUID().slice(0, 8);
    // A build's staging dir: an hour old and holding a payload — the #7 shape.
    const staging = await fixture(`aio-dmg-cst-${tag}`, {
      "payload.tgz": "not a lock",
    });
    // A lock-shaped dir (a dead pid's lock) that something made seconds ago.
    const fresh = await fixture(`aio-cst-fresh-${tag}`, {
      "x.lock": JSON.stringify({ pid: 2 ** 22 + 7, appId: "x" }),
    });
    // The real debris: an old lock dir whose only lock names a dead pid.
    const stale = await fixture(`aio-cst-stale-${tag}`, {
      "x.lock": JSON.stringify({ pid: 2 ** 22 + 7, appId: "x" }),
    });
    // A nested display's cookie lives in an `aio*` dir too (nested-display.ts),
    // with no lock beside it — and a live display needs it. Sweeping that
    // directory would take the cookie with it.
    const cookie = await fixture(`aio-cst-cookie-${tag}`, {
      "dead.lock": JSON.stringify({ pid: 2 ** 22 + 7, appId: "x" }),
      "xephyr-77.auth": "cookie-bytes",
    });
    await Deno.utime(join(staging, "payload.tgz"), OLD, OLD);
    await Deno.utime(staging, OLD, OLD);
    await Deno.utime(join(stale, "x.lock"), OLD, OLD);
    await Deno.utime(stale, OLD, OLD);
    await Deno.utime(join(cookie, "xephyr-77.auth"), OLD, OLD);
    await Deno.utime(cookie, OLD, OLD);
    try {
      const said = await cleanStale();
      assertEquals(
        await exists(join(staging, "payload.tgz")),
        true,
        `a non-lock /tmp/aio-* dir was swept as a stale lock dir:\n${said}`,
      );
      assertEquals(
        await exists(fresh),
        true,
        `a lock dir touched seconds ago was swept:\n${said}`,
      );
      assertEquals(
        await exists(stale),
        false,
        `an hour-old lock dir with no live lock must still be swept:\n${said}`,
      );
      assertEquals(
        await exists(join(cookie, "xephyr-77.auth")),
        true,
        `a nested display's cookie was swept with its directory:\n${said}`,
      );
    } finally {
      await dropTempDir(ROOTDIR); // every fixture lives under it
    }
  },
});

// …and the sweep must still REMOVE what it empties. `--clean` deletes the dead
// locks inside a directory first, and removing a file bumps that directory's
// mtime to NOW — so the "touched in the last ten minutes ⇒ a run is making it
// right now" check, asked afterwards, answered about this very process's own
// work: `clean:tmp` emptied every stale lock dir and then reported "0 stale
// lock dir(s) removed". The mtime is read before the pass touches anything.
Deno.test({
  name: "clean: a stale lock dir is removed, not merely emptied",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    ROOTDIR = await tempDir("orphans-root-");
    const tag = crypto.randomUUID().slice(0, 8);
    const dir = await fixture(`aio-cln-${tag}`, {
      "x.lock": JSON.stringify({ pid: 2 ** 22 + 7, appId: "x" }),
    });
    await Deno.utime(join(dir, "x.lock"), OLD, OLD);
    await Deno.utime(dir, OLD, OLD);
    try {
      // `--clean --clean-stale`: the stale-only branch returns before anything
      // is signalled or any temp home is removed, so this sweeps debris only —
      // what `--clean-stale` does, plus the dead lock FILES that make the
      // difference here.
      const out = await script("--clean", "--clean-stale").output();
      const said = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, said);
      assertEquals(
        await exists(dir),
        false,
        `the stale lock dir survived the sweep that emptied it:\n${said}`,
      );
    } finally {
      await dropTempDir(ROOTDIR); // the fixture lives under it
    }
  },
});
