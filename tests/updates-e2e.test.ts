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
  await Deno.writeTextFile(artifact, "APP v1.0.0");
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
}): Promise<ShipManifest> {
  const dir = join(r.releases, opts.channel);
  await Deno.mkdir(dir, { recursive: true });
  const fileName = `app-${opts.version}`;
  const bytes = new TextEncoder().encode(opts.body ?? `APP ${opts.version}`);
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
  await Deno.writeFile(
    join(dir, fileName),
    opts.corrupt ? new TextEncoder().encode("TAMPERED") : bytes,
  );
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
  exits?: number[];
  snapshots?: string[];
  relaunched?: string[];
}) {
  const config = resolveUpdates({
    source: `file://${r.releases}`,
    channel: opts.channel ?? "prod",
    auto: opts.auto,
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
    assertEquals((await same.check()).kind, "current");

    // Ship 2.0.0.
    await publish(r, { version: "2.0.0", channel: "prod", notes: "faster" });
    const rt = runtimeFor(r, { exits, relaunched });
    const found = await rt.check();
    assertEquals(found.kind, "offer");
    if (found.kind === "offer") {
      assertEquals(found.update.version, "2.0.0");
      assertEquals(found.update.notes, "faster");
      assertEquals(found.update.migrates, false);
    }

    await rt.apply();

    // The artifact on disk IS the new version, the old one is kept beside it,
    // and the handover was requested.
    assertEquals(await Deno.readTextFile(r.artifact), "APP 2.0.0");
    assertEquals(
      await Deno.readTextFile(`${r.artifact}.old-1.0.0`),
      "APP v1.0.0",
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
    assertEquals((await runtimeFor(r, {}).check()).kind, "offer");
    // TOFU: the first verified release pins its key…
    assertEquals(readTrust(r.dataDir).key?.x, r.keys.publicKey.x);

    // …and a release signed by anyone else is refused from then on.
    const attacker = await generateSigningKey();
    r.keys = attacker;
    await publish(r, { version: "3.0.0", channel: "prod" });
    const got = await runtimeFor(r, {}).check();
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
    assertEquals((await rt.check()).kind, "offer"); // the manifest is fine

    let failed = "";
    await rt.apply().catch((e) => (failed = String(e)));
    assertStringIncludes(failed, "does not match the manifest");

    // The running artifact is untouched, and no half-downloaded file survives.
    assertEquals(await Deno.readTextFile(r.artifact), "APP v1.0.0");
    assertEquals(readPending(r.dataDir), null);
    const strays = [...Deno.readDirSync(r.root)].filter((e) =>
      e.name.startsWith("app.new-")
    );
    assertEquals(strays, []);
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
      new TextEncoder().encode("APP 2.0.0"),
    );

    const got = await runtimeFor(r, { channel: "prod" }).check();
    assertEquals(got.kind, "error");
    if (got.kind === "error") {
      assertStringIncludes(got.error, "channel mismatch");
    }
    assertEquals(await Deno.readTextFile(r.artifact), "APP v1.0.0");
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
    const got = await rt.check();
    assertEquals(got.kind, "blocked");
    if (got.kind === "blocked") {
      assertEquals(got.blocked.version, "2.0.0");
      assertStringIncludes(got.blocked.blockers[0]!, "cannot migrate");
    }

    // And there is no path from blocked to installed.
    let failed = "";
    await rt.apply().catch((e) => (failed = String(e)));
    assertStringIncludes(failed, "no verified update");
    assertEquals(await Deno.readTextFile(r.artifact), "APP v1.0.0");
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
    const got = await rt.check();
    assertEquals(got.kind, "offer");
    if (got.kind === "offer") assertEquals(got.update.migrates, true);

    await rt.apply();

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
    const got = await runtimeFor(r, {}).check();
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
    assertEquals((await permissive.check()).kind, "offer");
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
      (await runtimeFor(r, { channel: "prod" }).check()).kind,
      "current",
    );
    const onTest = await runtimeFor(r, { channel: "test" }).check();
    assertEquals(onTest.kind, "offer");

    // Switching channel re-points the same install, and forgets what the old
    // channel had cached.
    const rt = runtimeFor(r, { channel: "prod" });
    assertEquals((await rt.check()).kind, "current");
    await rt.setChannel("test");
    assertEquals((await rt.check()).kind, "offer");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: minFrom forces a stepping stone, and never installs", async () => {
  const r = await rig();
  try {
    await publish(r, { version: "3.0.0", channel: "prod", minFrom: "2.0.0" });
    const got = await runtimeFor(r, { appVersion: "1.0.0" }).check();
    assertEquals(got.kind, "blocked");
    if (got.kind === "blocked") {
      assertStringIncludes(got.blocked.blockers[0]!, "2.0.0");
    }
    assertEquals(await Deno.readTextFile(r.artifact), "APP v1.0.0");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("updates e2e: a missing channel reports the reason, not silence", async () => {
  const r = await rig();
  try {
    // Silence here is the worst outcome: "no update available" and "your
    // release URL is wrong" must never look the same.
    const got = await runtimeFor(r, { channel: "nope" }).check();
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

    const swaps: { current: string; staged: string }[] = [];
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
      swapDirectory: ({ current, staged }) => {
        swaps.push({ current, staged });
        return { previous: `${current}.old-1.0.0` };
      },
      shutdown: () => Promise.resolve(),
    });

    assertEquals((await rt.check()).kind, "offer");
    await rt.apply();

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

    // The rollback marker is written BEFORE the swap is handed off, or a build
    // that cannot come up would have nothing telling it to go back.
    assertEquals(readPending(r.dataDir)?.to, "2.0.0");
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

    assertEquals((await rt.check()).kind, "offer");
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

    const found = await rt.check();
    assertEquals(found.kind, "offer");
    if (found.kind === "offer") {
      assertEquals(found.update.version, sha.slice(0, 8));
      // A commit cannot say what it does to data until it is built, and that
      // is said rather than implied.
      assertStringIncludes(found.update.warnings[0]!, "after the build");
    }

    await rt.apply();

    // The artifact this process runs from now holds the rebuilt binary…
    assertStringIncludes(await Deno.readTextFile(r.artifact), "APP 2.0.0");
    assertEquals(
      await Deno.readTextFile(`${r.artifact}.old-1.0.0`),
      "APP v1.0.0",
    );
    assertEquals(exits, [0]);
    assertEquals(relaunched, [r.artifact]);
    // …the rollback marker is in place…
    assertEquals(readPending(r.dataDir)?.to, sha.slice(0, 8));
    // …and the commit is recorded, so the next check compares against what was
    // actually built rather than what was last downloaded.
    assertEquals(readTrust(r.dataDir).commit, sha);

    // Nothing new now.
    assertEquals((await gitRuntime(r, repoPath, {}).check()).kind, "current");
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
    assertEquals((await rt.check()).kind, "offer");

    // The gate runs AFTER the build — the only moment the answer exists — but
    // still before anything is installed, which is what matters.
    let failed = "";
    await rt.apply().catch((e) => (failed = String(e)));
    assertStringIncludes(failed, "cannot migrate");
    assertEquals(await Deno.readTextFile(r.artifact), "APP v1.0.0");
    assertEquals(readPending(r.dataDir), null);
    // The commit is NOT recorded — this install did not take it.
    assertEquals(readTrust(r.dataDir).commit, "0".repeat(40));
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});
