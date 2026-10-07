// updates-e2e.test.ts — the whole update path against a real `file://` source.
//
// A local source is a first-class one, not a test fixture: air-gapped installs
// and LAN deployments use exactly this. So this drives the shipped code end to
// end — publish v2, check, apply, assert the artifact was replaced — and then
// the refusals, which are the half that has to be right.
import { EXE, programBytes, writeProgram } from "./fake-program-helper.ts";
import { zipTree } from "./zip-helper.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basename, join } from "@std/path";
import {
  buildReleaseManifest,
  buildShipManifest,
  generateSigningKey,
  type ShipManifest,
} from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import {
  failedUpdatePath,
  firstBootPath,
  type PendingMark,
  readPending,
  writePending,
} from "../src/server/updates-apply.ts";
import {
  judgePendingUpdate,
  startUpdates,
} from "../src/server/updates-boot.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import { readTrust, writeTrust } from "../src/server/updates-check.ts";
import { identity, readOwned } from "../src/server/updates-owned.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };

/** A stand-in artifact that RUNS.
 *
 *  Not decoration: the swap smoke-tests the staged artifact from the
 *  predecessor before replacing anything, so a stand-in that cannot execute is
 *  refused — which is exactly the protection that test wants, and exactly why
 *  these fixtures have to be real programs rather than text. */
const appBody = (v: string) =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${v}; exit 0; fi\necho APP ${v}\n`;

/** Wait for the restart `apply()` scheduled.
 *
 *  `apply()` no longer performs the handover inline: it is a cell method, and
 *  driving `shutdown()` from inside one made the app wait out its own settle
 *  grace on the very call that asked for it, then log "writes are lost" on
 *  every SUCCESSFUL update. The runtime defers it by a macrotask and keeps the
 *  promise so a test can still assert the shutdown/relaunch/exit happened. */
function settle(rt: { handover?: Promise<void> | null }): Promise<void> {
  return rt.handover ?? Promise.resolve();
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

type Rig = {
  root: string;
  dataDir: string;
  artifact: string;
  releases: string;
  keys: { publicKey: JsonWebKey; privateKey: JsonWebKey };
};

async function rig(): Promise<Rig> {
  const root = await Deno.makeTempDir({ prefix: "aio-upd-e2e-" });
  const dataDir = join(root, "data");
  const releases = join(root, "releases");
  await Deno.mkdir(dataDir, { recursive: true });
  const artifact = join(root, "app");
  // Byte-identical to what `publish({version:"1.0.0"})` writes. It has to be:
  // a DIFFERENT build of the same version is now a detectable update, so an
  // artifact whose bytes do not match the published 1.0.0 is not "up to date".
  await writeProgram(artifact, appBody("1.0.0"));
  return {
    root,
    dataDir,
    artifact,
    releases,
    keys: await generateSigningKey(),
  };
}

/** Publish a release the way a CI job would: an artifact and its manifest,
 *  side by side, under `<channel>/`. */
async function publish(r: Rig, opts: {
  version: string;
  channel: string;
  body?: string;
  sign?: boolean;
  data?: ShipManifest["data"];
  notes?: string;
  minFrom?: string;
  /** Corrupt the artifact AFTER the manifest is written. */
  corrupt?: boolean;
  /** Corrupt it to the SAME LENGTH — the realistic attack, and the only shape
   *  the digest check is the thing that catches. An attacker who can replace
   *  the artifact but not the signed manifest matches the size, because the
   *  size is inside the signature and a mismatch is refused before a byte of
   *  the body is hashed. */
  corruptSameSize?: boolean;
}): Promise<ShipManifest> {
  const dir = join(r.releases, opts.channel);
  await Deno.mkdir(dir, { recursive: true });
  const fileName = `app-${opts.version}`;
  const bytes = await programBytes(opts.body ?? appBody(opts.version));
  const manifest = await buildShipManifest({
    name: "app",
    version: opts.version,
    binary: bytes,
    sources: [],
    sign: opts.sign === false ? undefined : r.keys,
    channel: opts.channel,
    target: "binary",
    platform,
    url: fileName,
    notes: opts.notes,
    minFrom: opts.minFrom,
    data: opts.data ??
      { schema: 1, cells: { todos: { version: 1, migratesFrom: 1 } } },
  });
  const onDisk = opts.corruptSameSize
    // Same length, different bytes: flip the last byte of the body.
    ? (() => {
      const c = bytes.slice();
      c[c.length - 1] = c[c.length - 1]! ^ 0xff;
      return c;
    })()
    : opts.corrupt
    ? new TextEncoder().encode("TAMPERED")
    : bytes;
  await Deno.writeFile(join(dir, fileName), onDisk);
  await Deno.writeTextFile(
    join(dir, `${platform.os}-${platform.arch}.json`),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

function runtimeFor(r: Rig, opts: {
  /** Collects every `log.error` line. */
  errors?: string[];
  channel?: string;
  appVersion?: string;
  cells?: Record<string, number>;
  auto?: boolean;
  prerelease?: boolean;
  exits?: number[];
  snapshots?: string[];
  relaunched?: string[];
}) {
  const config = resolveUpdates({
    source: `file://${r.releases}`,
    channel: opts.channel ?? "prod",
    auto: opts.auto,
    prerelease: opts.prerelease,
  });
  return createUpdatesRuntime({
    config,
    dataDir: r.dataDir,
    appVersion: opts.appVersion ?? "1.0.0",
    local: { schema: 1, cells: opts.cells ?? { todos: 1 } },
    exposed: false,
    log: opts.errors
      ? {
        ...silentLog,
        error: (...a: unknown[]) =>
          void opts.errors!.push(a.map(String).join(" ")),
      } as Log
      : silentLog,
    argv: [],
    artifact: r.artifact,
    canInstall: ["binary"],
    // Never actually hand over in a test — assert that we would have.
    exit: (code) => void opts.exits?.push(code),
    relaunch: ({ artifact }) => void opts.relaunched?.push(artifact),
    shutdown: () => Promise.resolve(),
    snapshot: async (path) => {
      opts.snapshots?.push(path);
      await Deno.writeTextFile(path, "SNAPSHOT");
    },
  });
}

Deno.test("updates e2e: publish → check → apply replaces the artifact", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "1.0.0", channel: "prod" });
    const exits: number[] = [];
    const relaunched: string[] = [];

    // Nothing newer yet.
    const same = runtimeFor(r, { exits, relaunched });
    assertEquals((await same.check({ dismissed: null })).kind, "current");

    // Ship 2.0.0.
    await publish(r, { version: "2.0.0", channel: "prod", notes: "faster" });
    const rt = runtimeFor(r, { exits, relaunched });
    const found = await rt.check({ dismissed: null });
    assertEquals(found.kind, "offer");
    if (found.kind === "offer") {
      assertEquals(found.update.version, "2.0.0");
      assertEquals(found.update.notes, "faster");
      assertEquals(found.update.migrates, false);
    }

    await rt.apply();
    await settle(rt);

    // The artifact on disk IS the new version, the old one is kept beside it,
    // and the handover was requested.
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("2.0.0")),
    );
    assertEquals(
      await Deno.readFile(`${r.artifact}.old-1.0.0`),
      await programBytes(appBody("1.0.0")),
    );
    assertEquals(exits, [0]);
    // The successor is started from the SAME path — which now holds v2.
    assertEquals(relaunched, [r.artifact]);

    // …and a marker exists so the next boot can verify or undo it.
    const pending = readPending(r.dataDir);
    assertEquals(pending?.from, "1.0.0");
    assertEquals(pending?.to, "2.0.0");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// A relaunch that fails runs after shutdown too: its line reached no log. It
