import {
  AIO_RUNTIME_FLAG_SPECS,
  AIO_RUNTIME_FLAGS,
} from "../diagnostics/runtime-flags.ts";
// CLI parsing — pure functions, no aio.ts internal dependencies
import { log } from "../diagnostics/logger-api.ts";
import { teachableError } from "../diagnostics/error.ts";
import { nearestOf } from "../state/cell-helpers.ts";
import { removalMessage, removalOf } from "../state/removals.ts";
import { findFreePort } from "./paths.ts";
import { BUILD_BOOL_FLAGS, BUILD_VALUE_FLAGS } from "../build/build-flags.ts";

/** Framework version — printed by --version, checked in tests */
export const VERSION = "1.0.0-alpha76";

/** What `--version` prints: what this artifact IS, and what it was built with.
 *
 *  A binary found on a server months later has to be identifiable, and the
 *  first question when one misbehaves is which aio it runs — a bare framework
 *  version answers neither. Pure so it is testable without compiling. */
export function versionLine(
  appId: string,
  appVersion: string | undefined,
  aio: string = VERSION,
): string {
  return `${appId}${appVersion ? ` ${appVersion}` : ""} (aio ${aio})`;
}

// ── CLI ─────────────────────────────────────────────────────────────

/** CLI flags — overrides config values. Accepts args for testing. */
export type CliFlags = {
  port?: number;
  persist?: boolean;
  client?: "electron" | "browser" | "cli" | "server-only";
  keepServer?: boolean;
  title?: string;
  verbose: boolean;
  prod?: boolean;
  version?: boolean;
  expose?: boolean;
  /** `--channel=<name>` — follow a different release channel for THIS run.
   *  Beats the artifact's baked-in stamp and the pinned choice; see
   *  docs/deploy/updates.md. */
  channel?: string;
  /** `--aio-data-contract` — print this build's persisted-schema promise as
   *  JSON and exit. `aio ship` runs it to publish a contract that is MEASURED
   *  from the cells rather than guessed from the source. */
  dataContract?: boolean;
  /** Serve `--expose` over PLAIN HTTP (no TLS). Only sound when the payload is
   *  already end-to-end encrypted or a TLS-terminating proxy sits in front —
   *  boot warns loudly either way. CLI-only on purpose: "ship this app without
   *  transport encryption" is an operator's decision at run time, not an
   *  author's default baked into a binary. */
  noTls?: boolean;
  help?: boolean;
  serverUrl?: string;
  width?: number;
  height?: number;
  cert?: string;
  key?: string;
  isolate?: string[];
  /** `--transport=auto` is the same word config accepts (`ENUM_VALUES.
   *  transport`) — one vocabulary, so the flag refuses nothing the key
   *  takes. `resolveTransport` (aio-server.ts) is the one decider for what
   *  `auto` means. */
  transport?: "uds" | "ws" | "auto";
  /** `--open`: after boot, hand the app's URL to the desktop's browser.
   *
   *  OFF by default, and that is the whole point. A tab handed to an
   *  already-running browser is the one window aio cannot take back: the app
   *  exits and the tab stays. Booting an app twenty times therefore left twenty
   *  tabs, each having stolen focus as it appeared. Printing the URL costs a
   *  click and loses nothing. */
  open?: boolean;
  /** `--takeover`: kill the running instance and take its lock. Spelled
   *  `killExisting` on both surfaces until alpha76 — one decision needs one
   *  word, and a compiled service binary that can only write config was
   *  forced to write the deprecated one. */
  takeover?: boolean;
  /** Explicit bind address for the HTTP/WS listener — overrides the
   *  expose-derived default (0.0.0.0 exposed, 127.0.0.1 not). */
  host?: string;
  dbPath?: string;
  backupLogs?: boolean;
  /** Byte ceiling for the log directory (`--log-budget=200MB`). */
  logBudget?: number;
  /** Skip the legacy→`~/.<appId>` data move (app-dirs-migrate.ts). */
  noDataMigrate?: boolean;
  /** `--cdp` / `--cdp=<port>`: open Chrome DevTools Protocol on the Electron
   *  window (loopback only). `true` = pick a free port. OPT-IN: an app that
   *  did not ask binds nothing, so "zero ports" stays literally true. */
  cdp?: number | true;
};

