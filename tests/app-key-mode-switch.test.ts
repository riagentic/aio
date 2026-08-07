// An app that MOVES from shared-key auth to per-user auth must not leave its
// old `app.key` on disk. `am profile` reads that file directly and would export
// a dead credential as the current one — and it is not merely stale: switching
// the app back to `key: true` would resurrect it, so a key the operator believes
// was retired is live again.
//
// The complement matters just as much: a shared-key app that simply boots
// WITHOUT --expose must KEEP its key. "one key, use forever" is the promise
// every already-paired device depends on, and regenerating one is a worse bug
// than the stale file this test exists for.
import { assert, assertEquals } from "@std/assert";
import { appDirs } from "../src/server/app-dirs.ts";
import { freePort } from "../src/testing/server-test.ts";

const exists = (p: string): boolean => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Boot an app with the given extra config, then close it. */
async function boot(
  appId: string,
  baseDir: string,
  appDir: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const { cell, aio } = await import("../mod.ts");
  const c = cell(`k-${crypto.randomUUID().slice(0, 8)}`, {
    state: { n: 0 },
    visible: "all",
    methods: {},
  });
  const app = await aio.run({
    cells: [c],
    appId,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port: freePort(),
    baseDir,
    appDir,
    ...extra,
  });
  await app.close();
}

Deno.test({
  name: "app.key: per-user auth clears a stale shared key",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const appId = `keyswitch-${crypto.randomUUID().slice(0, 8)}`;
    const baseDir = await Deno.makeTempDir();
    const appDir = await Deno.makeTempDir();
    const path = appDirs(appId, appDir).appKey;

    // 1. Shared-key mode, exposed → a persisted key appears.
    await boot(appId, baseDir, appDir, { key: true, expose: true });
    assert(exists(path), `expected a persisted app.key at ${path}`);
    const original = Deno.readTextFileSync(path).trim();
    assert(original.length > 0, "app.key must not be empty");

    // 2. The app moves to per-user auth. The shared key can no longer
    //    authenticate anyone, so it must not survive as an exportable
    //    credential.
    await boot(appId, baseDir, appDir, {
      users: { "tok-a": { id: "a", role: "admin" } },
    });
    assertEquals(
      exists(path),
      false,
      "per-user auth must clear the dead shared key — am profile reads this " +
        "file and would export it as current",
    );
  },
});

Deno.test({
  name: "app.key: an unexposed boot KEEPS the key (one key, use forever)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const appId = `keykeep-${crypto.randomUUID().slice(0, 8)}`;
    const baseDir = await Deno.makeTempDir();
    const appDir = await Deno.makeTempDir();
    const path = appDirs(appId, appDir).appKey;

    await boot(appId, baseDir, appDir, { key: true, expose: true });
    const original = Deno.readTextFileSync(path).trim();

    // A plain local dev run — not exposed, so no key is resolved. That is NOT
    // evidence the key is dead, and clearing it here would mint a different one
    // on the next --expose and break every paired device.
    await boot(appId, baseDir, appDir, {});
    assert(exists(path), "an unexposed boot must not delete the app key");
    assertEquals(
      Deno.readTextFileSync(path).trim(),
      original,
      "the key must be byte-identical across an unexposed boot",
    );
  },
});