// is carried on the marker, and the next boot of the new version says it.
Deno.test("updates e2e: a handover that fails after shutdown is said by the next boot", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "2.0.0", channel: "prod" });
    let loggerOpen = true;
    const errors: string[] = [];
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${r.releases}`,
        channel: "prod",
      }),
      dataDir: r.dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: { todos: 1 } },
      exposed: false,
      log: {
        ...silentLog,
        error: (...a: unknown[]) =>
          void (loggerOpen && errors.push(a.map(String).join(" "))),
      } as Log,
      argv: [],
      artifact: r.artifact,
      canInstall: ["binary"],
      exit: () => {},
      relaunch: () => {
        throw new Deno.errors.PermissionDenied("spawn refused");
      },
      shutdown: () => Promise.resolve(void (loggerOpen = false)),
    });
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    await rt.apply();
    await settle(rt);
    assertEquals(errors, []);
    const said: string[] = [];
    const push = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    await judgePendingUpdate(
      r.dataDir,
      { info: push, debug: push, warn: push, error: push } as unknown as Log,
      "2.0.0",
    );
    assertStringIncludes(
      said.join("\n"),
      "during the handover 1.0.0 → 2.0.0: update handover FAILED " +
        "(PermissionDenied: spawn refused)",
    );
    // Said once: the marker no longer carries it.
    assertEquals(readPending(r.dataDir)?.handoverError, undefined);
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: the signing key is pinned on first use, then enforced", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "2.0.0", channel: "prod" });
    assertEquals(readTrust(r.dataDir).key, undefined);
    assertEquals(
      (await runtimeFor(r, {}).check({ dismissed: null })).kind,
      "offer",
    );
    // TOFU: the first verified release pins its key…
    assertEquals(readTrust(r.dataDir).key?.x, r.keys.publicKey.x);

    // …and a release signed by anyone else is refused from then on.
    const attacker = await generateSigningKey();
    r.keys = attacker;
    await publish(r, { version: "3.0.0", channel: "prod" });
    const got = await runtimeFor(r, {}).check({ dismissed: null });
    assertEquals(got.kind, "error");
    if (got.kind === "error") assertStringIncludes(got.error, "untrusted key");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a corrupted artifact is refused and never installed", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "2.0.0", channel: "prod", corrupt: true });
    const rt = runtimeFor(r, {});
    assertEquals((await rt.check({ dismissed: null })).kind, "offer"); // the manifest is fine

    let failed = "";
    await rt.apply().catch((e) => (failed = String(e)));
    assertStringIncludes(failed, "does not match the manifest");

    // The running artifact is untouched, and no half-downloaded file survives.
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );
    assertEquals(readPending(r.dataDir), null);
    const strays = [...Deno.readDirSync(r.root)].filter((e) =>
      e.name.startsWith("app.new-")
    );
    assertEquals(strays, []);
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// The size check catches an artifact of the WRONG LENGTH before a byte is
// hashed, which is why the test above passes with the digest comparison
// disabled — it proves the size guard, not the digest one. An attacker who can
// replace the artifact matches the size (it is inside the signature), so this
// is the shape where the digest is the only thing standing between a signed
// manifest and somebody else's bytes. Pinned in the mutation ledger.
Deno.test("updates e2e: a SAME-SIZE tampered artifact is refused by its digest", async () => {
  const r = await rig();
  try {
    await publish(r, {
      version: "2.0.0",
      channel: "prod",
      corruptSameSize: true,
    });
    const logged: string[] = [];
    const rt = runtimeFor(r, { errors: logged });
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");

    let failed = "";
    // …and the refusal is LOGGED. It used to reach only the cell's `error`,
    // which the next poll clears: on a real machine a tampered download left
    // no trace anywhere.
    await rt.apply().catch((e) => (failed = String(e)));
    assertStringIncludes(failed, "does not match the manifest");
    const line = logged.find((l) => l.includes("was NOT installed")) ?? "";
    assert(
      line.startsWith("updates "),
      `logged under the updates module: ${line}`,
    );
    assertStringIncludes(line, "2.0.0");
    assertStringIncludes(line, "does not match the manifest");
    assertStringIncludes(line, "keeps running");
    // Nothing was installed, and nothing was left behind.
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );
    assertEquals(readPending(r.dataDir), null);
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a test build on the prod path is refused by its signature", async () => {
  const r = await rig();
  try {
    // Exactly the realistic accident: a genuine, correctly-signed test build
    // published to the prod directory.
    const dir = join(r.releases, "prod");
    await Deno.mkdir(dir, { recursive: true });
    const m = await publish(r, { version: "2.0.0", channel: "test" });
    await Deno.writeTextFile(
      join(dir, `${platform.os}-${platform.arch}.json`),
      JSON.stringify(m),
    );
    await Deno.writeFile(
      join(dir, "app-2.0.0"),
      await programBytes(appBody("2.0.0")),
    );

    const got = await runtimeFor(r, { channel: "prod" }).check({
      dismissed: null,
    });
    assertEquals(got.kind, "error");
    if (got.kind === "error") {
      assertStringIncludes(got.error, "channel mismatch");
    }
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a release that cannot migrate the data is BLOCKED, not offered", async () => {
  const r = await rig();
  try {
    // v2 bumps the cell schema and ships no migration for v1 data.
    await publish(r, {
      version: "2.0.0",
      channel: "prod",
      data: { schema: 1, cells: { todos: { version: 2, migratesFrom: 2 } } },
    });
    const rt = runtimeFor(r, { cells: { todos: 1 } });
    const got = await rt.check({ dismissed: null });
    assertEquals(got.kind, "blocked");
    if (got.kind === "blocked") {
      assertEquals(got.blocked.version, "2.0.0");
      assertStringIncludes(got.blocked.blockers[0]!, "cannot migrate");
    }

    // And there is no path from blocked to installed.
    let failed = "";
    await rt.apply().catch((e) => (failed = String(e)));
    assertStringIncludes(failed, "no verified update");
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a migrating release backs the store up before swapping", async () => {
  const r = await rig();
  try {
    await publish(r, {
      version: "2.0.0",
      channel: "prod",
      data: { schema: 1, cells: { todos: { version: 2, migratesFrom: 1 } } },
    });
    const snapshots: string[] = [];
    const rt = runtimeFor(r, { cells: { todos: 1 }, snapshots });
    const got = await rt.check({ dismissed: null });
    assertEquals(got.kind, "offer");
    if (got.kind === "offer") assertEquals(got.update.migrates, true);

    await rt.apply();
    await settle(rt);

    // The backup exists, and the pending marker points at it — putting the old
    // binary back cannot un-migrate a store, so the rollback needs this.
    assertEquals(snapshots.length, 1);
    assertStringIncludes(snapshots[0]!, "pre-1.0.0-state.db");
    assertEquals(readPending(r.dataDir)?.backup, snapshots[0]);
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: an unsigned release is refused unless allowed", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "2.0.0", channel: "prod", sign: false });
    const got = await runtimeFor(r, {}).check({ dismissed: null });
    assertEquals(got.kind, "error");
    if (got.kind === "error") assertStringIncludes(got.error, "unsigned");

    const permissive = createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${r.releases}`,
        channel: "prod",
        allowUnsigned: true,
      }),
      dataDir: r.dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: { todos: 1 } },
      exposed: false,
      log: silentLog,
      argv: [],
      artifact: r.artifact,
      canInstall: ["binary"],
      exit: () => {},
    });
    assertEquals((await permissive.check({ dismissed: null })).kind, "offer");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: channels are independent directories", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "2.0.0", channel: "test" });
    await publish(r, { version: "1.0.0", channel: "prod" });

    assertEquals(
      (await runtimeFor(r, { channel: "prod" }).check({ dismissed: null }))
        .kind,
      "current",
    );
    const onTest = await runtimeFor(r, { channel: "test" }).check({
      dismissed: null,
    });
    assertEquals(onTest.kind, "offer");

    // Switching channel re-points the same install, and forgets what the old
    // channel had cached.
    const rt = runtimeFor(r, { channel: "prod" });
    assertEquals((await rt.check({ dismissed: null })).kind, "current");
    await rt.setChannel("test");
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: minFrom forces a stepping stone, and never installs", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "3.0.0", channel: "prod", minFrom: "2.0.0" });
    const got = await runtimeFor(r, { appVersion: "1.0.0" }).check({
      dismissed: null,
    });
    assertEquals(got.kind, "blocked");
    if (got.kind === "blocked") {
      assertStringIncludes(got.blocked.blockers[0]!, "2.0.0");
    }
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a missing channel reports the reason, not silence", async () => {
  const r = await rig();
  try {
    // Silence here is the worst outcome: "no update available" and "your
    // release URL is wrong" must never look the same.
    const got = await runtimeFor(r, { channel: "nope" }).check({
      dismissed: null,
    });
    assertEquals(got.kind, "error");
    if (got.kind === "error") {
      // Must name the missing release AND the channel path — `length > 0` is
      // true of every non-empty string and proves nothing about the reason
      // (same vacuous shape updates-apply pinned against).
      assert(
        got.error.includes("no release manifest") &&
          got.error.includes("/nope/"),
        `names the missing channel: ${got.error}`,
      );
    }
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// ── directory releases (electron-zip) ───────────────────────────────────────

/** A real .zip holding an unpacked Electron release, built with the same
 *  layout `aio build` writes: a launcher plus a bundled electron/. */
async function publishZip(r: Rig, opts: { version: string; channel: string }) {
  const stage = join(r.root, `stage-${opts.version}`);
  await Deno.mkdir(join(stage, "electron"), { recursive: true });
  // The launcher `aio build` writes for this OS — the swap smoke-tests it.
  if (Deno.build.os === "windows") {
    await Deno.writeTextFile(
      join(stage, "run.bat"),
      `@echo ${opts.version}\r\n`,
    );
  } else {
    await Deno.writeTextFile(
      join(stage, "run.sh"),
      `#!/bin/sh\necho ${opts.version}\n`,
    );
    await Deno.chmod(join(stage, "run.sh"), 0o755);
  }
  await Deno.writeTextFile(join(stage, "electron", "electron"), "");
  await Deno.writeTextFile(join(stage, "VERSION"), opts.version);

  const dir = join(r.releases, opts.channel);
  await Deno.mkdir(dir, { recursive: true });
  const zipName = `app-${opts.version}.zip`;
  const zipPath = join(dir, zipName);
  await zipTree(stage, zipPath);

  const bytes = await Deno.readFile(zipPath);
  const manifest = await buildShipManifest({
    name: "app",
    version: opts.version,
    binary: bytes,
    sources: [],
    sign: r.keys,
    channel: opts.channel,
    target: "electron-zip",
    platform,
    url: zipName,
    data: { schema: 1, cells: { todos: { version: 1, migratesFrom: 1 } } },
  });
  await Deno.writeTextFile(
    join(dir, `${platform.os}-${platform.arch}.json`),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

Deno.test("updates e2e: a .zip release is verified, unpacked, and handed to the swapper", async () => {
  const r = await rig();
  try {
    const manifest = await publishZip(r, { version: "2.0.0", channel: "prod" });
    const install = join(r.root, "MyApp");
    await Deno.mkdir(join(install, "electron"), { recursive: true });
    await Deno.writeTextFile(join(install, "VERSION"), "1.0.0");
    // What an earlier update recorded about the build that is running.
    writeTrust(r.dataDir, {
      installedSha256: "ab".repeat(32),
      installedReleasedAt: "2026-01-01T00:00:00.000Z",
    });

    const swaps: {
      current: string;
      staged: string;
      pending?: PendingMark;
    }[] = [];
    const exits: number[] = [];
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${r.releases}`,
        channel: "prod",
      }),
      dataDir: r.dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: { todos: 1 } },
      exposed: false,
      log: silentLog,
      argv: [],
      artifact: install, // a DIRECTORY target
      canInstall: ["electron-zip"],
      exit: (code) => void exits.push(code),
      swapDirectory: ({ current, staged, pending }) => {
        swaps.push({ current, staged, pending });
        return { previous: `${current}.old-1.0.0` };
      },
      shutdown: () => Promise.resolve(),
    });

    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    await rt.apply();
    await settle(rt);

    // Unpacked beside the install, contents intact, archive cleaned up.
    assertEquals(swaps.length, 1);
    assertEquals(swaps[0]!.current, install);
    assertEquals(
      await Deno.readTextFile(join(swaps[0]!.staged, "VERSION")),
      "2.0.0",
    );
    assertEquals(
      await Deno.stat(`${install}.zip-2.0.0`).catch(() => null),
      null,
    );

    // The rollback marker is handed to the swapper, which writes it BEFORE it
    // moves anything — or a build that cannot come up would have nothing
    // telling it to go back. ONE writer for it, not two.
    assertEquals(swaps[0]!.pending?.to, "2.0.0");
    assertEquals(swaps[0]!.pending?.from, "1.0.0");
    assertEquals(swaps[0]!.pending?.dataDir, r.dataDir);
    assertEquals(exits, [0]);
    // The swap happens after this process: nothing claims 2.0.0 is installed
    // yet (a failed swap left the old version running under the new
    // release's date), and the old digest is gone too. Both ride on the
    // marker, for the confirm to record.
    assertEquals(readTrust(r.dataDir).installedSha256, undefined);
    assertEquals(readTrust(r.dataDir).installedReleasedAt, undefined);
    assertEquals(swaps[0]!.pending?.sha256, manifest.sha256);
    assertEquals(swaps[0]!.pending?.releasedAt, manifest.releasedAt);
    // The install itself is untouched by this process — the shell does that.
    assertEquals(await Deno.readTextFile(join(install, "VERSION")), "1.0.0");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// A policy (AppLocker) that refuses the swap helper used to leave the log
// saying "the new version is installed" with the marker in place, and the app
// gone. Nothing was swapped: it is said, undone, and this version restarts.
// The refusal runs AFTER shutdown, when the logger is gone (VM-measured: the
// line reached no file) — so it is kept in the failed record, and the
// relaunched version names it at boot and counts a failed attempt — it is
// the machine that refused, not the release.
Deno.test("updates e2e: a swap helper that cannot start — not installed, undone, this version restarts", async () => {
  const r = await rig();
  try {
    await publishZip(r, { version: "2.0.0", channel: "prod" });
    const install = join(r.root, "MyApp");
    await Deno.mkdir(join(install, "electron"), { recursive: true });
    await Deno.writeTextFile(join(install, "VERSION"), "1.0.0");
    writeTrust(r.dataDir, { installedSha256: "ab".repeat(32) });
    const errors: string[] = [];
    const relaunched: string[] = [];
    let staged = "";
    let loggerOpen = true;
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${r.releases}`,
        channel: "prod",
      }),
      dataDir: r.dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: { todos: 1 } },
      exposed: false,
      log: {
        ...silentLog,
        error: (...a: unknown[]) =>
          void (loggerOpen && errors.push(a.join(" "))),
      } as Log,
      argv: ["--x"],
      artifact: install,
      canInstall: ["electron-zip"],
      exit: () => {},
      relaunch: ({ artifact }) => void relaunched.push(artifact),
      swapDirectory: (o) => {
        staged = o.staged;
        // What the real one does before it spawns — then the spawn fails.
        writePending(o.pending!.dataDir, {
          from: "1.0.0",
          to: "2.0.0",
          previous: "",
          attempts: 0,
          startedAt: "",
        });
        Deno.writeTextFileSync(firstBootPath(r.dataDir), "{}");
        throw new Deno.errors.PermissionDenied("blocked by policy");
      },
      shutdown: () => Promise.resolve(void (loggerOpen = false)),
    });
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    await rt.apply();
    await settle(rt);
    assertEquals(errors, [], "logged after shutdown: that line is lost");
    const rec = JSON.parse(Deno.readTextFileSync(failedUpdatePath(r.dataDir)));
    assertEquals([rec.from, rec.to], ["1.0.0", "2.0.0"]);
    assertStringIncludes(rec.swapFailed, "blocked by policy");
    // The relaunched 1.0.0 says it, and does not offer 2.0.0 again.
    const said: string[] = [];
    const push = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    startUpdates({
      updates: { source: "https://example.invalid/rel", check: 60_000 },
      dataDir: r.dataDir,
      appName: "demo",
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      log: {
        info: push,
        debug: push,
        warn: push,
        error: push,
      } as unknown as Log,
      argv: [],
      slot: { runtime: null, cell: null } as unknown as UpdatesSlot,
    }).stop();
    // Nothing was swapped — an attempt that failed, counted like a move the
    // helper could not make, not a release that failed: still on offer.
    assertStringIncludes(
      said.join("\n"),
      "update 1.0.0 → 2.0.0 could not be installed: the swap could not be " +
        "started (PermissionDenied: blocked by policy), so 1.0.0 was " +
        "started again — 2.0.0 stays on offer (failed attempt 1 of 3)",
    );
    assert(!said.join("\n").includes("Dismissed"), said.join("\n"));
    assertEquals(readPending(r.dataDir), null);
    assertEquals(
      await Deno.stat(firstBootPath(r.dataDir)).catch(() => null),
      null,
    );
    assertEquals(await Deno.stat(staged).catch(() => null), null);
    assertEquals(readTrust(r.dataDir).installedSha256, undefined);
    assertEquals(relaunched, [Deno.execPath()]);
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a corrupted .zip is refused before anything is unpacked", async () => {
  const r = await rig();
  try {
    const m = await publishZip(r, { version: "2.0.0", channel: "prod" });
    // Replace the archive AFTER the manifest hashed it.
    await Deno.writeTextFile(
      join(r.releases, "prod", m.url!),
      "not the archive that was signed",
    );
    const install = join(r.root, "MyApp");
    await Deno.mkdir(join(install, "electron"), { recursive: true });

    let swapped = false;
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${r.releases}`,
        channel: "prod",
      }),
      dataDir: r.dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: { todos: 1 } },
      exposed: false,
      log: silentLog,
      argv: [],
      artifact: install,
      canInstall: ["electron-zip"],
      exit: () => {},
      swapDirectory: () => {
        swapped = true;
        return { previous: "" };
      },
      shutdown: () => Promise.resolve(),
    });

    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    let failed = "";
    await rt.apply().catch((e) => (failed = String(e)));
    assertStringIncludes(failed, "does not match the manifest");
    assertEquals(swapped, false);
    assertEquals(readPending(r.dataDir), null);
    // Nothing unpacked, nothing left half-downloaded.
    assertEquals(
      await Deno.stat(`${install}.staged-2.0.0`).catch(() => null),
      null,
    );
    assertEquals(
      await Deno.stat(`${install}.zip-2.0.0`).catch(() => null),
      null,
    );
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// ── signed macOS bundles (electron-app) ─────────────────────────────────────

/** A real `.app.tar.gz`, laid out as the Mac build host packs it: the bundle
 *  folder at the archive root, an Info.plist naming the executable. */
async function publishAppTarball(r: Rig, opts: { version: string }) {
  const stage = join(r.root, `app-stage-${opts.version}`);
  const contents = join(stage, "Counter.app", "Contents");
  await Deno.mkdir(join(contents, "MacOS"), { recursive: true });
  await Deno.writeTextFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0"?><plist><dict>` +
      `<key>CFBundleExecutable</key><string>Counter</string>` +
      `</dict></plist>`,
  );
  const exe = join(contents, "MacOS", "Counter");
  await Deno.writeTextFile(exe, appBody(opts.version));
  await Deno.chmod(exe, 0o755);
  await Deno.writeTextFile(join(contents, "VERSION"), opts.version);

  const dir = join(r.releases, "prod");
  await Deno.mkdir(dir, { recursive: true });
  const name = `counter-${opts.version}-mac-x64.app.tar.gz`;
  const packed = await new Deno.Command("tar", {
    args: ["-czf", join(dir, name), "-C", stage, "Counter.app"],
    stderr: "piped",
  }).output();
  assert(packed.success, "tar failed");
  const manifest = await buildReleaseManifest({
    name: "counter",
    version: opts.version,
    binary: await Deno.readFile(join(dir, name)),
    sources: [],
    sign: r.keys,
    channel: "prod",
    target: "electron-app",
    platform,
    url: name,
    data: { schema: 1, cells: { todos: { version: 1, migratesFrom: 1 } } },
  });
  await Deno.writeTextFile(
    join(dir, `${platform.os}-${platform.arch}.json`),
    JSON.stringify(manifest, null, 2),
  );
}

