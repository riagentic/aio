// dev-restart.ts — dev auto-restart when a CELL file changes (quant Bad #3).
//
// JSX hot-reloads; cells can't. They run in the server process, so an edited
// cell keeps its old logic while the browser shows new UI — the silent mismatch
// that sends people ghost-hunting. Until now aio warned and asked you to restart
// by hand. Now it restarts itself.
//
// How, without stacking processes: the first restart turns THIS process into a
// thin supervisor. It re-launches the app as a child (marked with
// AIO_DEV_SUPERVISED) and waits. When the child wants to restart it exits with
// RESTART_EXIT_CODE and the supervisor launches a fresh one — so the depth is
// always at most two, no matter how many times you edit a cell.
//
// Honesty rules (dev==prod doctrine):
// - dev only, never in prod, never in libraryMode (a test/host owns the process)
// - only when the process holds ALL permissions, i.e. it was started with `-A`.
//   A narrower grant can't be reconstructed from Deno.permissions (a partial
//   `--allow-read=/x` reads back as "prompt"), and re-launching with `-A` would
//   silently WIDEN permissions. Then we fall back to the warning.
// - opt out with AIO_NO_DEV_RESTART=1

import { fromFileUrl } from "@std/path";
import { log } from "../diagnostics/logger.ts";

/** Exit code a supervised child uses to ask for a fresh process. 75 =
 *  EX_TEMPFAIL — "try again", and outside the range apps use for errors. */
export const RESTART_EXIT_CODE = 75;

const CHILD_ENV = "AIO_DEV_SUPERVISED";
const OPT_OUT_ENV = "AIO_NO_DEV_RESTART";

const PERMISSIONS: Deno.PermissionName[] = [
  "read",
  "write",
  "net",
  "env",
  "run",
  "sys",
  "ffi",
];

/** Why a restart can't happen — null when it can. Pure-ish (queries the
 *  process's own permissions and argv, changes nothing). */
export async function restartBlockedReason(): Promise<string | null> {
  if (env(OPT_OUT_ENV) === "1") return `${OPT_OUT_ENV}=1`;
  if (!Deno.mainModule.startsWith("file:")) {
    return "the entry module is not a local file";
  }
  for (const name of PERMISSIONS) {
    let state: Deno.PermissionState;
    try {
      state = (await Deno.permissions.query({ name })).state;
    } catch {
      return `permission "${name}" could not be queried`;
    }
    if (state !== "granted") {
      // A partial grant reads as "prompt" — we can't reproduce it, and
      // re-launching with -A would hand the app more than it was given.
      return `the process was not started with -A (no full "${name}" permission)`;
    }
  }
  return null;
}

/** Read an env var without exploding when env access is denied. */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** True when this process is already a supervised child. */
export const isSupervisedChild = (): boolean => env(CHILD_ENV) === "1";

/** The argv that re-launches this app: `deno run -A <entry> <args…>`. */
export function relaunchArgs(): string[] {
  return ["run", "-A", fromFileUrl(Deno.mainModule), ...Deno.args];
}

let _restarting = false;

/** Restart the app process because `path` changed. Tears the app down first
 *  (releasing the port and flushing persistence), then either exits for the
 *  supervisor to respawn, or becomes the supervisor itself. Never returns —
 *  except when a restart is impossible, where it warns and returns instead so
 *  the dev session simply continues as before. */
export async function restartForCellChange(
  path: string,
  shutdown: () => Promise<void>,
): Promise<void> {
  // Claimed synchronously: an editor save often produces two FS events, and
  // both would otherwise get past an await and restart twice.
  if (_restarting) return;
  _restarting = true;
  const blocked = await restartBlockedReason();
  const file = path.split("/").pop() ?? path;
  if (blocked) {
    _restarting = false;
    log.warn(
      "watch",
      `cell file changed (${file}) — cells run in the server process and do ` +
        `NOT hot-reload, and auto-restart is off (${blocked}). Restart to ` +
        `apply: stop and re-run \`deno task dev\`. (Client JSX hot-reloads, ` +
        `so you may be seeing new UI on old cell logic.)`,
    );
    return;
  }
  log.info("watch", `cell file changed (${file}) — restarting the app`);
  try {
    await shutdown();
  } catch (e) {
    log.warn("watch", `shutdown before restart failed: ${e}`);
  }
  if (isSupervisedChild()) {
    Deno.exit(RESTART_EXIT_CODE); // the supervisor launches the next one
  }
  await superviseForever();
}

/** Become the supervisor: launch the app as a child, relaunch it whenever it
 *  exits asking for a restart, and pass any other exit code through. */
async function superviseForever(): Promise<never> {
  const args = relaunchArgs();
  const stop = { child: null as Deno.ChildProcess | null };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        try {
          stop.child?.kill(sig);
        } catch { /* already gone */ }
        Deno.exit(0);
      });
    } catch { /* signal not supported here */ }
  }
  while (true) {
    const child = new Deno.Command(Deno.execPath(), {
      args,
      env: { [CHILD_ENV]: "1" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    stop.child = child;
    const { code } = await child.status;
    stop.child = null;
    if (code !== RESTART_EXIT_CODE) Deno.exit(code);
  }
}
