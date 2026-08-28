// updates-retire.test.ts — `apply({ retireData: true })`, the one-step
// "start fresh" for a release the data gate blocks.
//
// The contract under test: the profile is MOVED (never deleted) to a named,
// timestamped archive beside it at handover, an empty profile takes its place,
// and a failure at any step names the step and leaves the previous data where
// it was.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { readPending, writePending } from "../src/server/updates-apply.ts";
import { readTrust, writeTrust } from "../src/server/updates-check.ts";
import {
  archiveName,
  archiveRoot,
  RetireError,
  retireProfile,
} from "../src/server/updates-retire.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
/** The option under test. A variable, not a literal: `retireData` is declared
 *  on the cell's public `ApplyOptions` (src/state/updates-cell.ts). */
const DOOR = { retireData: true, acceptDataLoss: undefined };
const appBody = (v: string) =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${v}; exit 0; fi\necho APP ${v}\n`;

/** A log that keeps what it was told — the steps are part of the contract. */
function recordingLog(): Log & { lines: string[] } {
  const lines: string[] = [];
  const take = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  return {
    lines,
    info: take,
    warn: take,
    error: take,
    debug: () => {},
  } as unknown as Log & { lines: string[] };
}

type Rig = {
  home: string;
  dataDir: string;
  artifact: string;
  releases: string;
  keys: { publicKey: JsonWebKey; privateKey: JsonWebKey };
};

async function rig(): Promise<Rig> {
  const home = await Deno.makeTempDir({ prefix: "aio-retire-" });
  const dataDir = join(home, "data");
  await Deno.mkdir(dataDir);
  const artifact = join(home, "app");
  await Deno.writeTextFile(artifact, appBody("1.0.0"));
  await Deno.chmod(artifact, 0o755);
  return {
    home,
    dataDir,
    artifact,
    releases: join(home, "releases"),
    keys: await generateSigningKey(),
  };
}

/** Publish a release whose contract the local data cannot satisfy. */
async function publishBlocked(r: Rig, version: string): Promise<void> {
  const dir = join(r.releases, "prod");
  await Deno.mkdir(dir, { recursive: true });
  const bytes = new TextEncoder().encode(appBody(version));
  const manifest = await buildShipManifest({
    name: "app",
    version,
    binary: bytes,
    sources: [],
    sign: r.keys,
    channel: "prod",
    target: "binary",
    platform,
    url: `app-${version}`,
    data: { schema: 1, cells: { todos: { version: 2, migratesFrom: 2 } } },
  });
  await Deno.writeFile(join(dir, `app-${version}`), bytes);
  await Deno.writeTextFile(
    join(dir, `${platform.os}-${platform.arch}.json`),
    JSON.stringify(manifest, null, 2),
  );
}

function runtimeFor(r: Rig, log: Log, hooks: {
  exits: number[];
  relaunched: string[];
  shutdowns: number[];
}) {
  return createUpdatesRuntime({
    config: resolveUpdates({ source: `file://${r.releases}`, channel: "prod" }),
    dataDir: r.dataDir,
    appName: "app",
    appVersion: "1.0.0",
    local: { schema: 1, cells: { todos: 1 } },
    exposed: false,
    log,
    argv: [],
    artifact: r.artifact,
    canInstall: ["binary"],
    exit: (code) => void hooks.exits.push(code),
    relaunch: ({ artifact }) => void hooks.relaunched.push(artifact),
    shutdown: () => {
      hooks.shutdowns.push(Date.now());
      return Promise.resolve();
    },
  });
}

Deno.test("retireData: the archive name says which app, which version, when", () => {
  const at = new Date("2026-08-28T10:22:33.456Z");
  assertEquals(
    archiveName("wallet", "1.2.3", at),
    "wallet-1.2.3-2026-08-28T10-22-33Z",
  );
  // Filesystem-safe on every OS, and never empty.
  assertEquals(
    archiveName("my app/v", "2.0", at),
    "my_app_v-2.0-2026-08-28T10-22-33Z",
  );
  assertEquals(archiveName(undefined, "1", at), "app-1-2026-08-28T10-22-33Z");
  assertEquals(archiveRoot("/home/u/.wallet/data"), "/home/u/.wallet/archive");
});