type DirSwap = Parameters<
  NonNullable<Parameters<typeof createUpdatesRuntime>[0]["swapDirectory"]>
>[0];
type Sealed = { ok: true } | { ok: false; error: string };

/** An installed v1 bundle at `where`, and a runtime that runs from it. */
async function macRig(
  r: Rig,
  seal: Sealed,
  where = join("Applications", "Counter.app"),
) {
  const app = join(r.root, where);
  await Deno.mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await Deno.writeTextFile(join(app, "Contents", "VERSION"), "1.0.0");
  const swaps: DirSwap[] = [];
  const sealed: string[] = [];
  const rt = createUpdatesRuntime({
    config: resolveUpdates({ source: `file://${r.releases}`, channel: "prod" }),
    dataDir: r.dataDir,
    appVersion: "1.0.0",
    local: { schema: 1, cells: { todos: 1 } },
    exposed: false,
    log: silentLog,
    argv: ["--client=electron"],
    artifact: app, // what installDir() walks up to on darwin
    installedTarget: "macos-app",
    canInstall: ["electron-app"],
    exit: () => {},
    verifyBundle: (staged) => {
      sealed.push(staged);
      return Promise.resolve(seal);
    },
    swapDirectory: (o) => {
      swaps.push(o);
      return { previous: `${o.current}.old-1.0.0` };
    },
    shutdown: () => Promise.resolve(),
  });
  return { app, rt, swaps, sealed };
}

