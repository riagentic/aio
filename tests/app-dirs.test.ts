// The one-directory layout: `~/.<appId>/data/` is the whole backup, everything
// outside it is disposable, and three override levels each take one line.
// See docs/specs/2026-07-26-data-dir-and-updates.md.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  appDirs,
  appHome,
  ensureAppDirs,
  ensureAppPayloadDir,
  resolveAppDirs,
  sweepAppPayloadDir,
  unsafeUnpackWarning,
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

// ── The unpack payload dir (`<home>/app`) ────────────────────────────────────
// A packaged app unpacks ITSELF before any aio code runs, so the only defence
// is where its launcher points TMPDIR. `/tmp` was the wrong answer on four
// measured counts (see AppDirs.app) — these pin the properties that replaced it.

Deno.test("app/: private to its owner — $HOME is 0755, so 0700 is the fix", async () => {
  const base = await Deno.makeTempDir({ prefix: "aio-dirs-" });
  try {
    const d = appDirs("wallet", join(base, ".wallet"));
    assertEquals(d.app, join(base, ".wallet", "app"));
    assertEquals(ensureAppPayloadDir(d), d.app);
    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(d.app)).mode! & 0o777;
      assertEquals(
        mode,
        0o700,
        `app/ must be owner-only, got ${mode.toString(8)}`,
      );
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("app/: is NOT in the backup unit, and is NOT cache/", () => {
  const d = appDirs("wallet", "/tmp/x-wallet");
  assert(!d.app.includes("/data/"), "app/ is regenerable — never in a backup");
  assert(
    d.app !== d.cache,
    "app/ must be its own tier: cache/ promises delete-at-any-time, and the " +
      "tree a live process executes from cannot honour that",
  );
});

Deno.test("sweepAppPayloadDir: clears empty mount stubs, never a live tree", async () => {
  const base = await Deno.makeTempDir({ prefix: "aio-dirs-" });
  try {
    const d = appDirs("wallet", join(base, ".wallet"));
    ensureAppPayloadDir(d);
    // A crashed run's leftover: an EMPTY mount point.
    Deno.mkdirSync(join(d.app, ".mount_walletABC123"));
    // A mount point that is still populated — a live instance, or a real mount.
    Deno.mkdirSync(join(d.app, ".mount_walletLIVE99"));
    Deno.writeTextFileSync(
      join(d.app, ".mount_walletLIVE99", "AppRun"),
      "#!/bin/sh\n",
    );
    // The warm-start extraction: regenerable, but never collected — another
    // process may be executing it right now.
    Deno.mkdirSync(join(d.app, "appimage_extracted_deadbeef"));

    sweepAppPayloadDir(d);

    const left = [...Deno.readDirSync(d.app)].map((e) => e.name).sort();
    assertEquals(left, [".mount_walletLIVE99", "appimage_extracted_deadbeef"]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("sweepAppPayloadDir: a never-unpacked app is not an error", () => {
  const d = appDirs("wallet", "/tmp/aio-does-not-exist-" + crypto.randomUUID());
  sweepAppPayloadDir(d); // must not throw
});

Deno.test("unsafeUnpackWarning: warns only for a shared unpack location", async (t) => {
  const expected = "/home/u/.wallet/app";

  await t.step("not packaged → nothing to say", () => {
    assertEquals(
      unsafeUnpackWarning({
        appDir: "/tmp/.mount_walletXY",
        expected,
        parentWorldWritable: true,
      }),
      null,
    );
  });

  await t.step("unpacked where we asked → silent", () => {
    for (const appDir of [expected, expected + "/.mount_walletXY"]) {
      assertEquals(
        unsafeUnpackWarning({
          appImage: "/opt/wallet.AppImage",
          appDir,
          expected,
          parentWorldWritable: true,
        }),
        null,
      );
    }
  });

  await t.step("a deliberate private TMPDIR is not a warning", () => {
    // Disagreeing with our default is not the hazard — a SHARED directory is.
    assertEquals(
      unsafeUnpackWarning({
        appImage: "/opt/wallet.AppImage",
        appDir: "/srv/apps/.mount_walletXY",
        expected,
        parentWorldWritable: false,
      }),
      null,
    );
  });

  await t.step("/tmp → loud, and says exactly how to fix it", () => {
    const msg = unsafeUnpackWarning({
      appImage: "/opt/wallet.AppImage",
      appDir: "/tmp/appimage_extracted_deadbeef",
      expected,
      parentWorldWritable: true,
    });
    assert(msg, "a world-writable unpack must never be silent");
    assert(msg.includes("/tmp/appimage_extracted_deadbeef"), "names the place");
    assert(
      msg.includes(`TMPDIR=${expected} /opt/wallet.AppImage`),
      `must carry the runnable fix, got: ${msg}`,
    );
  });
});
