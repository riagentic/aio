// updates-e2e.test.ts — the whole update path against a real `file://` source.
//
// A local source is a first-class one, not a test fixture: air-gapped installs
// and LAN deployments use exactly this. So this drives the shipped code end to
// end — publish v2, check, apply, assert the artifact was replaced — and then
// the refusals, which are the half that has to be right.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildShipManifest,
  generateSigningKey,
  type ShipManifest,
} from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { readPending } from "../src/server/updates-apply.ts";
import { readTrust, writeTrust } from "../src/server/updates-check.ts";
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
  await Deno.writeTextFile(artifact, appBody("1.0.0"));
  await Deno.chmod(artifact, 0o755);
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
  const bytes = new TextEncoder().encode(opts.body ?? appBody(opts.version));
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
    log: silentLog,
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
    assertEquals(await Deno.readTextFile(r.artifact), appBody("2.0.0"));
    assertEquals(
      await Deno.readTextFile(`${r.artifact}.old-1.0.0`),
      appBody("1.0.0"),
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
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));
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
    const rt = runtimeFor(r, {});
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");

    let failed = "";
    await rt.apply().catch((e) => (failed = String(e)));
    assertStringIncludes(failed, "does not match the manifest");
    // Nothing was installed, and nothing was left behind.
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));
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
      new TextEncoder().encode(appBody("2.0.0")),
    );

    const got = await runtimeFor(r, { channel: "prod" }).check({
      dismissed: null,
    });
    assertEquals(got.kind, "error");
    if (got.kind === "error") {
      assertStringIncludes(got.error, "channel mismatch");
    }
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));
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
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));
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
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));
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
    if (got.kind === "error") assert(got.error.length > 0);
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
  await Deno.writeTextFile(
    join(stage, "run.sh"),
    `#!/bin/sh\necho ${opts.version}\n`,
  );
  await Deno.chmod(join(stage, "run.sh"), 0o755);
  await Deno.writeTextFile(join(stage, "electron", "electron"), "");
  await Deno.writeTextFile(join(stage, "VERSION"), opts.version);

  const dir = join(r.releases, opts.channel);
  await Deno.mkdir(dir, { recursive: true });
  const zipName = `app-${opts.version}.zip`;
  const zipPath = join(dir, zipName);
  const zipped = await new Deno.Command("zip", {
    args: ["-qr", zipPath, "."],
    cwd: stage,
    stderr: "piped",
  }).output();
  assert(zipped.success, "zip failed");

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
  if (Deno.build.os === "windows") return; // the cmd.exe branch is unit-tested
  const r = await rig();
  try {
    await publishZip(r, { version: "2.0.0", channel: "prod" });
    const install = join(r.root, "MyApp");
    await Deno.mkdir(join(install, "electron"), { recursive: true });
    await Deno.writeTextFile(join(install, "VERSION"), "1.0.0");

    const swaps: {
      current: string;
      staged: string;
      pending?: { dataDir: string; from: string; to: string };
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
    // The install itself is untouched by this process — the shell does that.
    assertEquals(await Deno.readTextFile(join(install, "VERSION")), "1.0.0");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a corrupted .zip is refused before anything is unpacked", async () => {
  if (Deno.build.os === "windows") return;
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
  await Deno.writeTextFile(
    join(root, "make.ts"),
    `
const out = "dist/app";
await Deno.mkdir("dist", { recursive: true });
await Deno.writeTextFile(out, \`#!/bin/sh
if [ "$1" = "--aio-data-contract" ]; then echo '${contract}'; exit 0; fi
echo APP 2.0.0
\`);
await Deno.chmod(out, 0o755);
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
      await Deno.readTextFile(`${r.artifact}.old-1.0.0`),
      appBody("1.0.0"),
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
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));
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
    assertEquals(await Deno.readTextFile(r.artifact), "#!/bin/sh\nexit 0\n");
    assertEquals(exits, [0]);
    // The digest recorded is the one that was VERIFIED, so the NEXT rebuild is
    // detectable too — the loop closes.
    const after = readTrust(r.dataDir).installedSha256;
    assert(after && after !== digest, "the new build's digest is recorded");
    assertEquals(
      (await runtimeFor(r, {}).check({ dismissed: null })).kind,
      "current",
    );
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
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));
    assertEquals(exits, []);

    // The UNATTENDED path goes through the same guard — before this, `auto`
    // had no guard of any kind.
    const auto = make(true);
    assertEquals((await auto.check({ dismissed: null })).kind, "offer");
    refused = "";
    await auto.apply().catch((e) => (refused = String(e)));
    assertStringIncludes(refused, "canApply");
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));

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
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));

    // …and when the app says yes, it installs.
    busy = false;
    const ok = make(false);
    assertEquals((await ok.check({ dismissed: null })).kind, "offer");
    await ok.apply();
    await settle(ok);
    assertEquals(await Deno.readTextFile(r.artifact), appBody("2.0.0"));
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
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));

    // With one, the backup is taken BEFORE the download — refusing after
    // 156MB has crossed somebody's network is a refusal in the wrong place —
    // and the release installs.
    const snapshots: string[] = [];
    const exits: number[] = [];
    const rt = runtimeFor(r, { snapshots, exits });
    assertEquals((await rt.check({ dismissed: null })).kind, "blocked");
    // Still refused by default: nothing about the gate changed.
    await rt.apply().catch(() => {});
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));

    await rt.apply({ acceptDataLoss: true });
    await settle(rt);
    assertEquals(snapshots.length, 1);
    assertStringIncludes(snapshots[0]!, "pre-1.0.0-state.db");
    assertEquals(await Deno.readTextFile(snapshots[0]!), "SNAPSHOT");
    assertEquals(await Deno.readTextFile(r.artifact), appBody("2.0.0"));
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
