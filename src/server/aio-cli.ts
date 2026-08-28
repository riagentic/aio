import { AIO_RUNTIME_FLAG_SPECS } from "../diagnostics/runtime-flags.ts";
// CLI parsing — pure functions, no aio.ts internal dependencies
import { log } from "../diagnostics/logger-api.ts";
import { teachableError } from "../diagnostics/error.ts";
import { nearestOf } from "../state/cell-helpers.ts";
import { findFreePort } from "./paths.ts";

/** Framework version — printed by --version, checked in tests */
export const VERSION = "1.0.0-alpha71";

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
  transport?: "uds" | "ws";
  /** `--zero-port`: accepted as a NO-OP. Zero TCP ports is the default for a
   *  local electron app on a Unix socket (dev and prod); the flag was the
   *  dev opt-in before that and scripts still pass it, so it prints one info
   *  line and changes nothing. The opt-OUT is a named port (`--port=N`). */
  zeroPort?: boolean;
  /** `--open`: after boot, hand the app's URL to the desktop's browser.
   *
   *  OFF by default, and that is the whole point. A tab handed to an
   *  already-running browser is the one window aio cannot take back: the app
   *  exits and the tab stays. Booting an app twenty times therefore left twenty
   *  tabs, each having stolen focus as it appeared. Printing the URL costs a
   *  click and loses nothing. */
  open?: boolean;
  killExisting?: boolean;
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

// Deprecation hints fire ONCE per process — parseCli is re-invoked several
// times in one boot, and the same line five times reads as an error loop.
let _hintedBareServerUrl = false;