Deno.test(
  "updates e2e: a .app release is unpacked AS the bundle, seal-checked, and relaunched via open -n",
  {
    // A macOS bundle: its executable (Contents/MacOS/Counter) has no extension,
    // which Windows cannot run — and no Windows release is a .app.
    ignore: Deno.build.os === "windows", // a macOS .app bundle: its executable has no extension, and no Windows release is one
  },
  async () => {
    const r = await rig();
    try {
      await publishAppTarball(r, { version: "2.0.0" });
      const { app, rt, swaps, sealed } = await macRig(r, { ok: true });
      assertEquals((await rt.check({ dismissed: null })).kind, "offer");
      await rt.apply();
      await settle(rt);

      const staged = `${app}.staged-2.0.0`;
      // The seal is checked on the staged bundle — before the swap, never after.
      assertEquals(sealed, [staged]);
      assertEquals(swaps.length, 1);
      const s = swaps[0]!;
      assertEquals([s.current, s.staged], [app, staged]);
      // The staged dir IS the bundle (the archive's `Counter.app/` stripped).
      assertEquals(
        await Deno.readTextFile(join(staged, "Contents", "VERSION")),
        "2.0.0",
      );
      // Back through LaunchServices, a NEW instance, the app's own argv kept.
      assertEquals(s.launcher, "/usr/bin/open");
      assertEquals(s.args, ["-n", app, "--args", "--client=electron"]);
      assertEquals(s.pending?.to, "2.0.0");
      assertEquals(
        await Deno.stat(`${app}.zip-2.0.0`).catch(() => null),
        null,
        "the downloaded tarball is cleaned up",
      );
    } finally {
      await Deno.remove(r.root, { recursive: true });
    }
  },
);

