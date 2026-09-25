// A test must not be able to write the developer's REAL per-user stores.
//
// MEASURED, 2026-09-24 10:39: a test wrote a mid-development snapshot of aio
// into `~/.local/lib/aio-versions/v1.0.11-beta` (+ `.provisioned`) under the
// real release name — its `.git` pointed into the sandbox of
// tests/am-version-pin.test.ts. Two real apps ran that fake release for hours,
// and `am pin` would not replace it (a provisioned version is immutable).
//
// The store comes from `AIO_VERSIONS_DIR` (default `~/.local/lib/aio-versions`),
// and nothing but each test's own `Deno.env.set`/restore kept it off the real
// one: a test that forgot, or a restore that deleted the variable while
// another test in the process still provisioned, and the real store was
// written. The harness sandboxed `AIO_APPS_DIR` for exactly this reason and not
// the stores beside it. Now the harness (and every `tempDir`) pins each such
// store into the test root, and the shard runner pins them per shard.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import {
  _armTestStrict,
  aioTestRoot,
  HOME_STORE_VARS,
} from "../src/testing/test-strict.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { versionsDir } from "../src/server/framework-pin.ts";
import { feedbackDir } from "../src/am/am-cmd-feedback.ts";
import { installRoot } from "../src/server/app-dirs.ts";
import { shardEnv } from "../scripts/test-shards.ts";

const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
const VARS = [
  "AIO_VERSIONS_DIR",
  "AIO_FEEDBACK_DIR",
  "AIO_INSTALL_ROOT",
  "AIO_HOME",
] as const;

/** Run `fn` with every store variable UNSET (as a single-file `deno test`
 *  starts), handing the process env back exactly afterwards. */
async function withStoresUnset(fn: () => void | Promise<void>): Promise<void> {
  const prev = new Map(VARS.map((k) => [k, Deno.env.get(k)]));
  for (const k of VARS) Deno.env.delete(k);
  try {
    await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

function assertSandboxed(path: string, what: string): void {
  const root = aioTestRoot();
  assert(
    path.startsWith(root + "/"),
    `${what} resolved to ${path}, outside the test root ${root}`,
  );
}

Deno.test("home stores: under the harness with no AIO_VERSIONS_DIR set, versionsDir() is under the test root, never the real HOME", async () => {
  await withStoresUnset(() => {
    _armTestStrict();
    const dir = versionsDir();
    assertSandboxed(dir, "versionsDir()");
    assertNotEquals(dir, join(HOME, ".local", "lib", "aio-versions"));
  });
});

Deno.test("home stores: tempDir() alone arms the sandbox — the am-version-pin shape, no harness call", async () => {
  await withStoresUnset(async () => {
    await tempDir("aio-store-probe-");
    assertSandboxed(versionsDir(), "versionsDir()");
  });
});

Deno.test("home stores: every per-user store a test can write is sandboxed, not just the version store", async () => {
  await withStoresUnset(() => {
    _armTestStrict();
    assertEquals([...HOME_STORE_VARS].sort(), [...VARS].sort());
    assertSandboxed(versionsDir(), "versionsDir()");
    assertSandboxed(feedbackDir(), "feedbackDir()");
    assertSandboxed(installRoot(), "installRoot()");
    assertSandboxed(Deno.env.get("AIO_HOME")!, "AIO_HOME");
    // Four DIFFERENT places: a shared one would let `am pin` provision into
    // the directory `am update` treats as the install.
    assertEquals(new Set(VARS.map((k) => Deno.env.get(k))).size, VARS.length);
  });
});

Deno.test("home stores: a test's own value wins, and a restore that DELETES the var is re-pinned at the next arm", async () => {
  await withStoresUnset(async () => {
    const own = await tempDir("aio-own-store-");
    Deno.env.set("AIO_VERSIONS_DIR", own);
    _armTestStrict();
    assertEquals(versionsDir(), own, "the harness overrode a test's own dir");
    // tests/am-pin-seal.test.ts's shape: set, then `Deno.env.delete` — which
    // left the REAL store as the answer for the rest of the process.
    Deno.env.delete("AIO_VERSIONS_DIR");
    await tempDir("aio-store-probe-");
    assertSandboxed(versionsDir(), "versionsDir() after a delete");
  });
});

Deno.test("home stores: the shard runner pins every store per shard, beside (not inside) its apps dir", () => {
  const home = "/r/.aio-test-shards/3/.aio-test-home";
  const env = shardEnv(3, 8, "/tmp/xdg-shard-3", { home, realWindow: false });
  const win = shardEnv(0, 8, null, { home, realWindow: true });
  for (const k of VARS) {
    assert(env[k], `shard env is missing ${k}`);
    assert(env[k]!.startsWith("/r/.aio-test-shards/3/"), `${k}=${env[k]}`);
    assert(!env[k]!.startsWith(home + "/"), `${k} inside AIO_APPS_DIR`);
    assertEquals(win[k], env[k], `the real-window shard must pin ${k} too`);
  }
  assertEquals(new Set(VARS.map((k) => env[k])).size, VARS.length);
});