// The other accepted aliases warned about NOTHING. `--kill-existing` and
// `--backup-logs` were documented as "kept so existing scripts don't break",
// which is only half a deprecation: a script keeps working AND never learns
// there is a current spelling, so the old one outlives every release that was
// supposed to retire it. `--server-url` already had this hint; these are the
// same rule, on the same one-per-process guard.
const _hintedAliases = new Set<string>();
function hintAlias(spelling: string, msg: string): void {
  if (_hintedAliases.has(spelling)) return;
  _hintedAliases.add(spelling);
  log.warn(msg);
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

/** Test seam: forget the memoized default parse. @internal */
export function _resetParsedCli(): void {
  _parsedDefault = null;
  _hintedBareServerUrl = false;
  _hintedAliases.clear();
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

function _parseCliUncached(args: readonly string[]): CliFlags {
  const r: CliFlags = { verbose: false };
  const known = [...AIO_RUNTIME_FLAG_SPECS];
  for (const arg of args) {
    if (arg === "--") break; // everything after `--` belongs to the app
    if (arg.startsWith("--port=")) {
      const n = Number(arg.slice(7));
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
    else if (arg === "--server-url") {
      // One-time: parseCli runs several times in one boot (help, boot,
      // electron child probes) and the hint printed once per parse.
      if (!_hintedBareServerUrl) {
        _hintedBareServerUrl = true;
        log.warn(
          "bare --server-url is now --connect (the old spelling still works; " +
            "--server-url=<url> is unchanged)",
        );
      }
      r.serverUrl = "";
    } else if (arg.startsWith("--server-url=")) r.serverUrl = arg.slice(13);
    // `--takeover` is the preferred spelling; `--kill-existing` stays as the
    // accepted alias so existing scripts don't break.
    else if (arg === "--kill-existing" || arg === "--takeover") {
      if (arg === "--kill-existing") {
        hintAlias(
          arg,
          "--kill-existing is now --takeover (the old spelling still works)",
        );
      }
      r.killExisting = true;
    } else if (arg.startsWith("--db-path=")) r.dbPath = arg.slice(10);
    // `--backup-logs` is now the DEFAULT, kept so existing scripts still parse;
    // `--no-backup-logs` is the one that changes anything (wipe on start).
    else if (arg === "--backup-logs") {
      hintAlias(
        arg,
        "--backup-logs is the DEFAULT now and does nothing (the flag still " +
          "parses); --no-backup-logs is the one that changes anything",
      );
      r.backupLogs = true;
    } else if (arg === "--no-backup-logs") r.backupLogs = false;
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
      const n = Number(arg.slice(8));
      if (Number.isInteger(n) && n > 0) r.width = n;
      else {
        throw badValue(
          "--width",
          arg.slice(8),
          "a whole number of pixels, e.g. --width=1200",
        );
      }
    } else if (arg.startsWith("--height=")) {
      const n = Number(arg.slice(9));
      if (Number.isInteger(n) && n > 0) r.height = n;
      else {
        throw badValue(
          "--height",
          arg.slice(9),
          "a whole number of pixels, e.g. --height=800",
        );
      }
    } else if (arg.startsWith("--isolate=")) {
      r.isolate = arg.slice(10).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--zero-port") {
      r.zeroPort = true;
    } else if (arg === "--open") {
      r.open = true;
    } else if (arg.startsWith("--transport=")) {
      const v = arg.slice(12);
      if (v === "uds" || v === "ws") r.transport = v;
      else {
        throw badValue(
          "--transport",
          v,
          "'uds' (the local socket) or 'ws'",
          nearestOf(v, ["uds", "ws"]),
        );
      }
    } else if (arg === "--cdp") r.cdp = true;
    else if (arg.startsWith("--cdp=")) {
      const n = Number(arg.slice(6));
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
      const near = nearestOf(
        name,
        known.map((k) => k.endsWith("=") ? k.slice(0, -1) : k),
      );
      throw teachableError(
        `unknown flag: ${arg}`,
        near
          ? `did you mean ${near}${
            known.includes(near + "=") ? "=<value>" : ""
          }? Run with --help for every flag; put an app's own arguments after a bare \`--\`.`
          : `run with --help for every flag aio accepts; put an app's own arguments after a bare \`--\`, where aio stops parsing.`,
      );
    }
  }
  return r;
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
  --keep-server    Server survives Electron close (electron only)
  --title=X        Override window/page title
  --verbose        Verbose logging (actions, state, effects, WS, HTTP)
  --prod           Serve pre-built dist/app.js
  --expose         Bind 0.0.0.0 + HTTPS + generate auth token for LAN access
  --channel=X      Follow release channel X for updates (dev|test|prod|…)
                   (also settable in code: aio.run({ expose: true }))
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
                   URL; bare --server-url is the deprecated alias)
  --server-url=X   Connect to a specific remote aio server (Electron thin client)
  --takeover       Kill running instance and take over
                   (--kill-existing is the deprecated alias)
  --db-path=PATH   Override the SQLite file (":memory:" for throwaway runs)
  --backup-logs    Keep previous logs on restart (the default — rotate to .1, .2, …)
  --no-backup-logs Wipe the log directory on start instead of rotating
  --log-budget=N   Byte ceiling for the log directory (e.g. 200MB, 0 = unlimited)
  --no-data-migrate Skip moving a legacy data layout into ~/.<appId>
  --width=N        Initial window width (default: 800)
  --height=N       Initial window height (default: 600)
  --transport=X    Transport: 'uds' (the local socket — a Unix socket, a named
                   pipe on Windows) or 'ws' (default: auto — uds for a local electron app)
  --zero-port      No-op (accepted): zero TCP ports is already the default for
                   a local electron app — page, modules and routes go over the
                   socket (a named pipe on Windows)
  --open           Open the app in your browser after boot (default: OFF — the
                   URL is printed; a tab aio opens is one it cannot close)
  --isolate=a,b    Only activate the specified cells
  --cdp[=N]        Open Chrome DevTools Protocol on the Electron window, on
                   127.0.0.1 only (a free port unless N is given; also
                   $AIO_CDP=1|N). Opt-in: enables "am shot" (screenshots)
  --version        Print version and exit
  --help           Show this help

An unknown flag or an unusable value is REFUSED, not ignored — "--experse"
used to bind loopback while its author believed the app was on the LAN.
Everything after a bare "--" is left for the app to parse: aio stops there.`);
}