// The four accepted aliases (`--kill-existing`, bare `--server-url`,
// `--zero-port`, `--backup-logs`) were "kept so existing scripts don't break",
// which is only half a deprecation: a script keeps working AND never learns
// there is a current spelling, so the old one outlives every release that was
// supposed to retire it. Two of them warned; two said nothing at all, and
// `--zero-port`'s entire documented behaviour was "No-op (accepted)".
//
// Beta freezes the surface, so alpha76 retires all four through the registry
// (src/state/removals.ts): the flag is REFUSED, and the refusal names the
// current spelling and the `am pin` escape hatch. A flag is refused, never
// degraded — argv is read before anything boots, so there is no half-started
// app to protect, and an operator who typed the old word at 2am needs the new
// one, not a warning that scrolls past.
function refuseFlag(key: string): never {
  const r = removalOf(key);
  throw teachableError(
    removalMessage(r),
    r.now ? `spell it \`${r.now}\`` : r.hint,
  );
}

// …and so does every other warning this function emits, for the same reason.
// Guarding them one at a time was the old approach and it missed
// `unknown flag ignored:`, which duly printed 5-7 times in a single boot — a
// repeated diagnostic reads as a loop, and a reader who has learned to scroll
// past repetition is a reader who will scroll past the next one too.
//
// The root cause is not the warning, it is that the same immutable input is
// parsed ten times per boot. So the DEFAULT invocation (the boot path, the
// only one that repeats) is memoized: one parse per process, every side effect
// exactly once. Identity on `Deno.args` is the key — it is stable within a
// process, and an explicit array (every test) never hits the cache, so tests
// keep parsing fresh and cannot leak a cached answer into each other.
let _parsedDefault: CliFlags | null = null;

/** Flags the APP declared as its own (`aio.run({ appFlags })`), as they are
 *  spelled on the command line. */
let _appFlags: string[] = [];

/** Declare the flags this app answers itself, so aio passes them through
 *  instead of refusing them as unknown.
 *
 *  The refusal is right and stays: `--experse` used to warn and boot, with the
 *  app bound to 127.0.0.1 while its author believed it was on the LAN. What it
 *  lacked was a way for an app with its OWN verbs to take part. The escape the
 *  error offers — "put an app's own arguments after a bare `--`" — cannot work
 *  for a compiled binary that bakes arguments into its argv: the baked ones
 *  come first and the operator's come last, so no position satisfies both. A
 *  field report deleted its two words out of `Deno.args` with
 *  `Object.defineProperty` before calling `aio.run()`, which works only
 *  because that descriptor happens to be configurable.
 *
 *  Declared flags get the same treatment as aio's own: passed through, and
 *  offered as a did-you-mean for a typo. Spelled `--name` (a switch) or
 *  `--name=` (takes a value), exactly like `AIO_RUNTIME_FLAG_SPECS`.
 *
 *  @internal — the app-facing spelling is `aio.run({ appFlags: [...] })`. */
export function declareAppFlags(names: readonly string[] | undefined): void {
  const next: string[] = [];
  for (const raw of names ?? []) {
    const name = raw.trim();
    if (!name.startsWith("--") || name.length < 3) {
      throw teachableError(
        `appFlags: ${JSON.stringify(raw)} is not a flag`,
        `write it exactly as it is typed: "--sync" for a switch, "--user=" ` +
          `for one that takes a value.`,
      );
    }
    if (AIO_RUNTIME_FLAGS.has(name.endsWith("=") ? name.slice(0, -1) : name)) {
      throw teachableError(
        `appFlags: ${name} is one of aio's own flags`,
        `pick another name — a flag cannot mean two things in one process, ` +
          `and the app would silently lose whichever meaning aio applied ` +
          `first. Run with --help for the full list.`,
      );
    }
    next.push(name);
  }
  _appFlags = next;
  // A declaration made after something already parsed must still take effect:
  // the memo holds an answer computed under the old vocabulary.
  _parsedDefault = null;
}

/** Test seam: forget the memoized default parse. @internal */
export function _resetParsedCli(): void {
  _parsedDefault = null;
  _appFlags = [];
  _cdpPort = undefined;
}

/** `--cdp` / `AIO_CDP` as one value: a port, `true` (pick one), or nothing.
 *  Pure — the flag beats the env, and an unparsable value is reported and
 *  treated as absent (never a silent default port). */
