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
import type { Log } from "../diagnostics/logger.ts";
import type { CheckResult } from "../state/updates-cell.ts";
import {
  createUpdatesCell,
  installUpdatesRuntime,
} from "../state/updates-cell.ts";
import { createUpdatesRuntime } from "./updates-runtime.ts";
import {
  type LocalData,
  resolveUpdates,
  type UpdatesInput,
} from "./updates-core.ts";
import { readTrust, writeTrust } from "./updates-check.ts";
import {
  clearPending,
  judgePending,
  readPending,
  restoreArtifact,
  writePending,
} from "./updates-apply.ts";
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

  // Out of attempts. Put it back — loudly, and saying exactly what was undone.
  log.error(
    `update ${pending!.from} → ${pending!.to} failed to come up after ` +
      `${pending!.attempts} attempts — rolling back to ${verdict.to}`,
  );
  try {
    const current = pending!.previous.replace(/\.old-[^/\\]*$/, "");
    await restoreArtifact(current, verdict.previous);
    log.error(`rolled back the artifact → ${verdict.to}`);
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
  } catch (e) {
    log.error(
      `rollback FAILED (${e}) — the previous artifact is at ` +
        `${verdict.previous}; move it back by hand`,
    );
  }
  clearPending(dataDir);
  return true;
}

/** The app is up. Whatever was pending has now proven itself. */
export function confirmPendingUpdate(dataDir: string, log: Log): void {
  const pending = readPending(dataDir);
  if (judgePending(pending, true).action !== "confirm") return;
  log.info(
    "updates",
    `update ${pending!.from} → ${pending!.to} confirmed healthy`,
  );
  clearPending(dataDir);
}

export type StartUpdatesDeps = {
  updates: UpdatesInput;
  dataDir: string;
  appVersion: string;
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
  const config = resolveUpdates(deps.updates, {
    flag: deps.flag,
    env: Deno.env.get("AIO_UPDATE_CHANNEL") ?? undefined,
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
    local: deps.local,
    exposed: deps.exposed,
    log: deps.log,
    argv: deps.argv,
    snapshot: deps.snapshot,
    shutdown: deps.shutdown,
  });
  installUpdatesRuntime(runtime);
  // Remember the channel this install follows, so a later run keeps following
  // it without the flag that chose it.
  if (!trust.channel) writeTrust(deps.dataDir, { channel: config.channel });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** One check, plus whatever the policy says to do about the answer. */
  const runCheck = async (): Promise<void> => {
    if (stopped) return;
    // The same instance the boot path created — the factory memoises, so this
    // is a lookup, not a second cell. (It used to be a dynamic import for the
    // side effect; see `createUpdatesCell` for why that shape is gone.)
    const result = await createUpdatesCell().check() as CheckResult | undefined;
    if (result?.kind !== "offer") return;
    const available = result.update;

    if (config.auto) {
      deps.log.info(
        "updates",
        `${available.version} is available — installing it (auto)`,
      );
      await createUpdatesCell().apply();
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
    // Jitter so a fleet updated at the same moment does not check in lockstep
    // forever after — a thundering herd on a release host is self-inflicted.
    const jitter = config.intervalMs * 0.1 * Math.random();
    timer = setTimeout(async () => {
      await runCheck().catch((e) => deps.log.warn("updates", String(e)));
      schedule();
    }, config.intervalMs + jitter);
    // Never hold the process open just to poll for updates.
    if (timer !== undefined) Deno.unrefTimer(timer);
  };

  // The check at boot is the one that matters most — it is the only one an app
  // that runs for thirty seconds will ever do. It cannot run HERE, though: the
  // cell's methods are bound after the server is up, and calling one before
  // that throws "runtime not booted". So it is armed now and fired by
  // `beginUpdates()` once binding is done.
  _pendingBegin = () => {
    void runCheck().catch((e) => deps.log.warn("updates", String(e)));
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
