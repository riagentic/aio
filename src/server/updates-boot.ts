// updates-boot.ts — everything the boot sequence does about updates.
//
// Three separate jobs, each at a specific moment, because each is meaningless
// at the others:
//
//   1. BEFORE the app lock — wait for a predecessor we are replacing.
//   2. BEFORE serving — judge a pending update: count this attempt, or give up
//      and put the old artifact back.
//   3. AFTER the app is up — confirm the pending update, then start checking.
//
// Splitting them is the whole reason an unattended auto-update is safe: the
// build that just replaced another one is the thing that decides whether it
// worked.
import type { Log } from "../diagnostics/logger-api.ts";
import type {
  CheckResult,
  UpdatesRuntime,
  UpdatesSlot,
} from "../state/updates-cell.ts";
import {
  _installUpdatesRuntimeIn,
  _isProcessUpdatesSlot,
  createUpdatesCell,
  installUpdatesRuntime,
  readyUpdates,
  updatesRuntime,
} from "../state/updates-cell.ts";
import { createUpdatesRuntime, unattendedInstall } from "./updates-runtime.ts";
import { MAX_TIMER_DELAY } from "../state/timer-ceiling.ts";

/** The runtime THIS module installed, so a re-boot can tell its own work from
 *  an app's. Not exported: nothing outside needs the distinction, and a getter
 *  would invite somebody to route around the refusal below. */
let _aioInstalled: UpdatesRuntime | null = null;
import {
  type LocalData,
  resolveUpdates,
  type UpdatesInput,
} from "./updates-core.ts";
import {
  abandonedOldStage,
  forgetInstalledDigest,
  readTrust,
  recordInstalledSha256,
  writeTrust,
} from "./updates-check.ts";
import { adoptOlder, ownedPath, sweepOwned } from "./updates-owned.ts";
import { isProcessAlive } from "./single-instance-lock.ts";
import { reconcileInstalledVersion } from "./install-record.ts";
import { basename, dirname, join } from "@std/path";
import {
  artifactPath,
  claimFirstBoot,
  classifyTarget,
  clearPending,
  exeIdentity,
  failedUpdatePath,
  FIRST_BOOT_WAIT_S,
  firstBootPath,
  installDir,
  judgePending,
  KEEP_OLD,
  madeByOlderUpdater,
  parseUpdateRecord,
  pendingPath,
  pruneOld,
  readPending,
  repairSfxStamp,
  restoreArtifact,
  setAsideRecord,
  stampSfxVersion,
  swapDirectoryDetached,
  writePending,
  writeRecordAtomic,
} from "./updates-apply.ts";
import type { PendingUpdate } from "./updates-apply.ts";
import { ensureSfxShortcut } from "./sfx-shortcut.ts";
// NOTE: updates-runtime.ts and updates-cell.ts are imported DYNAMICALLY below,
// never at module scope. `cell()` self-registers on import, so a static value
// import here would register the `updates` cell in every aio app ever written
// — including the ones that never configured updates, which would then see it
// in their cell list, their state, and their --expose visibility warnings.
// Importing it is meant to BE the opt-in; that only holds if this module
// reaches for it exactly when an app asked for updates.

/** Judge a pending update before the app starts serving.
 *
 *  Runs in the NEW build. If it never reaches `confirmPendingUpdate`, the next
 *  boot counts another failed attempt, and when those run out this puts the
 *  previous artifact back and exits so a supervisor starts a version that
 *  works. Returns true when the caller should stop booting.
 *
 *  A marker whose update never replaced THIS executable is not evidence about
 *  the new build (`PendingUpdate.fromExe`). `appVersion` is this process's
 *  version: in the messages, and for a marker confirmed at exit, where a
 *  build reporting another version than the update's (a kept `.old-*` copy
 *  started by hand — a copy, with its own identity) only clears it. Never
 *  more: two builds can report the same version.
 *  `deps` are test seams. */
/** The update (its marker's `startedAt`) this process counted a boot attempt
 *  of — the only one it may give back. */
let counted: string | undefined;

/** Give back the boot attempt this process counted. For a launch that was
 *  refused for what was TYPED — a flag this client cannot honour — and so
 *  says nothing about the build: counted, three such launches rolled a
 *  healthy update back. Never for a boot that failed on its own: those are
 *  what a rollback counts. */
export function returnBootAttempt(dataDir: string, log: Log): void {
  const p = readPending(dataDir);
  if (!p || p.startedAt !== counted) return;
  counted = undefined;
  try {
    writePending(dataDir, { ...p, attempts: p.attempts - 1 });
    log.info(
      "updates",
      `this launch was refused before the app started — not counted as a ` +
        `boot attempt of update ${p.from} → ${p.to}`,
    );
  } catch (e) {
    log.warn(
      "updates",
      `could not give back the boot attempt of update ${p.from} → ${p.to} ` +
        `(${e}) — this refused launch stays counted`,
    );
  }
}