Deno.test("updates e2e: a .app whose code signature does not verify is refused and v1 stays", async () => {
  const r = await rig();
  try {
    await publishAppTarball(r, { version: "2.0.0" });
    const { app, rt, swaps } = await macRig(r, {
      ok: false,
      error: "the downloaded app's code signature does not verify",
    });
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    let failed = "";
    await rt.apply().catch((e) => (failed = String(e)));
    assertStringIncludes(failed, "code signature does not verify");
    assertEquals(swaps.length, 0);
    assertEquals(readPending(r.dataDir), null);
    assertEquals(
      await Deno.stat(`${app}.staged-2.0.0`).catch(() => null),
      null,
      "the refused bundle is removed",
    );
    assertEquals(
      await Deno.readTextFile(join(app, "Contents", "VERSION")),
      "1.0.0",
    );
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test(
  "updates e2e: a translocated .app refuses before downloading, naming /Applications",
  {
    // A macOS bundle: its executable (Contents/MacOS/Counter) has no extension,
    // which Windows cannot run — and no Windows release is a .app.
    ignore: Deno.build.os === "windows", // a macOS .app bundle: its executable has no extension, and no Windows release is one
  },
  async () => {
    const r = await rig();
    try {
      await publishAppTarball(r, { version: "2.0.0" });
      const { app, rt, swaps, sealed } = await macRig(
        r,
        { ok: true },
        join("AppTranslocation", "X", "d", "Counter.app"),
      );
      assertEquals((await rt.check({ dismissed: null })).kind, "offer");
      let failed = "";
      await rt.apply().catch((e) => (failed = String(e)));
      assertStringIncludes(failed, "App Translocation");
      assertStringIncludes(failed, "Move Counter.app to /Applications");
      assertEquals([swaps.length, sealed.length], [0, 0]);
      assertEquals(
        await Deno.stat(`${app}.zip-2.0.0`).catch(() => null),
        null,
        "refused BEFORE a byte was downloaded",
      );
    } finally {
      await Deno.remove(r.root, { recursive: true });
    }
  },
);

// ── repository releases (git) ───────────────────────────────────────────────

async function gitCmd(args: string[], cwd: string): Promise<void> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(
    out.success,
    `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
  );
}

/** A repo whose `compile` task emits an executable answering the contract
 *  probe — the same shape a real aio app's build produces. */
async function gitRepo(root: string, contract: string): Promise<string> {
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({
      name: "demo",
      version: "2.0.0",
      tasks: { compile: "deno run -A make.ts" },
    }),
  );
  // The artifact's bytes travel in the build script: a real program on every
  // OS (tests/fake-program-helper.ts), named as that OS names one.
  const bytes = await programBytes(`#!/bin/sh
if [ "$1" = "--aio-data-contract" ]; then echo '${contract}'; exit 0; fi
echo APP 2.0.0
`);
  const program = btoa(
    Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
  );
  await Deno.writeTextFile(
    join(root, "make.ts"),
    `
const out = "dist/app${EXE}";
await Deno.mkdir("dist", { recursive: true });
await Deno.writeFile(out, Uint8Array.from(atob("${program}"), (c) => c.charCodeAt(0)));
if (Deno.build.os !== "windows") await Deno.chmod(out, 0o755);
`,
  );
  await gitCmd(["init", "-q", "-b", "main"], root);
  await gitCmd(["config", "user.email", "t@example.com"], root);
  await gitCmd(["config", "user.name", "t"], root);
  await gitCmd(["add", "."], root);
  await gitCmd(["commit", "-q", "-m", "release"], root);
  const head = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: root,
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(head.stdout).trim();
}

function gitRuntime(r: Rig, repoPath: string, opts: {
  cells?: Record<string, number>;
  exits?: number[];
  relaunched?: string[];
}) {
  return createUpdatesRuntime({
    config: resolveUpdates({ source: repoPath, kind: "git", channel: "main" }),
    dataDir: r.dataDir,
    appVersion: "1.0.0",
    local: { schema: 1, cells: opts.cells ?? { todos: 1 } },
    exposed: false,
    log: silentLog,
    argv: [],
    artifact: r.artifact,
    canInstall: ["binary"],
    exit: (code) => void opts.exits?.push(code),
    relaunch: ({ artifact }) => void opts.relaunched?.push(artifact),
    shutdown: () => Promise.resolve(),
  });
}

Deno.test("updates e2e: a moved git ref is rebuilt, gated, and installed", async () => {
  const r = await rig();
  try {
    const repoPath = join(r.root, "repo");
    const sha = await gitRepo(
      repoPath,
      '{"schema":1,"cells":{"todos":{"version":1,"migratesFrom":1}}}',
    );
    // This install was built from some older commit.
    writeTrust(r.dataDir, { commit: "0".repeat(40) });

    const exits: number[] = [];
    const relaunched: string[] = [];
    const rt = gitRuntime(r, repoPath, { exits, relaunched });

    const found = await rt.check({ dismissed: null });
    assertEquals(found.kind, "offer");
    if (found.kind === "offer") {
      assertEquals(found.update.version, sha.slice(0, 8));
      // A commit cannot say what it does to data until it is built, and that
      // is said rather than implied.
      assertStringIncludes(found.update.warnings[0]!, "after the build");
    }

    await rt.apply();
    await settle(rt);

    // The artifact this process runs from now holds the rebuilt binary…
    // The git artifact is built by the repo's own `make.ts`, not by `publish`.
    assertStringIncludes(await Deno.readTextFile(r.artifact), "echo APP 2.0.0");
    assertEquals(
      await Deno.readFile(`${r.artifact}.old-1.0.0`),
      await programBytes(appBody("1.0.0")),
    );
    assertEquals(exits, [0]);
    assertEquals(relaunched, [r.artifact]);
    // …the rollback marker is in place…
    assertEquals(readPending(r.dataDir)?.to, sha.slice(0, 8));
    // …and the commit is recorded, so the next check compares against what was
    // actually built rather than what was last downloaded.
    assertEquals(readTrust(r.dataDir).commit, sha);

    // Nothing new now.
    assertEquals(
      (await gitRuntime(r, repoPath, {}).check({ dismissed: null })).kind,
      "current",
    );
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a rebuilt commit that cannot migrate is thrown away", async () => {
  const r = await rig();
  try {
    const repoPath = join(r.root, "repo");
    // The new commit bumps the schema and ships no migration for v1 data.
    await gitRepo(
      repoPath,
      '{"schema":1,"cells":{"todos":{"version":2,"migratesFrom":2}}}',
    );
    writeTrust(r.dataDir, { commit: "0".repeat(40) });

    const rt = gitRuntime(r, repoPath, { cells: { todos: 1 } });
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");

    // The gate runs AFTER the build — the only moment the answer exists — but
    // still before anything is installed, which is what matters.
    let failed = "";
    await rt.apply().catch((e) => (failed = String(e)));
    assertStringIncludes(failed, "cannot migrate");
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );
    assertEquals(readPending(r.dataDir), null);
    // The commit is NOT recorded — this install did not take it.
    assertEquals(readTrust(r.dataDir).commit, "0".repeat(40));
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// ── what the cell tells the runtime ─────────────────────────────────────────

Deno.test("updates e2e: a dismissed version stays dismissed past the next poll; a newer one is offered", async () => {
  // A field report from a desktop app: "Not now" lasted exactly one poll. The
  // cell persisted the dismissal and `decide` honoured it, but the runtime
  // never handed one to the other — so a minute later the banner was back.
  const r = await rig();
  try {
    await publish(r, { version: "2.0.0", channel: "prod" });
    const rt = runtimeFor(r, {});
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");

    const again = await rt.check({ dismissed: "2.0.0" });
    assertEquals(again.kind, "current");
    if (again.kind === "current") {
      assertStringIncludes(again.reason, "2.0.0 was dismissed");
    }

    // A release NEWER than the dismissed one is not covered by the No.
    await publish(r, { version: "2.1.0", channel: "prod" });
    const newer = await runtimeFor(r, {}).check({ dismissed: "2.0.0" });
    assertEquals(newer.kind, "offer");
    if (newer.kind === "offer") assertEquals(newer.update.version, "2.1.0");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a dismissed commit stays dismissed on a git source", async () => {
  const r = await rig();
  try {
    const repoPath = join(r.root, "repo");
    const sha = await gitRepo(
      repoPath,
      '{"schema":1,"cells":{"todos":{"version":1,"migratesFrom":1}}}',
    );
    writeTrust(r.dataDir, { commit: "0".repeat(40) });
    const rt = gitRuntime(r, repoPath, {});
    const offer = await rt.check({ dismissed: null });
    assertEquals(offer.kind, "offer");
    if (offer.kind !== "offer") return;
    // `dismiss()` writes back exactly `available.version` — for a git source
    // the label "<version> (<short sha>)" — and `decideGit` used to compare
    // against the full sha only, so a git-source dismissal could never match.
    for (const dismissed of [sha, offer.update.version]) {
      const again = await rt.check({ dismissed });
      assertEquals(again.kind, "current", `dismissed as ${dismissed}`);
      if (again.kind === "current") {
        assertStringIncludes(again.reason, "was dismissed");
      }
    }
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a prerelease is refused by default, naming the key; followed with prerelease: true", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "2.0.0-rc.1", channel: "prod" });
    const refused = await runtimeFor(r, {}).check({ dismissed: null });
    assertEquals(refused.kind, "current");
    if (refused.kind === "current") {
      // The reason names the EXACT config key — before this the message asked
      // for an option that did not exist on `UpdatesConfig`.
      assertStringIncludes(
        refused.reason,
        "2.0.0-rc.1 is a prerelease — set updates: { prerelease: true }",
      );
    }
    const followed = await runtimeFor(r, { prerelease: true })
      .check({ dismissed: null });
    assertEquals(followed.kind, "offer");
    if (followed.kind === "offer") {
      assertEquals(followed.update.version, "2.0.0-rc.1");
    }
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// ── the headline: a re-published build of the SAME version ──────────────────

Deno.test("updates e2e: republishing 1.0.0 with new bytes IS an update", async () => {
  const r = await rig();
  try {
    // The install is running exactly what prod is serving.
    await publish(r, { version: "1.0.0", channel: "prod" });
    const manifestPath = join(
      r.releases,
      "prod",
      `${platform.os}-${platform.arch}.json`,
    );
    const firstManifest = await Deno.readTextFile(manifestPath);
    await new Promise((res) => setTimeout(res, 5)); // a later releasedAt
    const first = runtimeFor(r, {});
    assertEquals((await first.check({ dismissed: null })).kind, "current");
    // …and it measured its own artifact once, so it now knows what it runs.
    const digest = readTrust(r.dataDir).installedSha256;
    assert(digest && digest.length === 64, "the install recorded its digest");

    // The publisher rebuilds 1.0.0 — a fix, a different toolchain, whatever.
    // Same version string, different bytes. This used to be undetectable: the
    // versions compare equal, so the answer was "you are the latest", forever.
    await publish(r, {
      version: "1.0.0",
      channel: "prod",
      body: "#!/bin/sh\nexit 0\n",
    });
    const again = runtimeFor(r, {});
    const found = await again.check({ dismissed: null });
    assertEquals(found.kind, "offer");
    if (found.kind === "offer") {
      assertEquals(found.update.version, "1.0.0");
      assertStringIncludes(found.update.reason, "same version, new build");
      assertEquals(found.update.signed, true);
      assert(found.update.keyFingerprint, "the signing key is named");
    }

    const exits: number[] = [];
    const rt = runtimeFor(r, { exits });
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    await rt.apply();
    await settle(rt);
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes("#!/bin/sh\nexit 0\n"),
    );
    assertEquals(exits, [0]);
    // The digest recorded is the one that was VERIFIED, so the NEXT rebuild is
    // detectable too — the loop closes.
    const after = readTrust(r.dataDir).installedSha256;
    assert(after && after !== digest, "the new build's digest is recorded");
    assertEquals(
      (await runtimeFor(r, {}).check({ dismissed: null })).kind,
      "current",
    );
    // A CDN edge still caching the FIRST build's manifest (or a replay of it:
    // its signature is genuine) is an older build — never offered back.
    await Deno.writeTextFile(manifestPath, firstManifest);
    const stale = await runtimeFor(r, {}).check({ dismissed: null });
    assertEquals(stale.kind, "current");
    if (stale.kind === "current") {
      assertStringIncludes(stale.reason, "older build");
    }
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: an install that cannot measure itself stays quiet", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "1.0.0", channel: "prod", body: "OTHER" });
    // The artifact this process claims to run from is not there at all.
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${r.releases}`,
        channel: "prod",
      }),
      dataDir: r.dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: { todos: 1 } },
      exposed: false,
      log: silentLog,
      argv: [],
      artifact: join(r.root, "does-not-exist"),
      canInstall: ["binary"],
      exit: () => {},
      shutdown: () => Promise.resolve(),
    });
    // Never offer on ignorance: an unknown installed digest is not evidence
    // that the bytes differ.
    const got = await rt.check({ dismissed: null });
    assertEquals(got.kind, "current");
    if (got.kind === "current") {
      // …and it says the class of update it cannot see, rather than implying
      // it looked and found nothing.
      assertStringIncludes(got.reason, "no recorded artifact digest");
    }
    assertEquals(readTrust(r.dataDir).installedSha256, undefined);
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// ── the veto ────────────────────────────────────────────────────────────────

