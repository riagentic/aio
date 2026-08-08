// updates-runtime.ts — the server half of the `updates` cell.
//
// This is where the pure decision layer (updates-core), the IO layer
// (updates-check) and the swap primitives (updates-apply) meet. It owns
// exactly one thing: the ORDER in which they run, which is the part that has
// to be right every time.
//
//   check:  fetch → verify claims → pin key (TOFU) → decide → report
//   apply:  download → verify bytes → back up if migrating → swap → mark
//           pending → hand over
//
// Nothing may be reordered. Verifying after downloading is fine; installing
// before verifying is not. Backing up after migrating is useless. Handing over
// before writing the pending marker loses the ability to roll back.
import { join } from "@std/path";
import type { Log } from "../diagnostics/logger.ts";
import {
  type ShipExpectations,
  type ShipManifest,
  type UpdateTarget,
  verifyManifestClaims,
} from "../build/ship.ts";
import {
  type CheckResult,
  updates,
  type UpdatesRuntime,
} from "../state/updates-cell.ts";
import {
  artifactUrl,
  decide,
  decideGit,
  type LocalData,
  manifestUrl,
  type ResolvedUpdates,
} from "./updates-core.ts";
import {
  currentCommit,
  downloadArtifact,
  fetchManifest,
  gitLsRemote,
  pinKey,
  readTrust,
  verifyDownload,
  writeTrust,
} from "./updates-check.ts";
import {
  artifactPath,
  detectTarget,
  installableTargets,
  installDir,
  pruneOld,
  relaunch,
  swapArtifact,
  swapDirectoryDetached,
  unpackArchive,
  writePending,
} from "./updates-apply.ts";
import { dataCompatibility } from "./updates-core.ts";
import { rebuildFromGit } from "./updates-rebuild.ts";

/** How many superseded artifacts to keep so a manual rollback is a rename. */
const KEEP_OLD = 3;

export type UpdatesRuntimeDeps = {
  config: ResolvedUpdates;
  /** The app's `data/` directory — the trust store and backups live here. */
  dataDir: string;
  appVersion: string;
  /** What is on disk right now, for the data-compatibility gate. */
  local: LocalData;
  exposed: boolean;
  log: Log;
  /** argv to replay into the successor process. */
  argv: string[];
  /** Consistent copy of the state database (SQLite `VACUUM INTO`). Absent for
   *  an app with no persistence — then there is nothing to back up. */
  snapshot?: (path: string) => Promise<void>;
  /** Stop the app cleanly before handing over. */
  shutdown?: () => Promise<void>;
  /** Overridable so tests can assert the handover without ending the process. */
  exit?: (code: number) => void;
  /** The artifact to replace. Defaults to what this process is running from —
   *  injected so a test can drive a real swap against a temp file. */
  artifact?: string;
  /** Install strategies this process can perform. Defaults to what the running
   *  artifact supports. */
  canInstall?: UpdateTarget[];
  /** Start the successor. Injected so a test can assert the handover without
   *  actually launching anything. */
  relaunch?: (opts: { artifact: string; args: string[] }) => void;
  /** Hand a directory swap to the system shell. Injected in tests. */
  swapDirectory?: typeof swapDirectoryDetached;
  /** Where a git rebuild works. Injected in tests; defaults to a temp dir. */
  makeWorkDir?: () => Promise<string>;
};

