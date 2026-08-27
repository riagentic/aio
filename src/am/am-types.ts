/**
 * @module
 * Type definitions for am — aio manager CLI.
 */

/** Output format for am CLI commands */
export type OutputMode = "pretty" | "json" | "quiet";

/** Result wrapper — success with data or failure with error message */
export type Result<T = unknown> = { ok: true; data: T } | {
  ok: false;
  error: string;
};

/** CLI global flags — port, output mode, filtering, and app targeting options. */
export type GlobalFlags = {
  /** Set when a global flag could not be parsed (e.g. `--port=80a0`).
   *  `am` exits loud on it before running any command — a flag we cannot
   *  read is an error, never a silent default. */
  error?: string;
  port?: number;
  json?: boolean;
  quiet?: boolean;
  jsonBody?: string;
  /** `--args='["a", 2]'` — the POSITIONAL argument list for a cell method,
   *  verbatim. The one spelling that can express a method taking a single
   *  string (`--args='["192.168.1.9"]'`), which no `key=value` form can. */
  jsonArgs?: string;
  filter?: string;
  lines?: number;
  wait?: number;
  /** `--no-wait` — return as soon as the child is spawned, without waiting for
   *  it to be reachable. `am start` WAITS by default (see cmdStart). */
  noWait?: boolean;
  follow?: boolean;
  entry?: string;
  transport?: string;
  app?: string;
  client?: number;
  /** The RUNTIME's `--client=<kind>` (browser/electron/cli), recorded even
   *  though the flag is forwarded to the app as a positional. Without this,
   *  `am log --client=browser` was accepted and tailed the SERVER log: the
   *  client-vs-stdout decision reads `flags.client`, which only the numeric
   *  and bare spellings ever set. */
  clientKind?: string;
  all?: boolean;
  /** `am state --ui` — the filtered UI-state projection (was `am ui`). */
  ui?: boolean;
  /** `am remove --data` — also delete the app's DATA (`~/.<appId>/`). Opt-in
   *  and never implied: state, logs, keys and user files do not come back. */
  data?: boolean;
  /** `--force` — proceed past a refusal the command made for a reason
   *  (currently: removing an app that is still running). */
  force?: boolean;
  /** `am dispatch --as-server` — dispatch with server provenance, past the
   *  cell `access` gate. Dev-only + loopback-only (the trojan already is). */
  asServer?: boolean;
  /** `am kill --stale` — end processes still SERVING with no lock to account
   *  for them. An orphan answers `am state` with old numbers while `am status`
   *  says stopped, which is how you end up reporting stale values as current. */
  stale?: boolean;
  /** `am sql --tables` — the table list, one fixed query. `am tables` is the
   *  same act under its own name; the flag composes with the rest of `sql`. */
  tables?: boolean;
  /** `am open --print` — write the URL instead of opening a browser, so the
   *  answer composes (`open "$(am open --print)"`, curl, a test). */
  print?: boolean;
  /** `--help`/`-h` anywhere → print usage and exit 0. Without this the flag
   *  fell through to the subcommand's positionals and was silently ignored —
   *  `am dispatch --help` answered `{"ok":true}`, which reads as "your
   *  dispatch worked" (a field report). */
  help?: boolean;
  /** `--home=<dir>` — target the instance of this app that runs from THAT
   *  data home (an isolated smoke-test boot beside the user's own). Read in
   *  ONE place (`amHome()` in am-utils) by every lock lookup, so `am
   *  --home=/tmp/x surface 0` reaches that instance's lock and socket, never
   *  the default one's. `AIO_APPS_DIR` is the env-level equivalent (it
   *  relocates every app's home AND the lock dir). */
  home?: string;
  /** `--timeout=<ms>` — how long `am` waits for a live client to answer a
   *  `surface`/`trigger`. Must exceed the server's own client-reply wait so
   *  the server's NAMED reason arrives before `am` gives up. */
  timeout?: number;
};

/** Command handler signature */
export type CmdHandler = (
  args: string[],
  flags: GlobalFlags,
) => void | Promise<void>;
