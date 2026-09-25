// `sessions: true` ALONE is per-user auth: the server resolves every request
// through the session store (server.ts `_userResolver`), and that path always
// returns — so a shared app key can never authenticate anything there.
//
// aio.ts decided "per-user" from users/resolveUser/auth only, so an exposed
// sessions-only app got the alpha52 default `key: true`: a generated app.key,
// a `share: …?token=<key>` link, a pair code, and `/__aio/pair` handing the key
// out — and every one of those answered 401 (measured on a real loopback
// server). A credential advertised as the way in that lets nobody in.
import { tempDir } from "../src/testing/temp-dir.ts";
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

async function boot(
  appId: string,
  appDir: string,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const { cell, aio } = await import("../mod.ts");
  const c = cell(`s-${crypto.randomUUID().slice(0, 8)}`, {
    state: { n: 0 },
    visible: "all",
    methods: {},
  });
  const app = await aio.run({
    cells: [c],
    appId,
    client: "server-only",
    persist: false,
    libraryMode: true,
    port: freePort(),
    host: "127.0.0.1",
    baseDir: await tempDir("aio-sess-only-"),
    appDir,
    ...extra,
  });
  const hasSessions = !!app.sessions;
  await app.close();
  return hasSessions;
}

Deno.test({
  name: "sessions-only app under --expose generates no dead shared key",
  async fn() {
    const appId = `sessexp-${crypto.randomUUID().slice(0, 8)}`;
    const appDir = await tempDir("aio-sess-only-");
    const path = appDirs(appId, appDir).appKey;
    assert(await boot(appId, appDir, { sessions: true, expose: true }));
    assertEquals(
      exists(path),
      false,
      "a sessions-only app authenticates by session token; a generated " +
        "app.key (and the share link / pair code built on it) can only 401",
    );
  },
});

Deno.test({
  name: "sessions-only app ignores an explicit key instead of advertising it",
  async fn() {
    const appId = `sesskey-${crypto.randomUUID().slice(0, 8)}`;
    const appDir = await tempDir("aio-sess-only-");
    const path = appDirs(appId, appDir).appKey;
    assert(
      await boot(appId, appDir, { sessions: true, key: true, expose: true }),
    );
    assertEquals(
      exists(path),
      false,
      "the per-user gate never consults the key — resolving it only mints a " +
        "share link and pair code that 401",
    );
  },
});

Deno.test({
  name: "sessions-only app clears a stale shared key like users mode does",
  async fn() {
    const appId = `sessstale-${crypto.randomUUID().slice(0, 8)}`;
    const appDir = await tempDir("aio-sess-only-");
    const path = appDirs(appId, appDir).appKey;
    await boot(appId, appDir, { key: true, expose: true });
    assert(exists(path), `expected a persisted app.key at ${path}`);
    assert(await boot(appId, appDir, { sessions: true }));
    assertEquals(
      exists(path),
      false,
      "per-user (sessions) mode must clear the dead shared key — am profile " +
        "reads this file and would export it as current",
    );
  },
});