export function createUpdatesRuntime(deps: UpdatesRuntimeDeps): UpdatesRuntime {
  const { config, log } = deps;
  let channel = config.channel;
  // The manifest that produced the current offer. `apply` installs THIS, never
  // a freshly-fetched one: re-fetching between the user seeing a version and
  // agreeing to it would install something they were never shown.
  let offered: ShipManifest | null = null;

  const platform = { os: Deno.build.os, arch: Deno.build.arch };
  const targetOf = () => deps.artifact ?? artifactPath();
  const canInstall = () => deps.canInstall ?? installableTargets();

  function expectations(): ShipExpectations {
    const trust = readTrust(deps.dataDir);
    return {
      channel,
      platform,
      key: config.key ?? trust.key,
      allowUnsigned: config.allowUnsigned,
    };
  }

  async function checkManifest(): Promise<CheckResult> {
    const trust = readTrust(deps.dataDir);
    const url = manifestUrl(config.source, channel, platform);
    const got = await fetchManifest(url, trust.etag);
    if (got.kind === "error") return { kind: "error", error: got.error };
    if (got.kind === "not-modified") {
      return { kind: "current", reason: `${deps.appVersion} is the latest` };
    }

    const m = got.manifest;
    const expect = expectations();
    const claims = await verifyManifestClaims(m, expect);
    if (!claims.ok) {
      // A verification failure is never "no update available". Saying nothing
      // here is how a misconfigured or attacked channel looks exactly like a
      // healthy one.
      return { kind: "error", error: claims.reason };
    }

    // Trust on first use: the first release that verifies under its own key
    // pins that key, loudly, and every release afterwards must match it.
    if (!expect.key && m.publicKey && m.signature) {
      pinKey(deps.dataDir, m.publicKey);
      log.warn(
        "updates",
        `trusting the release signing key on first use (${
          String(m.publicKey.x).slice(0, 12)
        }…) — every future update for this app must be signed by it`,
      );
    }
    if (!m.signature) {
      log.warn(
        "updates",
        `${url} is UNSIGNED — its contents are not authenticated ` +
          `(allowUnsigned is on)`,
      );
    }
    if (got.etag) writeTrust(deps.dataDir, { etag: got.etag });

    const d = decide({
      current: deps.appVersion,
      manifest: m,
      local: deps.local,
      canInstall: canInstall(),
    });

    if (d.kind === "offer") {
      offered = m;
      return {
        kind: "offer",
        update: {
          version: m.version,
          notes: m.notes ?? null,
          size: m.size,
          releasedAt: m.releasedAt,
          migrates: d.migrates,
          warnings: d.warnings,
        },
      };
    }
    offered = null;
    if (d.kind === "incompatible") {
      return {
        kind: "blocked",
        blocked: { version: d.version, blockers: d.blockers },
      };
    }
    if (d.kind === "refused") return { kind: "error", error: d.reason };
    return { kind: "current", reason: d.reason };
  }

  async function checkGit(): Promise<CheckResult> {
    const got = await gitLsRemote(config.source, channel);
    if (!got.ok) return { kind: "error", error: got.error };
    const sha = currentCommit(deps.dataDir);
    // The installer passes the built commit in the environment. Persist it the
    // first time it is seen: an app relaunched by a service manager, or by the
    // update handover, has no installer around to set it again, and losing it
    // would turn every later check into "nothing to compare against".
    if (sha && !readTrust(deps.dataDir).commit) {
      writeTrust(deps.dataDir, { commit: sha });
    }
    const d = decideGit({ currentSha: sha, head: got.head });
    if (d.kind === "offer") {
      return {
        kind: "offer",
        update: {
          version: d.version,
          notes: null,
          size: null,
          releasedAt: null,
          migrates: d.migrates,
          warnings: d.warnings,
        },
      };
    }
    if (d.kind === "incompatible") {
      return {
        kind: "blocked",
        blocked: { version: d.version, blockers: d.blockers },
      };
    }
    if (d.kind === "refused") return { kind: "error", error: d.reason };
    return { kind: "current", reason: d.reason };
  }

  /** Back up the store before a migrating update.
   *
   *  Putting the old binary back cannot un-migrate data, so this is the only
   *  thing that makes a rollback complete. It runs BEFORE the swap: a backup
   *  taken after the new build has touched the store is a backup of the
   *  problem. */
  async function backupBeforeMigration(
    version: string,
  ): Promise<string | undefined> {
    if (!deps.snapshot) return undefined;
    const dir = join(deps.dataDir, "backups");
    await Deno.mkdir(dir, { recursive: true });
    const path = join(dir, `pre-${version}-state.db`);
    await deps.snapshot(path);
    log.info("updates", `backed up the store before migrating → ${path}`);
    return path;
  }

  async function applyManifest(): Promise<void> {
    const m = offered;
    if (!m) throw new Error("no verified update is staged to apply");

    const isDirectory = m.target === "electron-zip";
    const current = isDirectory ? (deps.artifact ?? installDir()) : targetOf();
    if (!current) {
      throw new Error(
        "this is a .zip release, but the running app is not inside an " +
          "unpacked Electron install (no launcher + electron/ above it) — " +
          "nothing to replace",
      );
    }
    const staged = isDirectory
      ? `${current}.staged-${m.version}`
      : `${current}.new-${m.version}`;
    const download = isDirectory ? `${current}.zip-${m.version}` : staged;
    const url = artifactUrl(manifestUrl(config.source, channel, platform), m);

    log.info("updates", `downloading ${m.name} ${m.version} from ${url}`);
    const dl = await downloadArtifact({
      url,
      dest: download,
      expectSha256: m.sha256,
      expectSize: m.size,
      // Progress rides the normal state channel: the applier dispatches into
      // the same cell the UI is bound to, so a progress bar is an ordinary
      // reactive read rather than a second transport.
      //
      // Best-effort, and deliberately so. Progress is observe-only; if the
      // cell is not bound (an applier driven outside a booted app) a failed
      // dispatch must not abort a download that is otherwise fine. Reporting
      // never breaks the thing it reports on.
      onProgress: (f) => {
        try {
          void Promise.resolve(updates.setProgress(f)).catch(() => {});
        } catch { /* not bound — the download continues either way */ }
      },
    });
    if (!dl.ok) throw new Error(dl.error);

    // Verify the BYTES on disk, not the ones we think we downloaded, and under
    // the same expectations as the check — a channel or key that changed in
    // between must not slip through. For a .zip this checks the ARCHIVE, which
    // is what the manifest hashes, and it happens before a single file is
    // unpacked anywhere near the install.
    const verified = await verifyDownload(download, m, expectations());
    if (!verified.ok) {
      await Deno.remove(download).catch(() => {});
      throw new Error(`refusing to install: ${verified.reason}`);
    }
    log.info("updates", `verified ${m.version} — ${verified.reason}`);

    if (isDirectory) {
      await Deno.remove(staged, { recursive: true }).catch(() => {});
      const unpacked = await unpackArchive(download, staged);
      await Deno.remove(download).catch(() => {});
      if (!unpacked.ok) {
        await Deno.remove(staged, { recursive: true }).catch(() => {});
        throw new Error(unpacked.error);
      }
    }

    const migrates = !!m.data && Object.entries(m.data.cells).some(
      ([id, c]) => c.version > (deps.local.cells[id] ?? 0),
    );
    const backup = migrates
      ? await backupBeforeMigration(deps.appVersion)
      : undefined;

    if (isDirectory) {
      // A directory cannot be replaced from inside itself, so the marker is
      // written first and the move is handed to the system shell — see
      // swapDirectoryDetached.
      const previous = `${current}.old-${deps.appVersion}`;
      writePending(deps.dataDir, {
        from: deps.appVersion,
        to: m.version,
        previous,
        backup,
        attempts: 0,
        startedAt: new Date().toISOString(),
      });
      log.info(
        "updates",
        `installed ${deps.appVersion} → ${m.version}; restarting`,
      );
      await deps.shutdown?.();
      (deps.swapDirectory ?? swapDirectoryDetached)({
        current,
        staged,
        fromVersion: deps.appVersion,
        args: deps.argv,
      });
      (deps.exit ?? Deno.exit)(0);
      return;
    }

    const { previous } = await swapArtifact({
      current,
      staged,
      fromVersion: deps.appVersion,
    });
    await pruneOld(current, KEEP_OLD);

    // Written BEFORE the handover. If the new build cannot come up, this is
    // the only thing that tells it to put the old one back.
    writePending(deps.dataDir, {
      from: deps.appVersion,
      to: m.version,
      previous,
      backup,
      attempts: 0,
      startedAt: new Date().toISOString(),
    });

    log.info(
      "updates",
      `installed ${deps.appVersion} → ${m.version}; restarting`,
    );
    await handOver(current);
  }

  /** Take an update from a repository: clone, build, gate, swap.
   *
   *  The order differs from a manifest install in exactly one place, and it is
   *  forced: a commit cannot say what it does to persisted data until it has
   *  been BUILT, so the data gate runs after the build instead of before the
   *  download. Everything the gate protects is still protected — nothing has
   *  been swapped at that point, and a blocked build is thrown away. */
  async function applyGit(): Promise<void> {
    const workDir = await (deps.makeWorkDir ??
      (() => Deno.makeTempDir({ prefix: "aio-rebuild-" })))();
    try {
      const built = await rebuildFromGit({
        source: config.source,
        ref: channel,
        workDir,
        log,
      });
      if (!built.ok) throw new Error(built.error);

      // The same gate a published release passes, asked of the binary that was
      // just built. A repository has no signature to carry the answer, so this
      // is the only place it can be asked — and it is asked before anything is
      // installed, which is what matters.
      const compat = dataCompatibility(deps.local, built.contract);
      if (!compat.ok) {
        throw new Error(
          `refusing to install ${built.sha.slice(0, 8)}: ${
            compat.blockers.join("; ")
          }`,
        );
      }

      const backup = compat.migrates
        ? await backupBeforeMigration(deps.appVersion)
        : undefined;

      // Move the artifact next to the one it replaces before swapping: the
      // build happened in a temp directory, which is very often a different
      // filesystem, and `rename` across filesystems is not atomic (or even
      // possible). Copy first, swap second.
      const current = targetOf();
      const staged = `${current}.new-${built.sha.slice(0, 8)}`;
      await Deno.copyFile(built.artifact, staged);

      const { previous } = await swapArtifact({
        current,
        staged,
        fromVersion: deps.appVersion,
      });
      await pruneOld(current, KEEP_OLD);

      writePending(deps.dataDir, {
        from: deps.appVersion,
        to: built.sha.slice(0, 8),
        previous,
        backup,
        attempts: 0,
        startedAt: new Date().toISOString(),
      });
      // Record the commit this install now runs, so the next check compares
      // against what was actually built rather than what was last downloaded.
      writeTrust(deps.dataDir, { commit: built.sha });

      log.info(
        "updates",
        `rebuilt ${config.source} @ ${built.sha.slice(0, 8)}; restarting`,
      );
      await handOver(current);
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  }

  /** Stop cleanly, start the successor, and get out of its way.
   *
   *  The successor is launched with this process's pid and waits for it to
   *  disappear before booting, because aio refuses to start while another
   *  instance holds the app lock. Under a supervisor there is nothing to
   *  launch — exiting IS the restart, and launching would fight the unit. */
  async function handOver(artifact: string): Promise<void> {
    const supervised = !!Deno.env.get("INVOCATION_ID") || // systemd
      !!Deno.env.get("SUPERVISOR_PROCESS_NAME") ||
      Deno.env.get("AIO_SUPERVISED") === "1";
    await deps.shutdown?.();
    if (supervised) {
      log.info(
        "updates",
        "under a supervisor — exiting so it starts the new version",
      );
    } else {
      (deps.relaunch ?? relaunch)({ artifact, args: deps.argv });
    }
    (deps.exit ?? Deno.exit)(0);
  }

  return {
    exposed: deps.exposed,
    kind: config.kind,
    get channel() {
      return channel;
    },
    get current() {
      return deps.appVersion;
    },
    check: () => config.kind === "git" ? checkGit() : checkManifest(),
    apply: async () => {
      if (!deps.canInstall && detectTarget() === "source") {
        // Dev and prod run the SAME detect path — this is the only divergence,
        // and it is a refusal rather than a silent no-op so the update UI can
        // be developed against a real source.
        throw new Error(
          "running from source — there is no artifact to swap. Build and " +
            "ship a release, then run that artifact.",
        );
      }
      if (config.kind === "git") {
        await applyGit();
        return;
      }
      await applyManifest();
    },
    setChannel: async (next: string) => {
      // Crossing channels can legitimately move the version backwards, and a
      // dismissal on one channel says nothing about another — so everything
      // derived from the old channel is dropped, and the pinned ETag with it.
      channel = next;
      offered = null;
      writeTrust(deps.dataDir, { channel: next, etag: undefined });
      log.info("updates", `following channel "${next}"`);
      await Promise.resolve();
    },
  } as UpdatesRuntime;
}
