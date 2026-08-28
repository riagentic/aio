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
import type { Log } from "../diagnostics/logger-api.ts";
import {
  keyFingerprint,
  type ShipExpectations,
  type ShipManifest,
  type UpdateTarget,
  verifyManifestClaims,
} from "../build/ship.ts";
import {
  type ApplyOptions,
  type CheckOptions,
  type CheckResult,
  createUpdatesCell,
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
  fileSha256,
  gitLsRemote,
  pinKey,
  readTrust,
  recordInstalledSha256,
  verifyDownload,
  writeTrust,
} from "./updates-check.ts";
import {
  artifactPath,
  detectTarget,
  installableTargets,
  installDir,
  type PendingMark,
  pruneKeepingNewest,
  pruneOld,
  relaunch,
  swapArtifact,
  swapDirectoryDetached,
  unpackArchive,
} from "./updates-apply.ts";
import { dataCompatibility } from "./updates-core.ts";
import { rebuildFromGit } from "./updates-rebuild.ts";
import { retireProfile } from "./updates-retire.ts";
import { isServiceSupervised } from "./aio-lifecycle.ts";

/** How many superseded artifacts to keep so a manual rollback is a rename. */
const KEEP_OLD = 3;

export type UpdatesRuntimeDeps = {
  config: ResolvedUpdates;
  /** The app's `data/` directory — the trust store and backups live here. */
  dataDir: string;
  appVersion: string;
  /** The app's own name, as `aio ship` stamped it into the manifest. A release
   *  naming another app is refused before its signature is even looked at —
   *  two apps sharing one release path is a real mistake with a far more
   *  actionable message than "untrusted key". */
  appName?: string;
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

/** `retireData` — see `retireProfile`. Read here through the public
 *  `ApplyOptions`; the field is declared on the cell's type. */
type ApplyOpts = ApplyOptions & { retireData?: boolean };

export function createUpdatesRuntime(deps: UpdatesRuntimeDeps): UpdatesRuntime {
  const { config, log } = deps;
  let channel = config.channel;
  // The manifest that produced the current offer. `apply` installs THIS, never
  // a freshly-fetched one: re-fetching between the user seeing a version and
  // agreeing to it would install something they were never shown.
  let offered: ShipManifest | null = null;
  // The release the DATA GATE refused, kept for the one-way door
  // (`apply({ acceptDataLoss: true })`). Same rule as `offered`: the operator
  // installs the release they were shown the blockers for.
  let blocked: { manifest: ShipManifest; blockers: string[] } | null = null;
  // The restart, once it has been scheduled. Awaited by tests and by anything
  // that wants to know the handover actually ran — see `deferHandOver`.
  let handover: Promise<void> | null = null;

  const platform = { os: Deno.build.os, arch: Deno.build.arch };
  const targetOf = () => deps.artifact ?? artifactPath();
  const canInstall = () => deps.canInstall ?? installableTargets();

  function expectations(): ShipExpectations {
    const trust = readTrust(deps.dataDir);
    return {
      name: deps.appName,
      channel,
      platform,
      key: config.key ?? trust.key,
      keys: config.keys,
      allowUnsigned: config.allowUnsigned,
    };
  }

  /** How a release is described to the user, once it has been verified. */
  function transparency(m: ShipManifest): {
    signed: boolean;
    keyFingerprint: string | null;
  } {
    const signed = !!m.signature && !!m.publicKey;
    return {
      signed,
      keyFingerprint: signed ? keyFingerprint(m.publicKey!) : null,
    };
  }

  /** The digest of the artifact this install is RUNNING.
   *
   *  Without it "I re-published 1.2.3 with new bytes" is undetectable: the
   *  versions compare equal and nothing else distinguishes the two builds. It
   *  is recorded at swap time (the digest that was VERIFIED, never re-read from
   *  disk), and measured ONCE for an install that arrived some other way — the
   *  one-line runner, a package manager, a copied file — because otherwise the
   *  feature would only ever work for an app that had already updated itself.
   *
   *  Measured only for single-file targets: an unpacked directory has no digest
   *  the manifest could be compared against (the manifest hashes the archive it
   *  came in). Unknown stays unknown, and unknown is never an offer. */
  async function installedDigest(m: ShipManifest): Promise<string | undefined> {
    const known = readTrust(deps.dataDir).installedSha256;
    if (known) return known;
    if (!m.sha256) return undefined;
    if (m.target === "electron-zip" || m.target === "android") return undefined;
    const path = targetOf();
    try {
      if (!(await Deno.stat(path)).isFile) return undefined;
      const sha = await fileSha256(path);
      recordInstalledSha256(deps.dataDir, sha);
      log.info(
        "updates",
        `recorded this install's artifact digest (${
          sha.slice(0, 12)
        }…) — a re-published build of ${deps.appVersion} is detectable from now on`,
      );
      return sha;
    } catch (e) {
      // Loud, not silent: the consequence is a whole class of update this
      // install can no longer see, and the user would otherwise be told
      // "you are the latest" forever.
      log.warn(
        "updates",
        `cannot read the running artifact at ${path} (${e}) — a re-published ` +
          `build of ${deps.appVersion} cannot be detected on this install. ` +
          `Fix: run the app from its installed artifact, or update through a ` +
          `release that bumps the version.`,
      );
      return undefined;
    }
  }

  async function checkManifest(opts: CheckOptions): Promise<CheckResult> {
    const trust = readTrust(deps.dataDir);
    const url = manifestUrl(config.source, channel, platform);
    const got = await fetchManifest(url, trust.etagCurrent);
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
    const d = decide({
      current: deps.appVersion,
      manifest: m,
      // The digest of what is INSTALLED rides in beside the persisted cell
      // versions: it is the same kind of fact (what this machine is holding
      // right now) and it is what makes a same-version rebuild detectable.
      local: { ...deps.local, installedSha256: await installedDigest(m) },
      canInstall: canInstall(),
      prerelease: config.prerelease,
      source: config.source,
      artifactUrl: artifactUrl(url, m),
      // Without this the cell's "Not now" lasted exactly one poll: the cell
      // persisted the dismissal and `decide` honoured it, but nothing carried
      // the one to the other.
      dismissed: opts.dismissed,
    });

    if (d.kind === "offer") {
      offered = m;
      blocked = null;
      return {
        kind: "offer",
        update: {
          version: m.version,
          reason: d.reason,
          notes: m.notes ?? null,
          size: m.size,
          releasedAt: m.releasedAt,
          migrates: d.migrates,
          ...transparency(m),
          warnings: d.warnings,
        },
      };
    }
    offered = null;
    // Cache the ETag only for "nothing to do" — an offer, a block or a refusal
    // is unresolved and must re-evaluate on every check, not be short-circuited
    // by a 304 into "you are the latest". A DISMISSAL is "current" too and must
    // not be cached either: the release is still there, the user just said no,
    // and caching that answer turns the next honest check into a 304 that
    // reports "you are the latest" — false, and permanent.
    if (
      got.etag && d.kind === "current" && !d.reason.includes("was dismissed")
    ) {
      writeTrust(deps.dataDir, { etagCurrent: got.etag });
    }
    if (d.kind === "incompatible") {
      // Kept so `apply({ acceptDataLoss: true })` has something to install:
      // the operator's override must install the release they were SHOWN the
      // blockers for, never a freshly-fetched one.
      blocked = { manifest: m, blockers: d.blockers };
      return {
        kind: "blocked",
        blocked: { version: d.version, blockers: d.blockers },
      };
    }
    blocked = null;
    if (d.kind === "refused") return { kind: "error", error: d.reason };
    return { kind: "current", reason: d.reason };
  }

  async function checkGit(opts: CheckOptions): Promise<CheckResult> {
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
    const d = decideGit({
      currentSha: sha,
      head: got.head,
      dismissed: opts.dismissed,
    });
    if (d.kind === "offer") {
      return {
        kind: "offer",
        update: {
          version: d.version,
          reason: d.reason,
          notes: null,
          size: null,
          releasedAt: null,
          migrates: d.migrates,
          // A repository has no manifest and nothing to sign. Saying so is the
          // point of the field: this update is trusted because you trust the
          // repository, not because anything was verified.
          signed: false,
          keyFingerprint: null,
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
    required = false,
  ): Promise<string | undefined> {
    if (!deps.snapshot) {
      // The UI says "a backup is taken first" on every migrating offer. Taking
      // none, quietly, while that sentence is on screen is the exact shape of
      // failure this project refuses — so it is said, at the level that matches
      // what is at stake.
      const why =
        `this app has no state snapshot available (no persistence is ` +
        `open), so NO backup can be taken before the migration`;
      if (required) {
        throw new Error(
          `refusing to install: ${why} — and this install was asked to accept ` +
            `data loss, which is only allowed when the data can be put back. ` +
            `Fix: run the app with its normal persistence open, or take a copy ` +
            `of the data directory by hand first.`,
        );
      }
      log.warn(
        "updates",
        `${why}. The update still migrates your data; a rollback will put the ` +
          `old build back but cannot un-migrate the store.`,
      );
      return undefined;
    }
    const dir = join(deps.dataDir, "backups");
    await Deno.mkdir(dir, { recursive: true });
    const path = join(dir, `pre-${version}-state.db`);
    await deps.snapshot(path);
    // Same retention as the superseded artifacts, and for the same reason: a
    // rollback needs the LAST one, not every one ever taken. Pruned after the
    // new snapshot exists, so the count never dips below what a rollback needs.
    await pruneKeepingNewest(dir, "pre-", KEEP_OLD);
    log.info("updates", `backed up the store before migrating → ${path}`);
    return path;
  }

  async function applyManifest(opts: ApplyOpts): Promise<void> {
    const accepted = opts.acceptDataLoss === true;
    const retire = opts.retireData === true;
    const m = offered ??
      (accepted || retire ? blocked?.manifest ?? null : null);
    if (!m) {
      throw new Error(
        "no verified update is staged to apply — run updates.check() first, " +
          "and apply the release it offers",
      );
    }
    // The one-way door, opened. Everything about it is loud on purpose: this
    // is an operator overriding the gate that exists to protect their data.
    let forcedBackup: string | undefined;
    if (retire && !offered && blocked) {
      // The OTHER door: the data is not migrated, so it needs no snapshot —
      // the whole profile is moved aside, intact, at handover. Loud all the
      // same: this is an operator choosing to start over.
      for (const b of blocked.blockers) {
        log.error(
          `retireData: installing ${m.version} OVER a blocker — ${b}`,
        );
      }
      log.error(
        `retireData: proceeding with ${m.version}. The current profile will ` +
          `be RETIRED (moved, never deleted) to <home>/archive/ when the app ` +
          `restarts, and ${m.version} starts on an empty one.`,
      );
    } else if (accepted && !offered && blocked) {
      for (const b of blocked.blockers) {
        log.error(
          `acceptDataLoss: installing ${m.version} OVER a blocker — ${b}`,
        );
      }
      // Taken BEFORE the download, not before the swap: refusing after 156MB
      // has crossed somebody's network is a refusal in the wrong place.
      forcedBackup = await backupBeforeMigration(deps.appVersion, true);
      log.error(
        `acceptDataLoss: proceeding with ${m.version}. The store as it is now ` +
          `is backed up at ${forcedBackup}; if the new build cannot read your ` +
          `data, stop the app and copy that file back over <data>/state.db.`,
      );
    }

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
    // The cell already said "downloading" optimistically; this is the applier
    // confirming that bytes are actually being asked for, and it is what makes
    // the phase true rather than hopeful.
    phase("downloading");
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
          void Promise.resolve(createUpdatesCell().setProgress(f))
            .catch(() => {});
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
    const backup = forcedBackup ??
      (migrates ? await backupBeforeMigration(deps.appVersion) : undefined);
    noteBackup(backup);

    // The swap is the point of no return, and it is the phase a person watching
    // a progress bar sees stop moving. Say what is happening.
    phase("applying");

    const pending: PendingMark = {
      dataDir: deps.dataDir,
      from: deps.appVersion,
      to: m.version,
      backup,
    };

    if (isDirectory) {
      // A directory cannot be replaced from inside itself, so the marker is
      // written first (inside swapDirectoryDetached) and the move is handed to
      // the system shell.
      log.info(
        "updates",
        `installed ${deps.appVersion} → ${m.version}; restarting`,
      );
      recordInstalledSha256(deps.dataDir, m.sha256);
      deferHandOver(
        () =>
          void (deps.swapDirectory ?? swapDirectoryDetached)({
            current,
            staged,
            fromVersion: deps.appVersion,
            args: deps.argv,
            pending,
          }),
        retire,
      );
      return;
    }

    await swapArtifact({
      current,
      staged,
      fromVersion: deps.appVersion,
      // Names the new file when this app was installed by `run.sh`
      // (~/app/<name>/<name>-<version>) — without it the swap would flatten
      // that layout into a single file and lose every earlier version.
      toVersion: m.version,
      // The marker goes down BEFORE the first rename — the swap owns that
      // ordering, so nothing here can get it wrong.
      pending,
    });
    await pruneOld(current, KEEP_OLD);
    // What is installed now, by digest. This is the fact that makes the NEXT
    // "same version, re-published" detectable, and it is the digest that was
    // verified above — never one re-read from the file that was just written.
    recordInstalledSha256(deps.dataDir, m.sha256);

    log.info(
      "updates",
      `installed ${deps.appVersion} → ${m.version}; restarting`,
    );
    startHandOver(current, retire);
  }

  /** Take an update from a repository: clone, build, gate, swap.
   *
   *  The order differs from a manifest install in exactly one place, and it is
   *  forced: a commit cannot say what it does to persisted data until it has
   *  been BUILT, so the data gate runs after the build instead of before the
   *  download. Everything the gate protects is still protected — nothing has
   *  been swapped at that point, and a blocked build is thrown away. */
  async function applyGit(opts: ApplyOpts): Promise<void> {
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
      noteBackup(backup);

      // Move the artifact next to the one it replaces before swapping: the
      // build happened in a temp directory, which is very often a different
      // filesystem, and `rename` across filesystems is not atomic (or even
      // possible). Copy first, swap second.
      const current = targetOf();
      const staged = `${current}.new-${built.sha.slice(0, 8)}`;
      await Deno.copyFile(built.artifact, staged);

      phase("applying");
      await swapArtifact({
        current,
        staged,
        fromVersion: deps.appVersion,
        toVersion: built.sha.slice(0, 8),
        pending: {
          dataDir: deps.dataDir,
          from: deps.appVersion,
          to: built.sha.slice(0, 8),
          backup,
        },
      });
      await pruneOld(current, KEEP_OLD);

      // Record the commit this install now runs, so the next check compares
      // against what was actually built rather than what was last downloaded.
      // The artifact digest is cleared with it: a rebuild produces bytes no
      // manifest ever described, and a stale digest would be a lie about what
      // is installed.
      writeTrust(deps.dataDir, {
        commit: built.sha,
        installedSha256: undefined,
      });

      log.info(
        "updates",
        `rebuilt ${config.source} @ ${built.sha.slice(0, 8)}; restarting`,
      );
      startHandOver(current, opts.retireData === true);
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  }

  /** Tell the cell (and every client bound to it) which phase this is.
   *
   *  Best-effort for the same reason progress is: an applier driven outside a
   *  booted app has no cell to talk to, and reporting must never break the
   *  thing it reports on. */
  function phase(next: "downloading" | "applying"): void {
    try {
      void Promise.resolve(createUpdatesCell().setPhase(next)).catch(() => {});
    } catch { /* not bound — the install continues either way */ }
  }

  /** Report the pre-migration backup into the cell, the same way `phase` does.
   *
   *  The path was already computed, logged and written into the pending marker
   *  so a rollback could name it — and it stopped there, so no UI could show
   *  it. Reported the moment it exists, which is before the swap: an install
   *  that then fails and rolls back still leaves the path on screen, which is
   *  exactly when someone needs it. */
  function noteBackup(path: string | undefined): void {
    if (!path) return;
    try {
      void Promise.resolve(createUpdatesCell().setBackupPath(path)).catch(
        () => {},
      );
    } catch {
      // aio-ok: reporting the backup to the cell is observation, and the cell
      // may not be bound at all (a headless install, a test driving the
      // runtime directly). The backup itself is already taken, logged, and
      // written into the pending marker a rollback reads — failing the install
      // because the UI could not be told about it would trade a real guarantee
      // for a cosmetic one. The same shape as `phase()` above.
    }
  }

  /** Stop cleanly, start the successor, and get out of its way.
   *
   *  The successor is launched with this process's pid and waits for it to
   *  disappear before booting, because aio refuses to start while another
   *  instance holds the app lock. Under a supervisor there is nothing to
   *  launch — exiting IS the restart, and launching would fight the unit. */
  function startHandOver(artifact: string, retire = false): void {
    // ONE decider for "under a service manager", shared with aio.restart().
    const supervised = isServiceSupervised();
    deferHandOver(() => {
      if (supervised) {
        log.info(
          "updates",
          "under a supervisor — exiting so it starts the new version",
        );
      } else {
        (deps.relaunch ?? relaunch)({ artifact, args: deps.argv });
      }
    }, retire);
  }

  /** Run the shutdown + restart OUTSIDE the cell method that asked for it.
   *
   *  `apply()` is an async cell method. Calling `shutdown()` from inside it put
   *  the app in the position of waiting for its own caller: `settlePending`
   *  held for its full 3s grace on the very method driving the shutdown, timed
   *  out, and logged "writes are lost" — on every SUCCESSFUL update. Deferring
   *  by one macrotask lets the dispatch settle first, so the shutdown sees a
   *  quiet cell and the log tells the truth.
   *
   *  The promise is kept so a test (and anything else that cares) can await the
   *  restart it scheduled; nothing in production awaits it, because by then
   *  this process is gone. */
  function deferHandOver(run: () => void, retire = false): void {
    handover = new Promise<void>((resolve) => {
      setTimeout(() => {
        void (async () => {
          try {
            await deps.shutdown?.();
            // `retireData`: persistence is closed NOW and the successor has
            // not started — the one moment a profile can be moved whole. A
            // failed step is named, the previous data stays put, and the
            // handover still happens: the new build is already installed, so
            // it starts against the previous profile under the ordinary
            // rollback net (two boots to serve, or the old build comes back).
            if (retire) {
              try {
                await retireProfile({
                  dataDir: deps.dataDir,
                  appName: deps.appName,
                  appVersion: deps.appVersion,
                  log,
                });
              } catch (e) {
                log.error(
                  `${e instanceof Error ? e.message : e}. The app restarts ` +
                    `against the previous data; retire it by hand (stop the ` +
                    `app, move <data> aside) or try again.`,
                );
              }
            }
            run();
          } catch (e) {
            // Nothing is left to catch this: the method that started the
            // update has long since returned.
            log.error(
              `update handover FAILED (${e}) — the new version is installed ` +
                `but this process could not hand over to it. Restart the app ` +
                `by hand; the update is already in place.`,
            );
          } finally {
            (deps.exit ?? Deno.exit)(0);
            resolve();
          }
        })();
      }, 0);
    });
  }

  /** Ask the app whether NOW is a moment it can be restarted.
   *
   *  The only guard `auto: true` has ever had. A `false` is not an error — it
   *  is the app saying "not while I am doing this" — but it IS a refusal, and
   *  it says so rather than pretending the update was applied. */
  async function vetoed(): Promise<string | null> {
    if (!config.canApply) return null;
    let ok: boolean;
    try {
      ok = await config.canApply();
    } catch (e) {
      // A hook that throws is not permission. Fail closed.
      return `the app's updates.canApply hook threw (${e}) — refusing to ` +
        `install, because a guard that cannot answer is not a yes`;
    }
    if (ok) return null;
    return "the app refused this moment (updates.canApply returned false) — " +
      "something is in flight that must not be interrupted. The release is " +
      "still there; it will be offered again on the next check.";
  }

  // `auto` restarts the app under whoever is using it. On a service that is the
  // whole point; on something with a window it is a surprise, and there is no
  // default that can tell the difference — so it is said, once, at boot, with
  // the two ways out named.
  if (config.auto && !config.canApply && isDesktopTarget()) {
    log.warn(
      "updates",
      `updates.auto is ON for a desktop install (${detectTarget()}) — this ` +
        `app will download a release and RESTART ITSELF while somebody is ` +
        `using it, with nothing to interrupt it. Either render ` +
        `\`updates.available\` and let the user press the button ` +
        `(auto: false), or supply updates.canApply so the app can refuse a ` +
        `bad moment.`,
    );
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
    /** The scheduled restart, for a caller that must observe it (tests, and the
     *  boot path when it wants to know the handover ran). Null until an apply
     *  has staged something. */
    get handover() {
      return handover;
    },
    check: (opts) =>
      config.kind === "git" ? checkGit(opts) : checkManifest(opts),
    apply: async (opts: ApplyOpts = {}) => {
      if (!deps.canInstall && detectTarget() === "source") {
        // Dev and prod run the SAME detect path — this is the only divergence,
        // and it is a refusal rather than a silent no-op so the update UI can
        // be developed against a real source.
        throw new Error(
          "running from source — there is no artifact to swap. Build and " +
            "ship a release, then run that artifact.",
        );
      }
      // Asked HERE, once, so it covers both callers: the button and the
      // unattended `auto` path both reach the applier through this method.
      const veto = await vetoed();
      if (veto) throw new Error(veto);
      if (config.kind === "git") {
        await applyGit(opts);
        return;
      }
      await applyManifest(opts);
    },
    setChannel: async (next: string) => {
      // Crossing channels can legitimately move the version backwards, and a
      // dismissal on one channel says nothing about another — so everything
      // derived from the old channel is dropped, and the pinned ETag with it.
      channel = next;
      offered = null;
      blocked = null;
      // `etagCurrent` is the field that is READ. Clearing the legacy `etag`
      // instead left the old channel's cached validator in place, so the first
      // check after a channel change could answer 304 — "you are the latest" —
      // against a manifest from the channel the user just left.
      writeTrust(deps.dataDir, {
        channel: next,
        etag: undefined,
        etagCurrent: undefined,
      });
      log.info("updates", `following channel "${next}"`);
      await Promise.resolve();
    },
  } as UpdatesRuntime;
}

/** Does this install put a window in front of a person?
 *
 *  Used for one warning, and deliberately conservative: a plain binary can be a
 *  service or a CLI, so it is not counted. An Electron install always has a UI. */
function isDesktopTarget(): boolean {
  const t = detectTarget();
  return t === "electron-appimage" || t === "electron-zip";
}