Deno.test("updates e2e: canApply can refuse the moment, and nothing is installed", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "2.0.0", channel: "prod" });
    let busy = true;
    const exits: number[] = [];
    const make = (auto: boolean) =>
      createUpdatesRuntime({
        config: resolveUpdates({
          source: `file://${r.releases}`,
          channel: "prod",
          auto,
          canApply: () => !busy,
        }),
        dataDir: r.dataDir,
        appVersion: "1.0.0",
        local: { schema: 1, cells: { todos: 1 } },
        exposed: false,
        log: silentLog,
        argv: [],
        artifact: r.artifact,
        canInstall: ["binary"],
        exit: (code) => void exits.push(code),
        relaunch: () => {},
        shutdown: () => Promise.resolve(),
      });

    // The manual path: a wallet mid-signature, an unsaved editor. The refusal
    // is loud and names the hook, and the artifact is untouched.
    const manual = make(false);
    assertEquals((await manual.check({ dismissed: null })).kind, "offer");
    let refused = "";
    await manual.apply().catch((e) => (refused = String(e)));
    assertStringIncludes(refused, "updates.canApply returned false");
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );
    assertEquals(exits, []);

    // The UNATTENDED path goes through the same guard — before this, `auto`
    // had no guard of any kind.
    const auto = make(true);
    assertEquals((await auto.check({ dismissed: null })).kind, "offer");
    refused = "";
    await auto.apply().catch((e) => (refused = String(e)));
    assertStringIncludes(refused, "canApply");
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );

    // A hook that throws is not permission either — fail closed.
    const angry = createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${r.releases}`,
        channel: "prod",
        canApply: () => {
          throw new Error("cell not ready");
        },
      }),
      dataDir: r.dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: { todos: 1 } },
      exposed: false,
      log: silentLog,
      argv: [],
      artifact: r.artifact,
      canInstall: ["binary"],
      exit: () => {},
      shutdown: () => Promise.resolve(),
    });
    await angry.check({ dismissed: null });
    refused = "";
    await angry.apply().catch((e) => (refused = String(e)));
    assertStringIncludes(refused, "cell not ready");
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );

    // …and when the app says yes, it installs.
    busy = false;
    const ok = make(false);
    assertEquals((await ok.check({ dismissed: null })).kind, "offer");
    await ok.apply();
    await settle(ok);
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("2.0.0")),
    );
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// ── the one-way door ────────────────────────────────────────────────────────

Deno.test("updates e2e: acceptDataLoss backs the store up FIRST, or refuses", async () => {
  const r = await rig();
  try {
    // A contract that blocks: the release writes v2 and can only read v2.
    await publish(r, {
      version: "2.0.0",
      channel: "prod",
      data: { schema: 1, cells: { todos: { version: 2, migratesFrom: 2 } } },
    });

    // With no way to take a backup, the door does not open. A mis-published
    // contract is worth overriding; overriding it with no way back is not.
    const noSnapshot = createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${r.releases}`,
        channel: "prod",
      }),
      dataDir: r.dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: { todos: 1 } },
      exposed: false,
      log: silentLog,
      argv: [],
      artifact: r.artifact,
      canInstall: ["binary"],
      exit: () => {},
      shutdown: () => Promise.resolve(),
    });
    assertEquals((await noSnapshot.check({ dismissed: null })).kind, "blocked");
    let refused = "";
    await noSnapshot.apply({ acceptDataLoss: true })
      .catch((e) => (refused = String(e)));
    assertStringIncludes(refused, "no state snapshot");
    assertStringIncludes(refused, "accept data loss");
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );

    // With one, the backup is taken BEFORE the download — refusing after
    // 156MB has crossed somebody's network is a refusal in the wrong place —
    // and the release installs.
    const snapshots: string[] = [];
    const exits: number[] = [];
    const rt = runtimeFor(r, { snapshots, exits });
    assertEquals((await rt.check({ dismissed: null })).kind, "blocked");
    // Still refused by default: nothing about the gate changed.
    await rt.apply().catch(() => {});
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("1.0.0")),
    );

    await rt.apply({ acceptDataLoss: true });
    await settle(rt);
    assertEquals(snapshots.length, 1);
    assertStringIncludes(snapshots[0]!, "pre-1.0.0-state.db");
    assertEquals(await Deno.readTextFile(snapshots[0]!), "SNAPSHOT");
    assertEquals(
      await Deno.readFile(r.artifact),
      await programBytes(appBody("2.0.0")),
    );
    assertEquals(exits, [0]);
    // The backup is named in the rollback marker, so the boot that undoes this
    // can tell the user where their data is.
    assertEquals(readPending(r.dataDir)?.backup, snapshots[0]);
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// ── the caches that lied ────────────────────────────────────────────────────