export async function judgePendingUpdate(
  dataDir: string,
  log: Log,
  appVersion?: string,
  deps: {
    os?: typeof Deno.build.os;
    swapDirectory?: typeof swapDirectoryDetached;
    /** `exeIdentity()` of this process's executable. */
    exe?: string;
  } = {},
): Promise<boolean> {
  let pending = readPending(dataDir);
  if (!pending) return false;
  // Said once: what the previous process could not log after its shutdown.
  if (pending.handoverError) {
    log.error(
      "updates",
      `during the handover ${pending.from} → ${pending.to}: ` +
        pending.handoverError,
    );
    const { handoverError: _, ...rest } = pending;
    pending = rest;
    writePending(dataDir, pending);
  }
  // The very file the update was meant to REPLACE is running. A marker
  // without the old file's identity (staged by an older build) is never
  // judged so.
  const oldFile = pending.fromExe !== undefined &&
    pending.fromExe === (deps.exe ?? exeIdentity());
  // Its build already proved itself and ended cleanly before its own confirm
  // could run (see `pendingConfirmer`): confirmed now, with the prune and the
  // log line that could not happen at exit. Before the "did not take effect"
  // test: the old file started by hand after that (a versioned AppImage, a
  // rename back) is not a failed update — the marker simply goes, and nothing
  // is pruned from under the build that is running.
  if (pending.confirmedAt) {
    if (
      oldFile || (appVersion !== undefined && appVersion !== pending.to)
    ) {
      log.info(
        "updates",
        `update ${pending.from} → ${pending.to} confirmed healthy (this is ` +
          `${appVersion ?? pending.from}, started by hand after it)`,
      );
      clearPending(dataDir);
    } else confirmPendingUpdate(dataDir, log);
    return false;
  }
  // The old file is running: the swap never happened (or was undone).
  // Counting this boot as the new build's would confirm it "healthy" on the
  // next start of the old one.
  if (oldFile) {
    log.error(
      "updates",
      `update ${pending.from} → ${pending.to} did not take effect — this is ` +
        `still ${appVersion ?? pending.from}, the build it was to replace. ` +
        `Recorded as failed.`,
    );
    // The swap helper's own record of THIS update (a rollback, a failed swap)
    // is the truthful one: it is kept, and only the marker it could not
    // remove goes.
    const helper = readFailed(dataDir, log);
    if (helper?.startedAt === pending.startedAt && helper.to === pending.to) {
      clearPending(dataDir);
    } else {
      keepFailed(dataDir, {
        ...pending,
        swapFailed: `it never replaced ${pending.from}`,
      }, log);
    }
    try {
      Deno.removeSync(firstBootPath(dataDir));
    } catch (e) {
      // Absent: no helper was watching. Anything else is said.
      if (!(e instanceof Deno.errors.NotFound)) {
        log.warn("updates", `could not remove ${firstBootPath(dataDir)}: ${e}`);
      }
    }
    return false;
  }
  // A directory swap's helper waits for this boot to take the first-boot
  // token, and when it gives up it takes the token itself. Whoever took it
  // decides: having lost, this build was rolled back — it exits before it
  // writes a byte, and the helper is putting the old version back.
  let claim: ReturnType<typeof claimFirstBoot> | undefined;
  let claimError: unknown;
  for (let i = 0; i < 20 && claim === undefined; i++) {
    try {
      claim = claimFirstBoot(dataDir, pending, log);
    } catch (e) {
      claimError = e; // a scanner holding the file: retried, ~2 s
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (claim === undefined || claim === "lost") {
    log.error(
      "updates",
      claim === "lost"
        ? `update ${pending.from} → ${pending.to} was rolled back by the ` +
          `update helper before this boot started (no first boot within ` +
          `${FIRST_BOOT_WAIT_S} s) — exiting; ${pending.from} is starting`
        : `could not take the first-boot token of update ${pending.from} → ` +
          `${pending.to} (${claimError}) — exiting; the update helper puts ` +
          `${pending.from} back`,
    );
    return true;
  }
  const verdict = judgePending(pending, false);
  if (verdict.action === "none") return false;

  if (verdict.action !== "rollback") {
    if (verdict.action !== "retry") return false;
    try {
      writePending(dataDir, { ...pending, attempts: verdict.attempt });
    } catch (e) {
      // Never a reason to kill a boot: a dead boot is what a rollback counts.
      log.error(
        "updates",
        `could not record boot attempt ${verdict.attempt} of update ` +
          `${pending.from} → ${pending.to} (${e}) — booting anyway, uncounted`,
      );
      return false;
    }
    counted = pending.startedAt;
    log.info(
      "updates",
      `verifying update ${pending!.from} → ${pending!.to} ` +
        `(boot attempt ${verdict.attempt}/${verdict.of})`,
    );
    return false;
  }

  // A rollback that already failed once says so on every boot until it either
  // succeeds or the app proves healthy — never once and then quietly.
  if (pending!.rollbackFailed) {
    log.error(
      `the rollback of update ${pending!.from} → ${pending!.to} FAILED on a ` +
        `previous boot (${pending!.rollbackFailed}) — retrying it now`,
    );
  }
  // Out of attempts. Put it back — loudly, and saying exactly what was undone.
  log.error(
    `update ${pending!.from} → ${pending!.to} failed to come up after ` +
      `${pending!.attempts} attempts — rolling back to ${verdict.to}`,
  );
  const current = stableArtifactPath(pending!, log);
  // A Windows directory install is running from `current`: it cannot move
  // its own folder (every in-app attempt failed). The swap helper does it
  // once this process has exited, and starts the old version.
  if ((deps.os ?? Deno.build.os) === "windows" && isDir(current)) {
    try {
      (deps.swapDirectory ?? swapDirectoryDetached)({
        current,
        staged: verdict.previous,
        fromVersion: pending.to,
        args: Deno.args,
      });
    } catch (e) {
      log.error(
        "updates",
        `ROLLBACK FAILED of update ${pending.from} → ${pending.to}: the ` +
          `update helper could not start (${e}). Put ${verdict.previous} ` +
          `back at ${current} by hand.`,
      );
      return false;
    }
    log.error(`the update helper puts ${verdict.to} back once this exits`);
    // The record follows the artifact on THIS layout too (see the flat path
    // below): left alone, `installed.json` kept naming the failed version
    // while the old one ran. Written now because nothing of this build runs
    // after the helper's moves — best-effort and non-fatal, like every
    // reconcile.
    await reconcileInstalledVersion(dirname(current), {
      version: verdict.to,
      artifact: basename(current),
    });
    forgetInstalledDigest(dataDir);
    // The helper's moves happen after this process is gone, and when they
    // fail it starts THIS build again. The record carries this executable's
    // identity, so that boot learns the rollback did not happen (startUpdates)
    // — and the path decided here, which a marker staged by an older build
    // does not carry: that boot puts `installed.json` back beside it.
    // Without the reason an earlier attempt failed for (see the flat path).
    keepFailed(dataDir, {
      ...pending,
      artifact: current,
      failedExe: deps.exe ?? exeIdentity(),
      rollbackFailed: undefined,
    }, log);
    return true;
  }
  try {
    await restoreArtifact(current, verdict.previous, dataDir);
    log.error(`rolled back the artifact → ${verdict.to} (${current})`);
    // The record must follow the ARTIFACT, exactly as the forward swap's
    // reconcile makes it. Left alone, `installed.json` kept naming the failed
    // version while the app ran the old one — `am installed` and `am upgrade`
    // (its from/to report and its prune) then acted on a version that is not
    // running. Best-effort and non-fatal, like the swap's own reconcile.
    await reconcileInstalledVersion(dirname(current), {
      version: verdict.to,
      artifact: basename(current),
    });
    if (verdict.backup) {
      // The binary going back cannot un-migrate the store, so the backup taken
      // before the migration is the other half of the rollback. It is NOT
      // restored automatically: overwriting a database that has been running
      // for two boots could destroy data written since. Name it instead.
      log.error(
        `the update migrated your data — restore the pre-update store with:\n` +
          `  cp ${verdict.backup} <data>/state.db   (stop the app first)`,
      );
    }
    // The recorded digest names the build that just failed; the artifact at
    // `current` is the old one again. Forget it so the next check re-measures
    // instead of offering this install its own bytes as a "new build".
    forgetInstalledDigest(dataDir);
    // Kept as the FAILED record, not deleted: the next boot names it and does
    // not auto-install this version again (see `startUpdates`). Without the
    // reason an earlier attempt at this rollback failed for: it has happened
    // now, and the record with that reason reads as "still not put back".
    keepFailed(dataDir, { ...pending, rollbackFailed: undefined }, log);
    // Exit so the supervisor (or the user) starts the version that works. The
    // artifact at `current` is the old one now; this process is still the new
    // build and must not keep running.
    return true;
  } catch (e) {
    // NEVER clear the marker here. Clearing it after a failed rollback is what
    // turned "this update broke the app" into "this app is broken forever with
    // no record of why": the next boot saw no marker, counted no attempt, and
    // crash-looped in silence.
    writePending(dataDir, {
      ...pending!,
      rollbackFailed: e instanceof Error ? e.message : String(e),
    });
    // `restoreArtifact` says where every artifact is NOW and which command
    // puts one back; that is repeated verbatim, never paraphrased. This line
    // used to add its own account — "`current` still holds <to>, mv <previous>
    // back" — which was false the one time it mattered most: both renames had
    // failed, the stable path was EMPTY, and the failed build sat at
    // `<current>.failed-<ts>`, unmentioned. One decider for "where is the
    // artifact": the error that watched it move.
    log.error(
      `ROLLBACK FAILED of update ${pending!.from} → ${pending!.to}: ` +
        `${e instanceof Error ? e.message : String(e)}\n` +
        `The marker is KEPT, so this is retried (and said) on every boot until ` +
        `it succeeds or the app comes up healthy.`,
    );
    // Do NOT stop the boot. The new build is still in place and might yet come
    // up; bricking the app on top of a failed rollback helps nobody.
    return false;
  }
}

/** Replace the pending marker with the FAILED record `p`. */
function keepFailed(dataDir: string, p: PendingUpdate, log: Log): void {
  try {
    writeRecordAtomic(failedUpdatePath(dataDir), p);
  } catch (e) {
    log.warn("updates", `could not keep the failed-update record: ${e}`);
  }
  clearPending(dataDir);
}

function isDir(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/** The record of an update that was put back, or null. Unreadable is said,
 *  never guessed. */
function readFailed(dataDir: string, log: Log): PendingUpdate | null {
  const path = failedUpdatePath(dataDir);
  let why: string;
  try {
    const p = parseUpdateRecord(Deno.readTextFileSync(path));
    if (typeof p !== "string") return p;
    why = p;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    why = `is unreadable (${e})`;
  }
  setAsideRecord(path, why, log);
  return null;
}

/** The path a rollback has to write to: the STABLE name the user launches.
 *
 *  Recorded at swap time (`PendingUpdate.artifact`) precisely so it is never
 *  guessed. The fallbacks exist only for a marker written before that field
 *  did, and each one says so — the old guess ("strip `.old-<version>` off
 *  `previous`") is correct for the flat layout, produces `current === previous`
 *  on the versioned one (a rename of a file onto itself, reported as success),
 *  and is right-by-accident on electron-zip. */
function stableArtifactPath(p: PendingUpdate, log: Log): string {
  if (p.artifact) return p.artifact;
  const stripped = p.previous.replace(/\.old-[^/\\]*$/, "");
  if (stripped !== p.previous) {
    log.warn(
      "updates",
      `this update was staged by an older build and did not record which ` +
        `path it replaced — rolling back to ${stripped}, derived from ` +
        `${p.previous}`,
    );
    return stripped;
  }
  const launched = artifactPath();
  log.warn(
    "updates",
    `this update was staged by an older build and did not record which path ` +
      `it replaced — rolling back the path this process was launched from ` +
      `(${launched})`,
  );
  return launched;
}

/** The app is up. Whatever was pending has now proven itself.
 *
 *  Called after the app is SERVING and the app's own `onStart` came through,
 *  not merely after a socket is bound: a build that dies in `onStart`, or never
 *  opens its window, used to be confirmed healthy and lose its rollback. */
export function confirmPendingUpdate(
  dataDir: string,
  log: Log,
  /** The marker this boot judged. Given, only THAT one is confirmed: a
   *  confirm that fires late (an async `onStart` settling, the backstop) can
   *  find the NEXT update's marker — written by an install this build ran —
   *  and would have confirmed a build that never booted, dropping its
   *  rollback. `null`: nothing was pending at boot, so nothing is confirmed. */
  judged?: PendingUpdate | null,
): void {
  const pending = readPending(dataDir);
  if (
    judged !== undefined &&
    (!judged || pending?.startedAt !== judged.startedAt ||
      pending?.to !== judged.to)
  ) return;
  if (judgePending(pending, true).action !== "confirm") return;
  log.info(
    "updates",
    `update ${pending!.from} → ${pending!.to} confirmed healthy`,
  );
  clearPending(dataDir);
  // …and so does what is installed, by digest: a directory swap's is carried
  // on the marker (the helper that made the swap knows neither), and the
  // update it belongs to is now the build that stays. A marker without one
  // (a single-file swap, which recorded it as it swapped) changes nothing.
  if (pending!.sha256) {
    recordInstalledSha256(dataDir, pending!.sha256, pending!.releasedAt);
  }
  writeTrust(dataDir, { failedSwaps: undefined });
  // The helper that swapped a directory install in wrote no record (it runs
  // after the build that knew the version has exited): the new version goes
  // on it now that it is the one that stays. A single-file swap wrote it as
  // it swapped, and this finds nothing to change. Only over the version the
  // update replaced: a record that names anything else was written by an
  // install made since, and is newer than this update.
  if (pending!.artifact) {
    recordInstalledVersion(pending!.artifact, pending!.to, dataDir, {
      from: pending!.from,
    });
  }
  // A confirmed update is the moment nothing is in flight, so it is the only
  // safe moment to remove what an interrupted swap left behind. Bounded, aged,
  // and best-effort — never a reason a boot fails.
  // …and the kept-aside copies past KEEP_OLD. A DIRECTORY swap (electron-zip,
  // a macOS .app) is handed to a shell that exits with the process, so
  // nothing pruned them: one whole ~300 MB install leaked per update.
  // The sweep first: it puts an older build's copies on the record, which is
  // all the pruning counts.
  sweepLeftovers(dataDir, pending!.artifact ?? artifactPath(), log);
  _confirm.pruned = pruneOld(
    pending!.artifact ?? artifactPath(),
    KEEP_OLD,
    dataDir,
  ).catch((e) => log.warn("updates", `could not prune old installs: ${e}`));
}

/** The prune the last confirm started — never awaited by a boot; a test
 *  waits for it instead of ending with its directory read still open (under
 *  load: "Leaks detected", in 7 of 96 runs). @internal */
export const _confirm = { pruned: Promise.resolve() as Promise<void> };

/** What to do about a swap that could not be made, for the line that
 *  dismisses the release: which path was held — the earlier copy when the
 *  helper's reason names it, else the install — and what holds a folder on
 *  this OS. Pure. */
export function swapAdvice(
  failed: { swapFailed?: string; artifact?: string; previous: string },
  os: typeof Deno.build.os = Deno.build.os,
): string {
  const held = failed.previous && failed.swapFailed?.includes(failed.previous)
    ? failed.previous
    : failed.artifact ?? "the install folder";
  return os === "windows"
    ? `Close whatever is open in ${held} (a program started from it, an ` +
      `Explorer window, an antivirus scan) or restart the computer`
    : `Make sure this user may move and remove ${held} (its permissions, ` +
      `and those of the folder it is in) and that no program runs from it`;
}

/** Remove the temp files of update records whose write was cut off: a kill
 *  between the write and the rename left `update-trust.json.tmp-<pid>` in the
 *  data directory for good. The directory is the updater's own, so the name
 *  is the proof; one that another LIVE process is writing is left. This
 *  process writes them synchronously, so one carrying its own pid at this
 *  point is an earlier run's. */
export function sweepRecordTmps(
  dataDir: string,
  alive: (pid: number) => boolean = isProcessAlive,
): void {
  try {
    for (const e of [...Deno.readDirSync(dataDir)]) {
      const pid = /^update-[a-z-]+\.json\.tmp-(\d+)$/.exec(e.name)?.[1];
      if (!pid || !e.isFile) continue;
      if (Number(pid) !== Deno.pid && alive(Number(pid))) continue;
      Deno.removeSync(join(dataDir, e.name));
    }
  } catch {
    // aio-ok: no data directory yet, or gone meanwhile — nothing to remove
  }
}

/** Remove what unfinished updates left beside `install` — only what is on
 *  the updater's record (`sweepOwned`) — and say what went, and what looks
 *  like the updater's but is not on it and was left. First, once per record,
 *  what builds older than the record made is taken onto it (`adoptOlder`).
 *  For a moment when no update is in flight. Never a reason a boot fails. */
function sweepLeftovers(dataDir: string, install: string, log: Log): void {
  // A run from source has the `deno` binary as its "install": no update is
  // ever applied there, so nothing beside it is ours, and the one-time look
  // must not judge the files next to someone's `deno` by name and content.
  if (classifyTarget({ execPath: install }) === "source") return;
  let sweeping: ReturnType<typeof sweepOwned>;
  try {
    const taken = adoptOlder(
      dataDir,
      install,
      (p) =>
        basename(p).startsWith(".aio-update-")
          ? abandonedOldStage(p)
          : madeByOlderUpdater(p, install),
    );
    // Said whenever the look is taken — the first start on this version,
    // and any start that finds no record, or one without its mark.
    if (taken !== null) {
      log.info(
        "updates",
        `looked for what an earlier version's updater left beside ` +
          `${install} (the record of what it made has no mark of that ` +
          `yet): ${
            taken.length > 0
              ? `took over ${taken.join(", ")}`
              : "nothing to take over"
          }`,
      );
    }
    sweeping = sweepOwned(dataDir, install);
  } catch (e) {
    log.warn(
      "updates",
      `the record of what the updater made (${ownedPath(dataDir)}) could ` +
        `not be read or written, or the folder of ${install} not listed: ` +
        `${e} — nothing beside ${install} is removed`,
    );
    return;
  }
  try {
    repairSfxStamp(install, dataDir, log);
  } catch (e) {
    log.warn(
      "updates",
      `could not look for the one-click .exe's stamp for ${install} (${e}) ` +
        `— if it is missing, opening that .exe reinstalls the version it ` +
        `carries`,
    );
  }
  void sweeping.then(({ removed, left, unproven, dropped, unreadable }) => {
    if (unreadable.length > 0) {
      log.warn(
        "updates",
        `left alone beside ${install}: cannot be looked at — ${
          unreadable.map((u) => `${u.name} (${u.error})`).join(", ")
        }`,
      );
    }
    if (dropped.length > 0) {
      log.info(
        "updates",
        `off the record of what the updater made (something else has the ` +
          `name now): ${dropped.join(", ")}`,
      );
    }
    for (const { path, bytes } of unproven) {
      log.warn(
        "updates",
        `${path} (${Math.ceil(bytes / 1e6)} MB) was made by this app's ` +
          `updater, but this file system gives no creation time to prove ` +
          `it is still the same thing — it is not removed, and old versions ` +
          `are not pruned here. Delete it by hand while no update runs.`,
      );
    }
    if (removed.length > 0) {
      log.info(
        "updates",
        `removed what an unfinished update left beside ${install}: ` +
          removed.join(", "),
      );
    }
    if (left.length > 0) {
      log.info(
        "updates",
        `left alone beside ${install}: not made by this app's updater — ` +
          left.join(", "),
      );
    }
  });
}

/** The confirm for THIS boot's pending marker, read now — before any check
 *  or install of this process can write the next one. `atExit`: the process
 *  is ending cleanly, so the marker is only stamped `confirmedAt` (one sync
 *  write) and the next boot confirms it, with its prune and its log line. */
export function pendingConfirmer(
  dataDir: string,
  log: Log,
): (atExit?: boolean) => void {
  const judged = readPending(dataDir);
  return (atExit = false) => {
    if (!atExit) return confirmPendingUpdate(dataDir, log, judged);
    const pending = readPending(dataDir);
    if (
      !judged || !pending || pending.startedAt !== judged.startedAt ||
      pending.to !== judged.to || pending.confirmedAt
    ) return;
    try {
      writePending(dataDir, {
        ...pending,
        confirmedAt: new Date().toISOString(),
      });
    } catch (e) {
      // aio-ok: the process is exiting and the logger has flushed — stderr is
      // the one channel left. Unrecorded, the next boot counts an attempt.
      console.error(
        `[aio] updates: could not record update ${pending.from} → ` +
          `${pending.to} as confirmed at exit: ${e}`,
      );
    }
  };
}

export type StartUpdatesDeps = {
  updates: UpdatesInput;
  dataDir: string;
  appVersion: string;
  /** This app's identity, matched against the manifest's signed `name`.
   *
   *  Without it the "a release for another app was published to this path"
   *  refusal is unreachable at runtime: a vendor who signs two products with
   *  one release key could have product B's genuine, correctly-signed manifest
   *  copied onto product A's channel path, and every A install would verify it
   *  and rename B's binary over its own. The value is the appId — the same
   *  identity the lock, the data directory and `am` use — never the artifact's
   *  FILE name, which a versioned install or a `mv` changes. */
  appName: string;
  /** deno.json `build.channel` baked into this artifact. */
  stamp?: string;
  /** `--channel=` on this run. */
  flag?: string;
  local: LocalData;
  exposed: boolean;
  log: Log;
  argv: string[];
  snapshot?: (path: string) => Promise<void>;
  shutdown?: () => Promise<void>;
  /** Ask a human on the terminal. Absent ⇒ never prompt. */
  prompt?: (question: string) => Promise<boolean>;
  /** Which app's `updates` cell and runtime this is (`_updatesForApp`).
   *  Absent ⇒ the process slot `aio/updates` exports. */
  slot?: UpdatesSlot;
  /** Test seam: `exeIdentity()` of this process's executable. */
  exe?: string;
  /** Test seam: `installDir()` — the directory install this process runs
   *  from, or null when it is not one. */
  installDir?: string | null;
  /** Test seam: `artifactPath()` — the file this process was started as. */
  artifact?: string;
};

/** What the boot report needs to describe the update configuration. */
export type StartedUpdates = {
  source: string;
  kind: "manifest" | "git";
  channel: string;
  intervalMs: number;
  auto: boolean;
  /** Stop polling. */
  stop: () => void;
};

/** Wire the `updates` cell to its source and start checking.
 *
 *  Returns the resolved configuration so the boot report can print it — an app
 *  that follows a channel should say which one, once, where somebody will see
 *  it. */
// Armed PER SLOT, as in feedback-boot.ts: one module-level slot let a second
// concurrent boot overwrite the first's, so one app published the other's
// config into a cell not yet bound and never published its own. `null` keys a
// caller that passed no slot (the process cell).
const _pendingBegin = new Map<UpdatesSlot | null, () => void>();

/** Fire `slot`'s boot check. Called once the cells are bound — see
 *  startUpdates. */
export function beginUpdates(slot?: UpdatesSlot): void {
  const key = slot ?? null;
  const begin = _pendingBegin.get(key);
  _pendingBegin.delete(key);
  begin?.();
}

// Synchronous, and says so — same story as `startFeedback`: the dynamic import
// that made it async became static, and only the keyword was left. Callers
// already `await` it, which is unchanged either way.
/** The wait before the next poll after `failures` consecutive failures.
 *
 *  Doubles per failure up to a cap of 4× the interval, bounded to [1 h, 24 h]
 *  — and NEVER below the configured interval. A flat one-hour cap bounded the
 *  result itself, so on the prod cadence (6 h) one failed check cut the next
 *  wait to 1 h: a release host that was down got polled six times as often by
 *  every install; and at any cadence of 1 h or more it never backed off. */
export function updateBackoffMs(intervalMs: number, failures: number): number {
  if (failures === 0) return intervalMs;
  const HOUR = 60 * 60 * 1000;
  const cap = Math.min(Math.max(4 * intervalMs, HOUR), 24 * HOUR);
  const factor = Math.min(2 ** failures, 64);
  return Math.max(intervalMs, Math.min(intervalMs * factor, cap));
}

/** How many times in a row a release whose swap could not be made is tried
 *  before it is dismissed like one that was rolled back. */
export const MAX_FAILED_SWAPS = 3;

/** Put `version` on the `installed.json` beside the install at `here`.
 *
 *  A directory install's moves are made by a helper after the process that
 *  decided them has gone, so nothing wrote the record as they happened (the
 *  single-file swaps do). It is written when the update is CONFIRMED — the
 *  new build is the one that stays — and checked at every boot of a directory
 *  install, which repairs what a confirm cannot see: a version put back by
 *  hand, a rollback the helper did not make, a record an older build left
 *  behind. That repair is said (`said`); a confirm is not — its own line says
 *  the update is healthy.
 *
 *  Only the record written for THIS artifact, and only while nothing is in
 *  flight: a pending marker or a first-boot token means the updater is still
 *  deciding which build stays. Never fatal — the writer reports a write that
 *  failed, and the next boot makes it again. */
function recordInstalledVersion(
  here: string,
  version: string,
  dataDir: string,
  { from, said }: {
    /** Only a record that still names this version is rewritten. */
    from?: string;
    said?: Log;
  } = {},
): void {
  if (isThere(pendingPath(dataDir)) || isThere(firstBootPath(dataDir))) return;
  const dir = dirname(here);
  // This process is already writing it (a confirm earlier in this boot).
  if (recordWrites.has(dir)) return;
  let rec: { version?: unknown; artifact?: unknown } | null;
  try {
    rec = JSON.parse(Deno.readTextFileSync(join(dir, "installed.json")));
  } catch {
    return; // aio-ok: no record beside this install — nothing to keep true
  }
  // A kept-aside copy started by hand runs beside a record that is not its.
  if (rec?.artifact !== basename(here)) return;
  const named = rec.version;
  if (typeof named !== "string" || named === version) return;
  if (from !== undefined && named !== from) return;
  recordWrites.add(dir);
  // Said once the writer has answered: it alone decides what is a record it
  // can rewrite, and it reports a write that failed, with the path and why.
  void reconcileInstalledVersion(dir, { version }).then((written) => {
    if (written) {
      said?.warn(
        "updates",
        `${join(dir, "installed.json")} named ${named} while ${version} is ` +
          `running — corrected`,
      );
    }
  }).finally(() => recordWrites.delete(dir));
}

/** Install folders whose record this process is rewriting right now. */
const recordWrites = new Set<string>();

function isThere(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false; // aio-ok: absent is the answer asked for
  }
}

export function startUpdates(deps: StartUpdatesDeps): StartedUpdates {
  sweepRecordTmps(deps.dataDir);
  const trust = readTrust(deps.dataDir);
  const envChannel = Deno.env.get("AIO_UPDATE_CHANNEL") ?? undefined;
  const config = resolveUpdates(deps.updates, {
    flag: deps.flag,
    env: envChannel,
    pinned: trust.channel,
    stamp: deps.stamp,
  });

  // Static, like everything else on this path: `startUpdates` is awaited from
  // inside `aio.run()`, which an app top-level-awaits, and a dynamic import
  // from there is what deadlocked module evaluation. The cost of importing
  // these eagerly is graph size for apps that never configure updates; the cost
  // of the dynamic form was an app that would not boot at all.
  // THIS app's cell. A second app in the process has its own (see
  // `UpdatesSlot`); every read and write below goes to it, never to the
  // process-wide one another app is showing.
  const slot = deps.slot;
  const updatesCell = () => slot?.cell ?? createUpdatesCell();
  const runtime = createUpdatesRuntime({
    cell: slot?.cell ?? undefined,
    config,
    dataDir: deps.dataDir,
    appVersion: deps.appVersion,
    appName: deps.appName,
    local: deps.local,
    exposed: deps.exposed,
    log: deps.log,
    argv: deps.argv,
    snapshot: deps.snapshot,
    shutdown: deps.shutdown,
  });
  // An app may drive updates ITSELF (see `installUpdatesRuntime` on
  // `aio/updates`): an internal artifact server with its own auth, an MDM push,
  // a signed blob the app already syncs. That is a supported shape — but it is
  // NOT compatible with also configuring `updates:` here, because this line
  // would silently replace the app's implementation with aio's and the app
  // would never know why its own `check()` stopped being called.
  // …but only when it is not one WE installed. `startUpdates` runs once per app
  // boot, and several apps can share a process (D2), so replacing aio's own
  // previous runtime is ordinary. Replacing an app's is the ambiguity.
  // Only the process slot can hold an app's own runtime — it is the one
  // `installUpdatesRuntime` fills. A per-app slot is aio's alone.
  const processSlot = !slot || _isProcessUpdatesSlot(slot);
  const installed = processSlot ? updatesRuntime() : null;
  if (installed && installed !== _aioInstalled) {
    throw new Error(
      `[aio] updates: an update runtime is already installed, and \`updates:\` ` +
        `in aio.run() would replace it.\n\n` +
        `These are the two ways to drive updates and only one can win:\n` +
        `  • \`updates: { source: … }\` — aio checks, verifies and installs.\n` +
        `  • \`installUpdatesRuntime(mine)\` from "aio/updates" — your code ` +
        `does, and the signature, digest and data-contract guarantees become ` +
        `yours to keep.\n\n` +
        `Fix: drop \`updates:\` from aio.run(), or drop the ` +
        `installUpdatesRuntime() call.`,
    );
  }
  if (slot) _installUpdatesRuntimeIn(slot, runtime);
  else installUpdatesRuntime(runtime);
  if (processSlot) _aioInstalled = runtime;
  // Remember the channel this install follows, so a later run keeps following
  // it without the flag that chose it — but ONLY when the choice was durable.
  // A one-off `--channel=beta` (or `AIO_UPDATE_CHANNEL` from one shell) used to
  // be PINNED FOREVER at first boot: an operator who looked at beta once had an
  // install that silently followed beta for the rest of its life. Pinning is an
  // explicit act (`setChannel`) or a property of the artifact (the build stamp).
  const oneOff = deps.flag !== undefined || envChannel !== undefined;
  if (!trust.channel && !oneOff) {
    writeTrust(deps.dataDir, { channel: config.channel });
  } else if (!trust.channel && oneOff) {
    deps.log.info(
      "updates",
      `following channel "${config.channel}" for this run only — it is not ` +
        `pinned (use setChannel(), or a build stamp, to make it permanent)`,
    );
  }

  const declared = config.declared?.check;
  if (typeof declared === "number" && declared > MAX_TIMER_DELAY) {
    deps.log.warn(
      "updates",
      `check: ${declared}ms is longer than a timer can wait (${MAX_TIMER_DELAY}ms ≈ 24.8 days) — polling every ${MAX_TIMER_DELAY}ms instead`,
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // Consecutive failures back the polling off. Without it a source that is
  // down — or an auto-apply that fails at the same step every time — retried at
  // the configured cadence forever, re-downloading the whole artifact on each
  // pass. Capped per `updateBackoffMs`, reset on the first success.
  let failures = 0;
  const backoffMs = (): number => updateBackoffMs(config.intervalMs, failures);

  // An update that was PUT BACK — by the two-boot judge, or by the swap
  // helper when the new version never started. Said on every boot until a
  // check answers, and that version is never auto-installed again: the same
  // release fails the same way, and each pass restarts the app.
  let failed = readFailed(deps.dataDir, deps.log);
  // A rollback handed to the Windows swap helper that is still running the
  // build it was to put back: the helper's move failed, and it restarted this
  // one. The record is rewritten to say so — never "rolled back".
  const exe = deps.exe ?? exeIdentity();
  const stillFailedBuild = failed?.failedExe !== undefined &&
    failed.failedExe === exe;
  if (failed && stillFailedBuild && !failed.rollbackFailed) {
    failed = {
      ...failed,
      rollbackFailed: `the update helper could not move ${failed.previous} ` +
        `back to ${failed.artifact ?? "the install directory"}`,
    };
    try {
      writeRecordAtomic(failedUpdatePath(deps.dataDir), failed);
    } catch (e) {
      deps.log.warn("updates", `could not keep the failed-update record: ${e}`);
    }
  }
  const here = deps.installDir !== undefined ? deps.installDir : installDir();
  if (here) {
    recordInstalledVersion(here, deps.appVersion, deps.dataDir, {
      said: deps.log,
    });
  }
  // The old version was put back BY HAND after the helper could not: another
  // build than the failed one now runs from the path the rollback was for.
  const byHand = !!failed?.rollbackFailed && failed.failedExe !== undefined &&
    exe !== undefined && exe !== failed.failedExe && here !== null &&
    here === failed.artifact;
  // A swap that was never MADE says nothing about the release: the new
  // version never ran, and what stopped the move (a file in use, a program
  // whose working directory is the install) is usually gone a moment later.
  // Dismissing it — the rule for a release that ran and failed — hid a good
  // release for good after one click at a bad moment. So it stays on offer,
  // counted per release on the trust record: after MAX_FAILED_SWAPS in a row
  // it is dismissed after all, with what to do about it. Only when the very
  // executable the update was to replace runs from where it was installed —
  // an old copy started from where it was set aside is not "nothing moved".
  const neverSwapped = !!failed?.swapFailed && !failed.rollbackFailed &&
    failed.fromExe !== undefined && failed.fromExe === exe &&
    (here === null || failed.artifact === undefined ||
      here === failed.artifact);
  let swapFailures = 0;
  if (failed && neverSwapped) {
    const prior = trust.failedSwaps?.to === failed.to
      ? trust.failedSwaps.count
      : 0;
    writeTrust(deps.dataDir, {
      failedSwaps: { to: failed.to, count: prior + 1 },
    });
    // Counted ON DISK, or not offered again: a retry nothing counts never ends.
    try {
      const kept = readTrust(deps.dataDir).failedSwaps;
      if (kept?.to === failed.to && kept.count === prior + 1) {
        swapFailures = prior + 1;
      }
    } catch (e) {
      deps.log.warn("updates", `could not count the failed install: ${e}`);
    }
  }
  const offeredAgain = swapFailures > 0 && swapFailures < MAX_FAILED_SWAPS;
  if (failed) {
    deps.log.error(
      "updates",
      byHand
        ? `update ${failed.from} → ${failed.to} was rolled back by hand ` +
          `(${failed.rollbackFailed}) — this is ${deps.appVersion}`
        : failed.rollbackFailed
        ? `ROLLBACK FAILED of update ${failed.from} → ${failed.to}: ` +
          `${failed.rollbackFailed} — this is ${
            // Neither copy could be moved back: the helper started the old
            // one from where it was set aside.
            failed.fromExe !== undefined &&
              failed.fromExe === (deps.exe ?? exeIdentity())
              ? `${failed.from}, started from where it was set aside`
              : `still ${failed.to}`}. Put ` +
          `${failed.previous} back at ${
            failed.artifact ?? "the install directory"
          } by hand (stop the app first).`
        : failed.swapFailed
        ? `update ${failed.from} → ${failed.to} could not be installed: ` +
          `${failed.swapFailed}, so ${failed.from} was started again` +
          (offeredAgain
            ? ` — ${failed.to} stays on offer (failed attempt ` +
              `${swapFailures} of ${MAX_FAILED_SWAPS})`
            : "")
        : `update ${failed.from} → ${failed.to} was rolled back: ${
          failed.attempts === 0
            ? `it never started (no first boot within ${FIRST_BOOT_WAIT_S} ` +
              `s of the swap — ${
                Deno.build.os === "darwin"
                  ? "macOS refused to open it, or it exited or hung"
                  : "it exited or hung"
              } before booting), so the update helper put ${failed.from} back`
            : `it failed to come up after ${failed.attempts} boots`
        }`,
    );
    // The digest recorded at swap time names the build that was put back.
    forgetInstalledDigest(deps.dataDir);
  }
  // Said and counted: the record goes, and nothing is dismissed. An
  // unattended install waits for a later check — tried again in the boot
  // that follows its own failure, it would restart the app in a loop.
  let swapRetry: string | undefined;
  if (failed && offeredAgain) {
    swapRetry = failed.to;
    failed = null;
    try {
      Deno.removeSync(failedUpdatePath(deps.dataDir));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        deps.log.warn(
          "updates",
          `could not remove the failed-update record: ${e}`,
        );
      }
    }
  }
  // No update in flight: whatever an unfinished one left beside the install
  // is a leftover — a whole copy of the app per failed swap, a download that
  // was cut off — whatever kind of install this is.
  if (
    !isThere(pendingPath(deps.dataDir)) && !isThere(firstBootPath(deps.dataDir))
  ) {
    sweepLeftovers(
      deps.dataDir,
      here ?? deps.artifact ?? artifactPath(),
      deps.log,
    );
  }
  // A one-click install says which version runs from it, so an older `.exe`
  // opened later opens this install instead of extracting over it.
  stampSfxVersion(
    here ?? deps.artifact ?? artifactPath(),
    deps.appVersion,
    deps.log,
  );
  // …and gets the Start-menu shortcut its `.exe` did not add (one made by
  // aio 1.0.17 or older), once — so that download can be deleted.
  ensureSfxShortcut({
    install: here ?? deps.artifact ?? artifactPath(),
    log: deps.log,
  });

  /** One check, plus whatever the policy says to do about the answer. */
  // The release this machine rolled back, for this process's life: never
  // AUTO-installed again even if its dismissal did not land (the cell's
  // `dismissed` is what the UI and a manual `check()` go by).
  let rolledBackTo: string | undefined;
  const runCheck = async (): Promise<void> => {
    if (stopped) return;
    const fail = (what: string, why: unknown) => {
      failures++;
      deps.log.warn(
        "updates",
        `${what}: ${why} — next attempt in ${
          Math.round(backoffMs() / 1000)
        }s (attempt ${failures} in a row has failed)`,
      );
    };
    // The same instance the boot path created — the factory memoises, so this
    // is a lookup, not a second cell. (It used to be a dynamic import for the
    // side effect; see `createUpdatesCell` for why that shape is gone.)
    const result = await updatesCell().check() as CheckResult | undefined;
    if (result?.kind === "error") {
      fail("update check failed", result.error);
      return;
    }
    // A reachable source is not yet a success when there is something to
    // install: an auto-install refused at the same step every pass (a broken
    // seal, a translocated app) must back off too, so the counter is reset
    // only once nothing is left to do or the install went through.
    if (result?.kind !== "offer") {
      failures = 0;
      return;
    }
    const available = result.update;
    // The cell's `apply()` never throws — a failure lands in `status`/`error`
    // for the UI. Read it back, or an unattended install that was REFUSED (a
    // bad seal, a translocated app) left no line in any log and re-downloaded
    // the whole artifact at full cadence.
    // ONE line per refusal: the runtime logs a refused install for every
    // other caller (the button), and keeps quiet for this one, whose line
    // also says when it retries.
    const refused =
      `${available.version} was NOT installed (${deps.appVersion} keeps running)`;
    const install = async (): Promise<void> => {
      try {
        await unattendedInstall(runtime, () => updatesCell().apply());
      } catch (e) {
        fail(refused, e);
        return;
      }
      const c = updatesCell();
      if (c.status === "error") fail(refused, c.error);
      else failures = 0;
    };

    if (config.auto && available.version === swapRetry) {
      swapRetry = undefined;
      failures = 0;
      deps.log.warn(
        "updates",
        `${available.version} is available — its last install could not be ` +
          `made on this machine, so it is tried again at the next check, ` +
          `not now (auto)`,
      );
      return;
    }
    if (config.auto && available.version === rolledBackTo) {
      failures = 0;
      deps.log.warn(
        "updates",
        `${available.version} is available but was rolled back on this ` +
          `machine — not installing it (auto)`,
      );
      return;
    }
    if (config.auto) {
      deps.log.info(
        "updates",
        `${available.version} is available — installing it (auto)`,
      );
      // An auto-apply that fails at the same step every interval used to
      // re-download the entire artifact each time. Count it like any other
      // consecutive failure.
      await install();
      return;
    }
    // Not auto. A UI, if there is one, is already showing this through the
    // cell — that is the point of it being state. The terminal prompt exists
    // only for an install that has no UI to show anything in.
    deps.log.info(
      "updates",
      `${available.version} is available${
        available.migrates
          ? " (migrates your data — a backup is taken first)"
          : ""
      }`,
    );
    if (deps.prompt) {
      const yes = await deps.prompt(
        `Update to ${available.version}? The app will restart. [y/N] `,
      );
      if (yes) return await install();
      await updatesCell().dismiss();
    }
    failures = 0;
  };

  const schedule = () => {
    if (stopped || config.intervalMs <= 0) return;
    const wait = backoffMs();
    // Jitter so a fleet updated at the same moment does not check in lockstep
    // forever after — a thundering herd on a release host is self-inflicted.
    const jitter = wait * 0.1 * Math.random();
    timer = setTimeout(async () => {
      await runCheck().catch((e) => {
        failures++;
        deps.log.warn("updates", String(e));
      });
      schedule();
    }, Math.min(wait + jitter, MAX_TIMER_DELAY));
    // Never hold the process open just to poll for updates.
    if (timer !== undefined) Deno.unrefTimer(timer);
  };

  // The check at boot is the one that matters most — it is the only one an app
  // that runs for thirty seconds will ever do. It cannot run HERE, though: the
  // cell's methods are bound after the server is up, and calling one before
  // that throws "runtime not booted". So it is armed now and fired by
  // `beginUpdates()` once binding is done.
  const beginKey = slot ?? null;
  _pendingBegin.set(beginKey, () => {
    // What the app is CONFIGURED for, published before anything is fetched.
    // `check: false` never runs a boot check, so without this an app that opted
    // out of polling would report `enabled: false` — "updates are not
    // configured" — for its entire life.
    // The rolled-back release is dismissed HERE, before any check — the poll
    // may be off (`check: false`), and a manual `check()` then offered it
    // again: one click reinstalled the build that had just failed.
    if (failed) {
      deps.log.warn(
        "updates",
        neverSwapped
          ? `not installing ${failed.to} again — it could not be put in ` +
            `place on this machine${
              swapFailures > 0 ? ` ${swapFailures} times in a row` : ""
            }. Dismissed. ${
              swapAdvice(failed)
            }; \`undismiss()\` then offers it ` +
            `again, and a newer release is offered as usual.`
          : `not installing ${failed.to} again — it was rolled back on this ` +
            `machine. Dismissed; \`undismiss()\` offers it again, and a ` +
            `newer release is offered as usual.`,
      );
    }
    // The record goes only once the dismissal is COMMITTED: removed first, a
    // dispatch that failed (or a process that died before it landed) offered
    // the rolled-back release again, with nothing left to say why.
    const rolledBack = failed;
    failed = null;
    rolledBackTo = rolledBack?.to;
    void readyUpdates(slot, rolledBack?.to).then((done) => {
      if (!rolledBack || !done) return;
      // The count ends with the dismissal it led to: a release somebody
      // un-dismisses gets its tries afresh, not one more and "4 in a row".
      if (swapFailures >= MAX_FAILED_SWAPS) {
        writeTrust(deps.dataDir, { failedSwaps: undefined });
      }
      try {
        Deno.removeSync(failedUpdatePath(deps.dataDir));
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          deps.log.warn(
            "updates",
            `could not remove the failed-update record: ${e}`,
          );
        }
      }
    }, (e) =>
      deps.log.warn(
        "updates",
        `could not publish the update state${
          rolledBack ? ` or dismiss the rolled-back ${rolledBack.to}` : ""
        }: ${e}`,
      ));
    // `check: false` is documented as "manual `check()` only" and was not:
    // the BOOT check fired anyway, so an app that opted out of polling still
    // contacted the release host on every single launch. `intervalMs === 0` is
    // exactly what `check: false` resolves to.
    if (config.intervalMs <= 0) {
      deps.log.debug(
        "updates",
        "check is off (check: false) — call updates.check() to look",
      );
      return;
    }
    // The poll is armed once the boot check has ANSWERED, exactly as every
    // later pass re-arms. Armed beside it, its wait was always the plain
    // interval: a failed boot check logged "next attempt in 2s" and the next
    // attempt came after 1s regardless.
    void runCheck().catch((e) => {
      failures++;
      deps.log.warn("updates", String(e));
    }).finally(schedule);
  });

  return {
    source: config.source,
    kind: config.kind,
    channel: config.channel,
    intervalMs: config.intervalMs,
    auto: config.auto,
    stop: () => {
      stopped = true;
      _pendingBegin.delete(beginKey);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** A y/n question on a real terminal, or nothing.
 *
 *  Returns undefined when there is no interactive terminal — a systemd unit
 *  has no one to ask, and blocking a service on stdin that will never arrive
 *  is how an app hangs at boot with no explanation. */
export function ttyPrompt(): ((q: string) => Promise<boolean>) | undefined {
  if (!Deno.stdin.isTerminal?.()) return undefined;
  return async (question: string) => {
    await Deno.stdout.write(new TextEncoder().encode(`\n${question}`));
    const buf = new Uint8Array(64);
    const n = await Deno.stdin.read(buf);
    if (n === null) return false;
    const answer = new TextDecoder().decode(buf.subarray(0, n)).trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  };
}