export function parseCdp(
  flag: number | true | undefined,
  env: string | undefined,
): number | true | undefined {
  if (flag !== undefined) return flag;
  if (env === undefined || env === "" || env === "0") return undefined;
  if (env === "1" || env === "true") return true;
  const n = Number(env);
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  log.warn(`invalid AIO_CDP value: ${env} (1, or a port 1-65535) — ignored`);
  return undefined;
}

let _cdpPort: number | undefined | null;

/** THE CDP port for this process — undefined unless asked for (`--cdp`,
 *  `AIO_CDP`). Decided once: the lock records it, the boot line prints it and
 *  the Electron launch binds it, and the three must agree. */
export function cdpPort(): number | undefined {
  if (_cdpPort !== undefined) return _cdpPort ?? undefined;
  const want = parseCdp(parseCli().cdp, Deno.env.get("AIO_CDP"));
  _cdpPort = want === undefined ? null : want === true ? findFreePort() : want;
  return _cdpPort ?? undefined;
}

/** Parses CLI flags from Deno.args (or custom array for testing) */
export function parseCli(args: readonly string[] = Deno.args): CliFlags {
  const isDefault = args === Deno.args;
  // A COPY: the cache must not become a shared mutable object that one caller's
  // edit silently republishes to the next.
  if (isDefault && _parsedDefault) return { ..._parsedDefault };
  const parsed = _parseCliUncached(args);
  if (isDefault) _parsedDefault = { ...parsed };
  return parsed;
}

/** A flag whose VALUE is unusable — named, with the accepted form.
 *
 *  Every one of these used to `log.warn` and carry on with the default, so
 *  `--port=abc` booted on a random port and `--client=Electron` booted an
 *  Electron app while the author was debugging why `browser` did nothing.
 *  A flag is an instruction; an instruction that cannot be carried out is a
 *  refusal, not a suggestion. */
function badValue(
  flag: string,
  got: string,
  accepted: string,
  near?: string | null,
): Error {
  return teachableError(
    `${flag}=${got === "" ? "(empty)" : got} is not a value ${flag} accepts`,
    near
      ? `did you mean ${flag}=${near}? Expected ${accepted}.`
      : `pass ${accepted}`,
  );
}

/** A whole number spelled in decimal digits, or NaN.
 *
 *  `--port=0x1F90`, `--port= 3000`, `--port=3000.0` and `--port=+3000` all
 *  coerced to a port under `Number()` — four spellings nobody types on
 *  purpose, each accepted without a word. A port or a pixel count is decimal
 *  digits and nothing else; anything else is a value the operator did not
 *  mean, and the same `badValue` names it. */
