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
import type { CheckResult, UpdatesRuntime } from "../state/updates-cell.ts";
import {
  createUpdatesCell,
  installUpdatesRuntime,
  readyUpdates,
  updatesRuntime,
} from "../state/updates-cell.ts";
import { createUpdatesRuntime } from "./updates-runtime.ts";

/** The runtime THIS module installed, so a re-boot can tell its own work from
 *  an app's. Not exported: nothing outside needs the distinction, and a getter
 *  would invite somebody to route around the refusal below. */
let _aioInstalled: UpdatesRuntime | null = null;
import {
  type LocalData,
  resolveUpdates,
  type UpdatesInput,
} from "./updates-core.ts";
import { readTrust, writeTrust } from "./updates-check.ts";
import {
  artifactPath,
  clearPending,
  judgePending,
  readPending,
  restoreArtifact,
  sweepStaleSwaps,
  writePending,
} from "./updates-apply.ts";
import type { PendingUpdate } from "./updates-apply.ts";
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
 *  works. Returns true when the caller should stop booting. */
export async function judgePendingUpdate(
  dataDir: string,
  log: Log,
): Promise<boolean> {
  const pending = readPending(dataDir);
  const verdict = judgePending(pending, false);
  if (verdict.action === "none") return false;

  if (verdict.action !== "rollback") {
    if (verdict.action !== "retry") return false;
    writePending(dataDir, { ...pending!, attempts: verdict.attempt });
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
  try {
    await restoreArtifact(current, verdict.previous);
    log.error(`rolled back the artifact → ${verdict.to} (${current})`);
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
    clearPending(dataDir);
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
    log.error(
      `ROLLBACK FAILED (${e}) — ${current} still holds ${pending!.to}, and ` +
        `the version that worked is at ${verdict.previous}. Put it back with:` +
        `\n  mv ${verdict.previous} ${current}\n` +
        `The marker is KEPT, so this is retried (and said) on every boot until ` +
        `it succeeds or the app comes up healthy.`,
    );
    // Do NOT stop the boot. The new build is still in place and might yet come
    // up; bricking the app on top of a failed rollback helps nobody.
    return false;
  }
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
 *  Called after the app is SERVING, not merely after a socket is bound: a build
 *  that throws in `onStart`, or never opens its window, used to be confirmed
 *  healthy and lose its rollback. */
export function confirmPendingUpdate(dataDir: string, log: Log): void {
  const pending = readPending(dataDir);
  if (judgePending(pending, true).action !== "confirm") return;
  log.info(
    "updates",
    `update ${pending!.from} → ${pending!.to} confirmed healthy`,
  );
  clearPending(dataDir);
  // A confirmed update is the moment nothing is in flight, so it is the only
  // safe moment to remove what an interrupted swap left behind. Bounded, aged,
  // and best-effort — never a reason a boot fails.
  void sweepStaleSwaps(pending!.artifact ?? artifactPath())
    .then((removed) => {
      if (removed.length > 0) {
        log.info(
          "updates",
          `swept ${removed.length} leftover${
            removed.length === 1 ? "" : "s"
          } from interrupted swaps: ${removed.join(", ")}`,
        );
      }
    })
    .catch(() => {});
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
let _pendingBegin: (() => void) | null = null;

/** Fire the boot check. Called once the cells are bound — see startUpdates. */
export function beginUpdates(): void {
  const begin = _pendingBegin;
  _pendingBegin = null;
  begin?.();
}

// Synchronous, and says so — same story as `startFeedback`: the dynamic import
// that made it async became static, and only the keyword was left. Callers
// already `await` it, which is unchanged either way.
export function startUpdates(deps: StartUpdatesDeps): StartedUpdates {
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
  const runtime = createUpdatesRuntime({
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
  const installed = updatesRuntime();
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
  installUpdatesRuntime(runtime);
  _aioInstalled = runtime;
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // Consecutive failures back the polling off. Without it a source that is
  // down — or an auto-apply that fails at the same step every time — retried at
  // the configured cadence forever, re-downloading the whole artifact on each
  // pass. Capped at an hour, reset on the first success.
  let failures = 0;
  const MAX_BACKOFF_MS = 60 * 60 * 1000;
  const backoffMs = (): number => {
    if (failures === 0) return config.intervalMs;
    const factor = Math.min(2 ** failures, 64);
    return Math.min(config.intervalMs * factor, MAX_BACKOFF_MS);
  };

  /** One check, plus whatever the policy says to do about the answer. */
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
    const result = await createUpdatesCell().check() as CheckResult | undefined;
    if (result?.kind === "error") {
      fail("update check failed", result.error);
      return;
    }
    failures = 0;
    if (result?.kind !== "offer") return;
    const available = result.update;

    if (config.auto) {
      deps.log.info(
        "updates",
        `${available.version} is available — installing it (auto)`,
      );
      try {
        await createUpdatesCell().apply();
      } catch (e) {
        // An auto-apply that fails at the same step every interval used to
        // re-download the entire artifact each time. Count it like any other
        // consecutive failure.
        fail(`installing ${available.version} failed`, e);
      }
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
      if (yes) await createUpdatesCell().apply();
      else await createUpdatesCell().dismiss();
    }
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
    }, wait + jitter);
    // Never hold the process open just to poll for updates.
    if (timer !== undefined) Deno.unrefTimer(timer);
  };

  // The check at boot is the one that matters most — it is the only one an app
  // that runs for thirty seconds will ever do. It cannot run HERE, though: the
  // cell's methods are bound after the server is up, and calling one before
  // that throws "runtime not booted". So it is armed now and fired by
  // `beginUpdates()` once binding is done.
  _pendingBegin = () => {
    // What the app is CONFIGURED for, published before anything is fetched.
    // `check: false` never runs a boot check, so without this an app that opted
    // out of polling would report `enabled: false` — "updates are not
    // configured" — for its entire life.
    readyUpdates();
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
    void runCheck().catch((e) => {
      failures++;
      deps.log.warn("updates", String(e));
    });
    schedule();
  };

  return {
    source: config.source,
    kind: config.kind,
    channel: config.channel,
    intervalMs: config.intervalMs,
    auto: config.auto,
    stop: () => {
      stopped = true;
      _pendingBegin = null;
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