Deno.test("retireData: a blocked release installs, and the profile is retired at handover — moved whole, never deleted", async () => {
  const r = await rig();
  try {
    await publishBlocked(r, "2.0.0");
    // A profile with something in it: a store, a secret, and a pinned key.
    await Deno.writeTextFile(join(r.dataDir, "state.db"), "STORE");
    await Deno.writeTextFile(join(r.dataDir, "app.key"), "SECRET");
    writeTrust(r.dataDir, { key: r.keys.publicKey });

    const log = recordingLog();
    const hooks = { exits: [], relaunched: [], shutdowns: [] } as {
      exits: number[];
      relaunched: string[];
      shutdowns: number[];
    };
    const rt = runtimeFor(r, log, hooks);
    assertEquals((await rt.check({ dismissed: null })).kind, "blocked");

    // Without a door, the gate holds.
    let refused = "";
    await rt.apply().catch((e) => (refused = String(e)));
    assertStringIncludes(refused, "no verified update is staged");
    assertEquals(await Deno.readTextFile(r.artifact), appBody("1.0.0"));

    // The door.
    await rt.apply(DOOR);
    // Loud: every blocker at error level, and what is about to happen.
    assert(
      log.lines.some((l) =>
        l.includes("retireData: installing 2.0.0 OVER a blocker")
      ),
    );
    assert(log.lines.some((l) => l.includes("RETIRED (moved, never deleted)")));
    await rt.handover;

    // Order: shutdown → retire → relaunch → exit.
    assertEquals(hooks.shutdowns.length, 1);
    assertEquals(hooks.relaunched, [r.artifact]);
    assertEquals(hooks.exits, [0]);
    assertEquals(await Deno.readTextFile(r.artifact), appBody("2.0.0"));

    // The previous profile is in the archive, whole.
    const archives = [...Deno.readDirSync(archiveRoot(r.dataDir))].map((e) =>
      e.name
    );
    assertEquals(archives.length, 1);
    assert(archives[0]!.startsWith("app-1.0.0-"), archives[0]);
    const archive = join(archiveRoot(r.dataDir), archives[0]!);
    assertEquals(await Deno.readTextFile(join(archive, "state.db")), "STORE");
    assertEquals(await Deno.readTextFile(join(archive, "app.key")), "SECRET");

    // The fresh profile is empty of DATA, keeps the update identity, and is
    // still armed to roll back — with the archived store as its named backup.
    const fresh = [...Deno.readDirSync(r.dataDir)].map((e) => e.name).sort();
    assertEquals(fresh, ["update-pending.json", "update-trust.json"].sort());
    assertEquals(readTrust(r.dataDir).key?.x, r.keys.publicKey.x);
    const pending = readPending(r.dataDir);
    assertEquals(pending?.to, "2.0.0");
    assertEquals(pending?.backup, join(archive, "state.db"));

    // Every step was logged, in order.
    const steps = log.lines.filter((l) => l.includes("retireData ")).map((l) =>
      l.match(/retireData ([①②③④⑤])/)?.[1] ?? "done"
    );
    assertEquals(steps, ["①", "②", "③", "④", "⑤", "done"]);
    assert(log.lines.some((l) => l.includes(`previous profile at ${archive}`)));
  } finally {
    await Deno.remove(r.home, { recursive: true });
  }
});

Deno.test("retireData: a failed step is named, and the previous data stays exactly where it was", async () => {
  const home = await Deno.makeTempDir({ prefix: "aio-retire-fail-" });
  try {
    const dataDir = join(home, "data");
    await Deno.mkdir(dataDir);
    await Deno.writeTextFile(join(dataDir, "state.db"), "STORE");
    writePending(dataDir, {
      from: "1",
      to: "2",
      previous: "x",
      attempts: 0,
      startedAt: "2026-08-28T10:22:33Z",
    });
    const log = recordingLog();
    const now = new Date("2026-08-28T10:22:33Z");

    // Step ②: the destination already exists — a second retirement in the same
    // second must not merge into the first.
    const taken = join(archiveRoot(dataDir), archiveName("app", "1", now));
    await Deno.mkdir(taken, { recursive: true });
    let err: unknown;
    await retireProfile({ dataDir, appName: "app", appVersion: "1", log, now })
      .catch((e) => (err = e));
    assert(err instanceof RetireError, String(err));
    assertEquals(err.step, "② retire data/");
    assertStringIncludes(err.message, "the previous data is still in place");
    assertEquals(await Deno.readTextFile(join(dataDir, "state.db")), "STORE");
    assertEquals(readPending(dataDir)?.to, "2");

    // Step ①: the archive root cannot be created (a FILE sits at its path).
    await Deno.remove(archiveRoot(dataDir), { recursive: true });
    await Deno.writeTextFile(archiveRoot(dataDir), "not a dir");
    err = undefined;
    await retireProfile({ dataDir, appName: "app", appVersion: "1", log, now })
      .catch((e) => (err = e));
    assert(err instanceof RetireError, String(err));
    assertEquals(err.step, "① create archive dir");
    assertEquals(await Deno.readTextFile(join(dataDir, "state.db")), "STORE");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("retireData: the handover still happens when retirement fails — the app comes back on its previous data, and the log names the step", async () => {
  const r = await rig();
  try {
    await publishBlocked(r, "2.0.0");
    await Deno.writeTextFile(join(r.dataDir, "state.db"), "STORE");
    // Make step ① impossible: a file where the archive root must go.
    await Deno.writeTextFile(archiveRoot(r.dataDir), "not a dir");

    const log = recordingLog();
    const hooks = { exits: [], relaunched: [], shutdowns: [] } as {
      exits: number[];
      relaunched: string[];
      shutdowns: number[];
    };
    const rt = runtimeFor(r, log, hooks);
    assertEquals((await rt.check({ dismissed: null })).kind, "blocked");
    await rt.apply(DOOR);
    await rt.handover;

    assertEquals(await Deno.readTextFile(join(r.dataDir, "state.db")), "STORE");
    assertEquals(hooks.relaunched, [r.artifact]);
    assertEquals(hooks.exits, [0]);
    const named = log.lines.find((l) =>
      l.includes('retireData step "① create archive dir" failed')
    );
    assert(named, log.lines.join("\n"));
    assertStringIncludes(named, "restarts against the previous data");
  } finally {
    await Deno.remove(r.home, { recursive: true });
  }
});