function intArg(raw: string): number {
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

function _parseCliUncached(args: readonly string[]): CliFlags {
  const r: CliFlags = { verbose: false };
  // aio's own flags plus whatever the app declared — one vocabulary, so a
  // typo in an app flag gets the same did-you-mean as a typo in aio's.
  const known = [...AIO_RUNTIME_FLAG_SPECS, ..._appFlags];
  for (const arg of args) {
    if (arg === "--") break; // everything after `--` belongs to the app
    // ONE rule for an empty value. `--host=` was refused while `--title=`,
    // `--db-path=` and `--port=` (`Number("")` is 0 — "pick a port") slid
    // through as their defaults. A flag typed with `=` and nothing after it
    // is a shell expansion that came up empty (`--port=$PORT`), and the
    // operator needs to hear that, not boot on a value they did not choose.
    // Checked against the value-flag vocabulary, so an app's own `--user=`
    // gets the same refusal as aio's.
    // …with one exception, and it earns it: `--server-url=` typed with nothing
    // after it is almost always someone reaching for the BARE spelling, which
    // was retired in alpha76 in favour of `--connect`. Its own branch below
    // says that; this generic answer would bury it under "pass a value".
    if (
      arg.endsWith("=") && known.includes(arg) && arg !== "--server-url="
    ) {
      throw badValue(
        arg.slice(0, -1),
        "",
        `a value: ${arg}<value> (run with --help for what it accepts)`,
      );
    }
    if (arg.startsWith("--port=")) {
      const n = intArg(arg.slice(7));
      // `--port=0` is the universal spelling for "let the OS pick one", and it
      // is what aio does by default — so it is ACCEPTED and leaves `port`
      // unset, not refused. Scripts and tests pass it deliberately; refusing it
      // would make strictness a regression rather than a fix. Anything that is
      // neither a usable port nor 0 is a value the operator meant and cannot
      // have.
      if (n === 0) {
        /* pick a free port — already the default */
      } else if (Number.isInteger(n) && n > 0 && n < 65536) r.port = n;
      else {
        throw badValue(
          "--port",
          arg.slice(7),
          "a port 1-65535, or 0 to let the runtime pick a free one",
        );
      }
    } else if (arg === "--no-persist") r.persist = false;
    else if (arg.startsWith("--client=")) {
      const v = arg.slice(9);
      if (
        v === "electron" || v === "browser" || v === "cli" ||
        v === "server-only"
      ) r.client = v;
      else {
        throw badValue(
          "--client",
          v,
          "one of electron, browser, cli, server-only",
          nearestOf(v, ["electron", "browser", "cli", "server-only"]),
        );
      }
    } else if (arg === "--keep-server") r.keepServer = true;
    else if (arg.startsWith("--title=")) r.title = arg.slice(8);
    else if (arg === "--verbose") r.verbose = true;
    else if (arg === "--prod") r.prod = true;
    else if (arg === "--version") r.version = true;
    else if (arg === "--expose") r.expose = true;
    else if (arg.startsWith("--channel=")) r.channel = arg.slice(10);
    else if (arg === "--aio-data-contract") r.dataContract = true;
    else if (arg === "--no-tls") r.noTls = true;
    else if (arg === "--help") r.help = true;
    // `--connect` opens the connect page (a thin client with no baked-in
    // server). It was spelled bare `--server-url` before alpha52 — a flag that
    // reads like it needs a value and does something else without one. The
    // VALUED form `--server-url=X` keeps its name (it really is a server URL).
    else if (arg === "--connect") r.serverUrl = "";
    else if (arg === "--server-url") refuseFlag("--server-url");
    else if (arg.startsWith("--server-url=")) {
      // Empty means "the connect page", and that has a spelling: --connect.
      // `--server-url=$URL` with an unset URL should not quietly become it.
      if (arg.length === 13) {
        throw badValue(
          "--server-url",
          "",
          "a server URL, e.g. --server-url=https://192.168.1.20:8443 — or " +
            "--connect for the connect page",
        );
      }
      r.serverUrl = arg.slice(13);
    } else if (arg === "--takeover") r.takeover = true;
    else if (arg === "--kill-existing") refuseFlag("--kill-existing");
    else if (arg.startsWith("--db-path=")) r.dbPath = arg.slice(10);
    // Keeping previous logs is the DEFAULT; `--no-backup-logs` is the one that
    // changes anything (wipe on start). `--backup-logs` said so and did
    // nothing — retired in alpha76.
    else if (arg === "--backup-logs") refuseFlag("--backup-logs");
    else if (arg === "--no-backup-logs") r.backupLogs = false;
    else if (arg.startsWith("--log-budget=")) {
      // Bytes, or a `<n>MB`/`<n>GB` suffix — a bare number in a flag about disk
      // is ambiguous enough that both spellings have to work.
      const raw = arg.slice(13).trim();
      const m = raw.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
      if (m) {
        const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[
          (m[2] ?? "b").toLowerCase() as "b" | "kb" | "mb" | "gb"
        ];
        r.logBudget = Math.floor(Number(m[1]) * mult);
      } else {
        throw badValue(
          "--log-budget",
          raw,
          "a byte count, or a number with a B/KB/MB/GB suffix, e.g. --log-budget=200MB",
        );
      }
    } // Opt out of the one-time move to ~/.<appId> (app-dirs-migrate.ts).
    else if (arg === "--no-data-migrate") r.noDataMigrate = true;
    // TLS cert/key. `--tls-cert`/`--tls-key` are canonical (the bare
    // `--cert`/`--key` collided with the auth `key` config concept); the old
    // names stay as deprecated aliases so existing deploy scripts don't break.
    else if (arg.startsWith("--tls-cert=")) r.cert = arg.slice(11);
    else if (arg.startsWith("--tls-key=")) r.key = arg.slice(10);
    else if (arg.startsWith("--cert=")) r.cert = arg.slice(7);
    else if (arg.startsWith("--key=")) r.key = arg.slice(6);
    else if (arg.startsWith("--width=")) {
      // `--width=1200px` used to match no branch at all: no assignment, no
      // warning, and an 800px window. A unit suffix is the obvious thing to
      // type, so it is the obvious thing to refuse BY NAME.
      const n = intArg(arg.slice(8));
      if (Number.isInteger(n) && n > 0) r.width = n;
      else {
        throw badValue(
          "--width",
          arg.slice(8),
          "a whole number of pixels, e.g. --width=1200",
        );
      }
    } else if (arg.startsWith("--height=")) {
      const n = intArg(arg.slice(9));
      if (Number.isInteger(n) && n > 0) r.height = n;
      else {
        throw badValue(
          "--height",
          arg.slice(9),
          "a whole number of pixels, e.g. --height=800",
        );
      }
    } else if (arg.startsWith("--isolate=")) {
      const names = arg.slice(10).split(",").map((s) => s.trim()).filter(
        Boolean,
      );
      // `--isolate=,` (or `, ,`) named nothing after the commas were removed,
      // and an empty list means "no isolate at all" downstream — the app would
      // run EVERY cell for a flag whose whole purpose is to run fewer. The
      // same refusal an empty value gets.
      if (names.length === 0) {
        throw badValue(
          "--isolate",
          arg.slice(10),
          "one or more cell ids: --isolate=todo,notes",
        );
      }
      r.isolate = names;
    } else if (arg === "--zero-port") refuseFlag("--zero-port");
    else if (arg === "--open") {
      r.open = true;
    } else if (arg.startsWith("--transport=")) {
      const v = arg.slice(12);
      if (v === "uds" || v === "ws" || v === "auto") r.transport = v;
      else {
        throw badValue(
          "--transport",
          v,
          "'uds' (the local socket), 'ws', or 'auto' (the default: uds for a " +
            "local electron app)",
          nearestOf(v, ["uds", "ws", "auto"]),
        );
      }
    } else if (arg === "--cdp") r.cdp = true;
    else if (arg.startsWith("--cdp=")) {
      const n = intArg(arg.slice(6));
      if (Number.isInteger(n) && n > 0 && n < 65536) r.cdp = n;
      else {throw badValue(
          "--cdp",
          arg.slice(6),
          "a port 1-65535, or bare --cdp to pick a free one",
        );}
    } else if (arg.startsWith("--host=")) {
      // An address, not an authority — the port has its own flag. Deeper
      // validation belongs to the bind itself: Deno.serve refuses a bad
      // hostname loudly, which beats a regex that has to know every IPv6
      // spelling.
      const v = arg.slice(7).trim();
      if (v !== "") r.host = v;
      else {throw badValue(
          "--host",
          "",
          "an IP or hostname, e.g. --host=192.168.1.20",
        );}
    } else if (
      arg.startsWith("--") &&
      !known.some((k) => k.endsWith("=") ? arg.startsWith(k) : arg === k)
    ) {
      // REFUSED, not ignored. `--experse` used to warn and boot: the app bound
      // 127.0.0.1 while its author believed it was on the LAN, and the one
      // line saying so scrolled past among the boot banner. `cell()` has
      // refused an unknown key with a did-you-mean since alpha52; a flag is
      // the same mistake with higher stakes, because a flag is what an
      // operator types at 2am.
      const name = arg.split("=")[0]!;
      // A BUILD flag typed at a running app is not a typo, it is a category
      // error — and answering it with "did you mean --client=?" sends the
      // reader hunting for a misspelling that is not there. The vocabulary is
      // imported, never retyped, so the two lists cannot drift.
      const buildOnly = _buildFlagAdvice(name);
      if (buildOnly) throw teachableError(`unknown flag: ${arg}`, buildOnly);
      const near = nearestOf(
        name,
        known.map((k) => k.endsWith("=") ? k.slice(0, -1) : k),
      );
      throw teachableError(
        `unknown flag: ${arg}`,
        near
          ? `did you mean ${near}${
            known.includes(near + "=") ? "=<value>" : ""
          }? Run with --help for every flag. If this is your app's own flag, declare it: aio.run({ appFlags: ["${
            arg.split("=")[0]
          }"] }) — or put app arguments after a bare \`--\`.`
          : `run with --help for every flag aio accepts. If this is your app's own flag, declare it: aio.run({ appFlags: ["${
            arg.split("=")[0]
          }"] }) — or put app arguments after a bare \`--\`, where aio stops parsing (a compiled binary that bakes arguments into its argv cannot use \`--\`; declare them).`,
      );
    }
  }
  return r;
}

/** Is this flag part of the BUILD's vocabulary rather than the runtime's? If
 *  so, say that — and name the runtime spelling where one exists.
 *
 *  `--headless` and `--no-electron` are the two people actually type at a
 *  binary: both are build-time decisions baked into the artifact, and the
 *  runtime spelling for "server, no UI" is `--client=server-only`. The old
 *  refusal was correct and read like a misspelling, which costs the reader the
 *  minute it takes to go looking for one. The same near-miss in the other
 *  direction (a runtime flag passed to the build) is already a red gate —
 *  `tests/build-flags.test.ts`. */
function _buildFlagAdvice(name: string): string | null {
  const RUNTIME_SPELLING: Record<string, string> = {
    "--headless": "--client=server-only",
    "--no-electron": "--client=browser",
    "--service": "--client=server-only",
    "--cli": "--client=cli",
    "--client": "--client=browser",
    "--electron": "--client=electron",
  };
  const isBuild = (BUILD_BOOL_FLAGS as readonly string[]).includes(name) ||
    (BUILD_VALUE_FLAGS as readonly string[]).includes(name) ||
    name === "--no-electron";
  if (!isBuild) return null;
  const runtime = RUNTIME_SPELLING[name];
  return `that is a BUILD flag (\`deno task build\`), not a runtime one — it ` +
    `is a decision baked into the artifact, so a built binary cannot be asked ` +
    `to change it now.` +
    (runtime
      ? ` The runtime spelling for what it selects is \`${runtime}\`.`
      : ` Pass it to the build instead.`);
}

/** Prints CLI usage. The usage line and the client default are the CALLER's
 *  facts: a compiled binary is invoked by its own name, not `deno run`, and
 *  the default client is whatever boot will actually pick (deno.json's target
 *  or the app's config) — a `--help` that said "default: electron" for a
 *  browser-target app was wrong on the one line people read. */
export function printHelp(
  opts: { usage?: string; defaultClient?: string } = {},
): void {
  const usage = opts.usage ?? "deno run -A src/app.ts [flags]";
  const defaultClient = opts.defaultClient ?? "electron";
  log.info(`aio ${VERSION} — all-in-one framework

Usage: ${usage}

Flags:
  --port=N         Server port (default: a free one, or $AIO_PORT). Naming a
                   port is ALSO the opt-out from zero TCP ports: a local
                   electron app binds no port unless one is named here
                   (or via $AIO_PORT / aio.run({ port }))
  --no-persist     Disable persistence (SQLite <data>/state.db)
  --client=X       Client mode: electron|browser|cli|server-only (default: ${defaultClient})
  --keep-server    Server survives Electron close (electron only — refused
                   for any other client, as are --cdp, --width, --height,
                   --connect and --server-url=)
  --title=X        Override window/page title
  --verbose        Verbose logging (actions, state, effects, WS, HTTP)
  --prod           Serve pre-built dist/app.js
  --expose         Bind 0.0.0.0 + HTTPS + generate auth token for LAN access
                   (also settable in code: aio.run({ expose: true }))
  --channel=X      Follow release channel X for updates (dev|test|prod|…)
  --host=ADDR      Bind ONE address instead of the expose default (0.0.0.0
                   exposed, 127.0.0.1 not) — e.g. --host=192.168.1.20 serves
                   only that interface (also: aio.run({ host: "…" }))
  --no-tls         With --expose: serve PLAIN HTTP/WS — everything on the wire
                   is readable by the LAN. Only for already-encrypted payloads
                   or behind a TLS-terminating proxy
  --tls-cert=PATH  TLS certificate file (PEM) — used with --expose (auto-generated if omitted)
  --tls-key=PATH   TLS private key file (PEM) — used with --expose (auto-generated if omitted)
                   (--cert / --key are accepted as deprecated aliases)
  --connect        Open the Electron thin-client connect page (enter any server
                   URL)
  --server-url=X   Connect to a specific remote aio server (Electron thin client)
  --takeover       Kill running instance and take over
  --db-path=PATH   Override the SQLite file (":memory:" for throwaway runs)
  --no-backup-logs Wipe the log directory on start instead of rotating
                   (keeping previous logs — rotate to .1, .2, … — is the default)
  --log-budget=N   Byte ceiling for the log directory (e.g. 200MB, 0 = unlimited)
  --no-data-migrate Skip moving a legacy data layout into ~/.<appId>
  --width=N        Initial window width (default: 800)
  --height=N       Initial window height (default: 600)
  --transport=X    Transport: 'uds' (the local socket — a Unix socket, a named
                   pipe on Windows), 'ws', or 'auto' (the default — uds for a
                   local electron app)
  --open           Open the app in your browser after boot (default: OFF — the
                   URL is printed; a tab aio opens is one it cannot close)
  --isolate=a,b    Only activate the specified cells
  --cdp[=N]        Open Chrome DevTools Protocol on the Electron window, on
                   127.0.0.1 only (a free port unless N is given; also
                   $AIO_CDP=1|N). Opt-in: enables "am shot" (screenshots)
  --version        Print version and exit
  --help           Show this help

An unknown "--flag" or an unusable value is REFUSED, not ignored — "--experse"
used to bind loopback while its author believed the app was on the LAN.
A single-dash flag ("-h", "-p 9") or a bare word ("serve") is NOT aio's: it
passes through to the app untouched (args() from aio/cli reads it), so a
short spelling of an aio flag does nothing — write --help, --port=9.
Everything after a bare "--" is left for the app to parse: aio stops there.`);
}

/** The boot report's `cli:` line — what THIS process was actually started
 *  with, as aio saw it. Pure.
 *
 *  It used to filter `Deno.args` for `--`-prefixed words, which told two lies
 *  at once: a bare word or a short flag (`serve`, `-v`) vanished from the
 *  line although it was on the command line, and an app's own arguments
 *  after a bare `--` were listed as though aio had parsed them. The line now
 *  prints aio's prefix verbatim and, when a `--` is present, the `--` and
 *  what followed it — so the reader can see where aio stopped. */
export function cliLine(args: readonly string[]): string {
  const stop = args.indexOf("--");
  const own = stop === -1 ? args : args.slice(0, stop);
  const rest = stop === -1 ? [] : args.slice(stop);
  return [...own, ...rest].join(" ");
}

/** Refuse a flag that only an Electron client can honour, when the client is
 *  anything else. Pure; `null` means nothing to refuse.
 *
 *  ONE decider, in the SAME sentence shape, for the whole family. Before:
 *  `--keep-server` on a browser client was refused — but from inside
 *  `startLifecycle`, AFTER the success banner, as an unhandled rejection that
 *  named the config key `keepServer` even when the operator had typed the
 *  flag. `--connect` / `--server-url=` on `--client=browser` silently
 *  overrode the client and started a ~100 MB Electron download. `--cdp` on a
 *  browser app printed a `cdp` line for a port nothing would ever listen on.
 *  `--width`/`--height` outside Electron assigned a window size no window
 *  would read. Same mistake, four outcomes. Now: refused before anything
 *  boots, naming what was typed (the flag when it was the flag, the config
 *  key when it was the key) and the one client it applies to.
 *
 *  `serverUrl` as a config key beside `client: "browser"` is already a
 *  `configConflicts` error; this catches the flag, and a client that came
 *  from deno.json rather than config. */
export function electronOnlyFlagRefusal(
  cli: Pick<
    CliFlags,
    "serverUrl" | "keepServer" | "cdp" | "width" | "height"
  >,
  client: string,
  config: { serverUrl?: string; keepServer?: boolean } = {},
): Error | null {
  if (client === "electron") return null;
  /** [what was typed, how to undo it] — first match wins. */
  const asked: [string, string][] = [];
  if (cli.serverUrl !== undefined) {
    asked.push([
      cli.serverUrl === "" ? "--connect" : "--server-url=<url>",
      "drop it",
    ]);
  } else if (config.serverUrl !== undefined) {
    asked.push(["serverUrl (aio.run())", "remove serverUrl from aio.run()"]);
  }
  if (cli.keepServer) asked.push(["--keep-server", "drop it"]);
  else if (config.keepServer) {
    asked.push(["keepServer: true (aio.run())", "remove keepServer"]);
  }
  if (cli.cdp !== undefined) asked.push(["--cdp", "drop it"]);
  if (cli.width !== undefined) asked.push(["--width", "drop it"]);
  if (cli.height !== undefined) asked.push(["--height", "drop it"]);
  const first = asked[0];
  if (!first) return null;
  const [what, undo] = first;
  return teachableError(
    `${what} only applies when client is electron (current client: "${client}")`,
    `${undo}, or run with --client=electron. ` +
      (what.startsWith("--width") || what.startsWith("--height")
        ? `A browser page takes its size from aio.run({ ui: { width, height } }).`
        : `A ${client} client has no Electron window for it to act on.`),
  );
}
