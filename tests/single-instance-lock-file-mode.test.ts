// The lock FILE is private (0600) on both of `publishExclusive`'s paths.
//
// It names the owner's pid, cwd and home. The ordinary path writes a 0600 tmp
// and hard-links it into place; a filesystem WITHOUT hard links takes the
// fallback — an exclusive create — which passed no mode, so there the lock
// came out at the umask default (0644: readable by every local user). The
// fallback is forced the way single-instance-lock-publish.test.ts observes
// the calls: `Deno.linkSync` swapped for one that says "not supported".
//
// Under a PERMISSIVE umask (022), set here: a machine whose umask is already
// 077 creates every file 0600, and the check would pass with no mode at all
// (this one's does — the first version of this test was green on the bug).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";
import {
  AppLock,
  lockKey,
  lockPath,
} from "../src/server/single-instance-lock.ts";

async function withAppsDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await tempDir("lock-mode-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  try {
    return await fn(dir);
  } finally {
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
  }
}

/** Acquire, read the lock file's permission bits, update, read again. */
async function modes(appId: string, noLink: boolean): Promise<number[]> {
  const umask = Deno.umask(0o022);
  try {
    return await modesUnder022(appId, noLink);
  } finally {
    Deno.umask(umask);
  }
}

async function modesUnder022(
  appId: string,
  noLink: boolean,
): Promise<number[]> {
  return await withAppsDir(async (dir) => {
    // The control: a file created with no mode is group/world-readable now.
    const control = join(dir, "control");
    Deno.writeTextFileSync(control, "");
    assertEquals(
      Deno.statSync(control).mode! & 0o777,
      0o644,
      "the umask did not take — every mode check below would be vacuous",
    );
    const home = join(dir, "home");
    const path = lockPath(lockKey(appId, home));
    // deno-lint-ignore no-explicit-any
    const D = Deno as any;
    const link = D.linkSync;
    let linkCalls = 0;
    if (noLink) {
      D.linkSync = () => {
        linkCalls++;
        throw new Deno.errors.NotSupported("no hard links on this filesystem");
      };
    }
    const lock = new AppLock(appId, home);
    try {
      const r = await lock.acquire(0);
      if (!r.ok) throw new Error(JSON.stringify(r));
      const out = [Deno.statSync(path).mode! & 0o777];
      lock.update({ port: 1234 }); // replaced in place (tmp → rename)
      out.push(Deno.statSync(path).mode! & 0o777);
      if (noLink && linkCalls === 0) {
        throw new Error("the fallback was never taken — the check is vacuous");
      }
      return out;
    } finally {
      D.linkSync = link;
      lock.release();
    }
  });
}

Deno.test({
  name: "lock file mode: 0600 on the hard-link path",
  ignore: Deno.build.os === "windows",
  async fn() {
    assertEquals(await modes("mode-link", false), [0o600, 0o600]);
  },
});

Deno.test({
  name: "lock file mode: 0600 on the no-hard-link fallback",
  ignore: Deno.build.os === "windows",
  async fn() {
    assertEquals(await modes("mode-nolink", true), [0o600, 0o600]);
  },
});
