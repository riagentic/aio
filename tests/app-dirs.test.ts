// The one-directory layout: `~/.<appId>/data/` is the whole backup, everything
// outside it is disposable, and three override levels each take one line.
// See docs/specs/2026-07-26-data-dir-and-updates.md.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  appDirs,
  appHome,
  ensureAppDirs,
  resolveAppDirs,
  writeAppMeta,
} from "../src/server/app-dirs.ts";
import { homedir } from "../src/server/paths.ts";

function withEnv(vars: Record<string, string | null>, fn: () => void): void {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, Deno.env.get(k));
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("appHome: default is ~/.<appId> — the convention users already know", () => {
  withEnv({ AIO_APPS_DIR: null }, () => {
    const home = Deno.env.get("HOME")!;
    assertEquals(appHome("wallet"), join(home, ".wallet"));
  });
});

Deno.test("appHome: AIO_APPS_DIR groups EVERY app under one root", () => {
  withEnv({ AIO_APPS_DIR: "/srv/aio" }, () => {
    assertEquals(appHome("wallet"), "/srv/aio/wallet");
    assertEquals(appHome("notes"), "/srv/aio/notes");
  });
});

Deno.test("appHome: the root wins over the default, and adds no dot", () => {
  // There is deliberately no per-app env override: `AIO_APPS_DIR=/var/lib`
  // already yields `/var/lib/wallet`, and a third spelling of "put it here" is
  // what made the names unreadable. The author's `appDir` covers the rest.
  withEnv({ AIO_APPS_DIR: "/srv/aio" }, () => {
    assertEquals(appHome("wallet"), "/srv/aio/wallet");
    // The dot is a home-directory convention only — a dedicated root needn't hide.
    assert(!appHome("wallet").includes("/.wallet"));
    // The author still outranks the operator.
    assertEquals(appHome("wallet", "/opt/wallet"), "/opt/wallet");
  });
});

Deno.test("appDirs: everything critical is inside data/, nothing else is", () => {
  const d = appDirs("wallet", "/tmp/x-wallet");
  // ① the backup unit
  for (const p of [d.stateDb, d.authDb, d.journal, d.tls, d.files, d.meta]) {
    assert(
      p.startsWith("/tmp/x-wallet/data/"),
      `critical path must live in data/: ${p}`,
    );
  }
  // ② disposable — deliberately OUTSIDE data/, so `cp -r data/` is exact
  assertEquals(d.logs, "/tmp/x-wallet/logs");
  assertEquals(d.launch, "/tmp/x-wallet/launch.json");
  for (const p of [d.logs, d.launch]) {
    assert(!p.includes("/data/"), `must not be in the backup unit: ${p}`);
  }
});

Deno.test("ensureAppDirs: data/ is 0700 — it holds auth.db and a TLS key", async () => {
  const base = await Deno.makeTempDir({ prefix: "aio-dirs-" });
  try {
    const d = appDirs("wallet", join(base, ".wallet"));
    ensureAppDirs(d);
    assertEquals((await Deno.stat(d.data)).isDirectory, true);
    assertEquals((await Deno.stat(d.logs)).isDirectory, true);
    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(d.data)).mode! & 0o777;
      assertEquals(
        mode,
        0o700,
        `data/ must be owner-only, got ${mode.toString(8)}`,
      );
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("writeAppMeta: self-describing archive, and createdAt survives rewrites", async () => {
  const base = await Deno.makeTempDir({ prefix: "aio-dirs-" });
  try {
    const d = appDirs("wallet", join(base, ".wallet"));
    ensureAppDirs(d);
    writeAppMeta(d, { appId: "wallet", aio: "1.0.0-alpha37", app: "1.4.0" });
    const first = JSON.parse(await Deno.readTextFile(d.meta));
    assertEquals(first.appId, "wallet");
    assertEquals(first.aio, "1.0.0-alpha37");
    assertEquals(first.app, "1.4.0");

    await new Promise((r) => setTimeout(r, 5));
    writeAppMeta(d, { appId: "wallet", aio: "1.0.0-alpha38" });
    const second = JSON.parse(await Deno.readTextFile(d.meta));
    assertEquals(second.createdAt, first.createdAt, "createdAt is preserved");
    assert(second.updatedAt >= first.updatedAt, "updatedAt advances");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("writeAppMeta: a read-only home never fails a boot", () => {
  const d = appDirs("wallet", "/proc/nonexistent-cannot-write");
  writeAppMeta(d, { appId: "wallet", aio: "x" }); // must not throw
});

// libraryMode is the "you are not the user's app" switch: a test or a host
// process owns the runtime, so nothing may be written into the user's home. That
// rule has to be applied by BOTH boot entries, because the logger resolves its
// directory before the inner boot runs — when it wasn't, a libraryMode app's
// logs went to `~/.<appId>/logs`, the one place libraryMode exists to avoid.
Deno.test("resolveAppDirs: libraryMode never resolves into the home", () => {
  withEnv({ AIO_APPS_DIR: null }, () => {
    const base = "/tmp/aio-libmode-base";
    const lib = resolveAppDirs({
      appId: "wallet",
      libraryMode: true,
      baseDir: base,
    });
    assertEquals(lib.home, join(base, ".aio"));
    assert(
      !lib.logs.startsWith(homedir()),
      `libraryMode logs must stay under baseDir, got ${lib.logs}`,
    );

    // Not libraryMode → the normal default.
    const app = resolveAppDirs({ appId: "wallet" });
    assertEquals(app.home, join(homedir(), ".wallet"));

    // An explicit appDir outranks libraryMode's baseDir rule.
    const pinned = resolveAppDirs({
      appId: "wallet",
      libraryMode: true,
      baseDir: base,
      appDir: "/srv/wallet",
    });
    assertEquals(pinned.home, "/srv/wallet");
  });
});
