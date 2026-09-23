// runtime-flags.ts — the flags an aio PROCESS parses for itself (`--port`,
// `--client`, …), spelled once. `aio-cli.ts` validates argv against them; an
// app's own argument parser (`aio/cli` `args()`) passes them through instead
// of refusing them as unknown — the same binary answers both.
// A trailing `=` marks a flag that takes a value.

/** Every runtime flag, as `--name` (values stripped). */
export const AIO_RUNTIME_FLAGS: ReadonlySet<string> = new Set(
  [
    "--no-data-migrate",
    "--port=",
    "--no-persist",
    "--client=",
    "--keep-server",
    "--title=",
    "--verbose",
    "--prod",
    "--version",
    "--expose",
    "--channel=",
    "--aio-data-contract",
    "--no-tls",
    "--help",
    "--server-url=",
    "--connect",
    "--width=",
    "--height=",
    "--tls-cert=",
    "--tls-key=",
    "--cert=",
    "--key=",
    "--isolate=",
    "--transport=",
    "--open",
    "--takeover",
    "--no-backup-logs",
    "--log-budget=",
    "--db-path=",
    "--host=",
    "--cdp",
    "--cdp=",
    // `aio-cli.ts` parses all three spellings, and none of them was here —
    // the registry two different readers consult. So `declareAppFlags(["--watch="])`
    // passed the collision guard and the app then LOST the flag to aio, which
    // is verbatim the failure that guard's own message describes ("a flag
    // cannot mean two things in one process, and the app would silently lose
    // whichever meaning aio applied first"). And `aio/cli`'s `args()`, which
    // passes aio's own flags through, refused `--no-watch` with "unknown
    // flag" — a flag `am help` advertises as the way to turn live reload off.
    "--watch",
    "--watch=",
    "--no-watch",
    "--__aio-relaunch-after=",
    "--profile=",
    "--home=",
  ].map((f) => (f.endsWith("=") ? f.slice(0, -1) : f)),
);

/** Runtime flags an APP may also claim for itself (added in 1.0.10, after
 *  apps could already have their own `--profile`/`--home`). A claimed one is
 *  the app's: aio does not read it from argv, only from its env variable
 *  (`AIO_PROFILE`, `AIO_HOME`). */
export const CLAIMABLE_RUNTIME_FLAGS: ReadonlySet<string> = new Set([
  "--profile",
  "--home",
]);

const _claimed = new Set<string>();

/** Record that the app's own parser declares `name` (`--profile`). Called by
 *  `aio/cli` `args()` for a spec that declares a claimable flag. @internal */
export function claimRuntimeFlag(name: string): void {
  if (CLAIMABLE_RUNTIME_FLAGS.has(name)) _claimed.add(name);
}

/** Whether the app's own parser claimed `name`. @internal */
export function runtimeFlagClaimed(name: string): boolean {
  return _claimed.has(name);
}

/** The same list in `aio-cli.ts`'s own spelling (value flags carry `=`). */
export const AIO_RUNTIME_FLAG_SPECS: readonly string[] = [
  "--no-data-migrate",
  "--port=",
  "--no-persist",
  "--client=",
  "--keep-server",
  "--title=",
  "--verbose",
  "--prod",
  "--version",
  "--expose",
  "--channel=",
  "--aio-data-contract",
  "--no-tls",
  "--help",
  "--server-url=",
  "--connect",
  "--width=",
  "--height=",
  "--tls-cert=",
  "--tls-key=",
  "--cert=",
  "--key=",
  "--isolate=",
  "--transport=",
  "--open",
  "--takeover",
  "--no-backup-logs",
  "--log-budget=",
  "--db-path=",
  "--host=",
  "--cdp",
  "--cdp=",
  "--__aio-relaunch-after=",
  "--profile=",
  "--home=",
];