Deno.test("updates e2e: a dismissal never poisons the ETag into 'you are the latest'", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "2.0.0", channel: "prod" });
    const rt = runtimeFor(r, {});
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    // The user says "Not now". `decide` answers `current` — and caching THAT
    // answer's ETag turned every later check into a 304 reporting "you are the
    // latest", which is false and permanent.
    const dismissed = await rt.check({ dismissed: "2.0.0" });
    assertEquals(dismissed.kind, "current");
    assertEquals(readTrust(r.dataDir).etagCurrent, undefined);
    // …so undismissing actually brings the offer back.
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: setChannel clears the ETag that is actually READ", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "1.0.0", channel: "prod" });
    await publish(r, { version: "3.0.0", channel: "test" });
    const rt = runtimeFor(r, {});
    assertEquals((await rt.check({ dismissed: null })).kind, "current");
    // Poisoning the field the fetch actually sends: after a channel change it
    // must be gone, or the first check on the NEW channel can answer 304 —
    // "you are the latest" — against a manifest from the channel just left.
    writeTrust(r.dataDir, { etagCurrent: '"stale"', etag: '"legacy"' });
    await rt.setChannel("test");
    assertEquals(readTrust(r.dataDir).etagCurrent, undefined);
    assertEquals(readTrust(r.dataDir).etag, undefined);
    assertEquals(readTrust(r.dataDir).channel, "test");
    const got = await rt.check({ dismissed: null });
    assertEquals(got.kind, "offer");
    if (got.kind === "offer") assertEquals(got.update.version, "3.0.0");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// ── what an update makes beside the install is its own, on record ──────────
//
// An update's names (`<install>.new-<v>`, `.staged-<v>`, `.zip-<v>`,
// `.old-<v>`) are in a folder that is the user's. Each used to be cleared by
// name before it was made — a recursive delete of whatever was there.

const beside = (r: Rig) =>
  [...Deno.readDirSync(r.root)].map((e) => e.name).filter((n) =>
    !["data", "releases", "app", "MyApp"].includes(n) && !n.startsWith("stage-")
  ).sort();

Deno.test("updates e2e: a single-file update puts what it makes on record — the kept-aside copy as the very file", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "2.0.0", channel: "prod" });
    const rt = runtimeFor(r, {});
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    await rt.apply();
    await settle(rt);
    const old = `${r.artifact}.old-1.0.0`;
    assertEquals(beside(r), ["app.old-1.0.0"]);
    assertEquals(
      readOwned(r.dataDir).filter((e) => e.path === old)
        .map((e) => [e.kind, e.role, e.is]),
      [["file", "kept", identity(old)!]],
    );
    // The folder the download was written in was on record too, as made.
    assertEquals(
      readOwned(r.dataDir).filter((e) =>
        basename(e.path).startsWith(".aio-update-app.new-2.0.0-")
      ).map((e) => [e.kind, e.role, typeof e.is]),
      [["dir", "temp", "string"]],
    );
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

// "Not the updater's" is "not on its record" — whatever the thing looks
// like: a file of exactly the release's size where the download goes, an
// executable of the app's own format where the old version is kept.
for (
  const [what, name, body] of [
    [
      "where the download goes",
      "app.new-2.0.0",
      (size: number) => "n".repeat(size),
    ],
    [
      "where the old version is kept",
      "app.old-1.0.0",
      (_: number) => appBody("0.9.0"),
    ],
  ] as const
) {
  Deno.test(`updates e2e: a file of the user's ${what} refuses a single-file update — nothing is downloaded, nothing changes`, async () => {
    const r = await rig();
    try {
      const m = await publish(r, { version: "2.0.0", channel: "prod" });
      const mine = body(m.size);
      await Deno.writeTextFile(join(r.root, name), mine);
      const rt = runtimeFor(r, {});
      assertEquals((await rt.check({ dismissed: null })).kind, "offer");
      let failed = "";
      await rt.apply().catch((e) => (failed = String(e)));
      assertStringIncludes(
        failed,
        `${join(r.root, name)} is in the way of the update, and it was not ` +
          `made by this app's updater`,
      );
      assertEquals(beside(r), [name]);
      assertEquals(await Deno.readTextFile(join(r.root, name)), mine);
      assertEquals(
        await Deno.readFile(r.artifact),
        await programBytes(appBody("1.0.0")),
      );
      assertEquals(readPending(r.dataDir), null);
      // Nothing written down either: a refusal leaves no entry for a
      // download or a tree it never made.
      assertEquals(readOwned(r.dataDir), [], "something was put on record");
    } finally {
      await Deno.remove(r.root, { recursive: true });
    }
  });
}

/** A runtime for the unpacked install `MyApp`; `swaps` collects handovers. */
async function zipRuntime(r: Rig, swaps: string[]) {
  const install = join(r.root, "MyApp");
  await Deno.mkdir(join(install, "electron"), { recursive: true });
  await Deno.writeTextFile(join(install, "run.sh"), "#!/bin/sh\necho 1.0.0\n");
  return {
    install,
    rt: createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${r.releases}`,
        channel: "prod",
      }),
      dataDir: r.dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: { todos: 1 } },
      exposed: false,
      log: silentLog,
      argv: [],
      artifact: install,
      canInstall: ["electron-zip"],
      exit: () => {},
      swapDirectory: ({ current, staged }) => {
        swaps.push(staged);
        return { previous: `${current}.old-1.0.0` };
      },
      shutdown: () => Promise.resolve(),
    }),
  };
}

for (
  const name of ["MyApp.staged-2.0.0", "MyApp.zip-2.0.0", "MyApp.old-1.0.0"]
) {
  Deno.test(`updates e2e: a folder of the user's named ${name} refuses a .zip update before anything is downloaded — it is not removed`, async () => {
    const r = await rig();
    try {
      await publishZip(r, { version: "2.0.0", channel: "prod" });
      const swaps: string[] = [];
      const { rt } = await zipRuntime(r, swaps);
      // A copy of this very app, made by hand, with a file of their own.
      await Deno.mkdir(join(r.root, name, "electron"), { recursive: true });
      await Deno.writeTextFile(
        join(r.root, name, "run.sh"),
        "#!/bin/sh\necho 1.0.0\n",
      );
      await Deno.writeTextFile(join(r.root, name, "user.txt"), "mine");
      assertEquals((await rt.check({ dismissed: null })).kind, "offer");
      let failed = "";
      await rt.apply().catch((e) => (failed = String(e)));
      assertStringIncludes(failed, `${join(r.root, name)} is in the way`);
      assertEquals(beside(r), [name]);
      assertEquals(
        await Deno.readTextFile(join(r.root, name, "user.txt")),
        "mine",
      );
      assertEquals(swaps, []);
    } finally {
      await Deno.remove(r.root, { recursive: true });
    }
  });
}

Deno.test("updates e2e: a .zip update's staged tree is on record as the very folder it unpacked into, and its own leftover is replaced", async () => {
  const r = await rig();
  try {
    await publishZip(r, { version: "2.0.0", channel: "prod" });
    const swaps: string[] = [];
    const { install, rt } = await zipRuntime(r, swaps);
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    await rt.apply();
    await settle(rt);
    const staged = `${install}.staged-2.0.0`;
    assertEquals(swaps, [staged]);
    const mine = () =>
      readOwned(r.dataDir).filter((e) => e.path === staged)
        .map((e) => [e.kind, e.role, e.is]);
    assertEquals(mine(), [["dir", "temp", identity(staged)!]]);
    // The swap was never made (the stand-in helper moves nothing). The same
    // update again: its own leftover is not in the way.
    await Deno.writeTextFile(join(staged, "stale"), "from the first try");
    await rt.apply();
    await settle(rt);
    assertEquals(swaps, [staged, staged]);
    assertEquals(
      await Deno.stat(join(staged, "stale")).catch(() => null),
      null,
      "the first try's tree was unpacked INTO, not replaced",
    );
    assertEquals(mine(), [["dir", "temp", identity(staged)!]]);
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});
