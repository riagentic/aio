// CLI parsing — pure functions, no aio.ts internal dependencies
import { log } from "../diagnostics/logger-api.ts";

/** Framework version — printed by --version, checked in tests */
export const VERSION = "1.0.0-alpha60";

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
};

// Deprecation hints fire ONCE per process — parseCli is re-invoked several
// times in one boot, and the same line five times reads as an error loop.
let _hintedBareServerUrl = false;

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

function _parseCliUncached(args: readonly string[]): CliFlags {
  const r: CliFlags = { verbose: false };
  const known = [
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
    "--server-url",
    "--connect",
    "--width=",
    "--height=",
    "--tls-cert=",
    "--tls-key=",
    "--cert=",
    "--key=",
    "--isolate=",
    "--transport=",
    "--kill-existing",
    "--takeover",
    "--backup-logs",
    "--no-backup-logs",
    "--log-budget=",
    "--db-path=",
    "--host=",
  ];
  for (const arg of args) {
    if (arg.startsWith("--port=")) {
      const n = Number(arg.slice(7));
      if (Number.isInteger(n) && n > 0 && n < 65536) r.port = n;
      else log.warn(`invalid --port value: ${arg.slice(7)} (must be 1-65535)`);
    } else if (arg === "--no-persist") r.persist = false;
    else if (arg.startsWith("--client=")) {
      const v = arg.slice(9);
      if (
        v === "electron" || v === "browser" || v === "cli" ||
        v === "server-only"
      ) r.client = v;
      else {log.warn(
          `invalid --client value: ${v} (must be electron|browser|cli|server-only)`,
        );}
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
      r.killExisting = true;
    } else if (arg.startsWith("--db-path=")) r.dbPath = arg.slice(10);
    // `--backup-logs` is now the DEFAULT, kept so existing scripts still parse;
    // `--no-backup-logs` is the one that changes anything (wipe on start).
    else if (arg === "--backup-logs") r.backupLogs = true;
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
        log.warn(
          `[aio] ignoring --log-budget=${raw} — expected bytes or e.g. 200MB`,
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
      const n = Number(arg.slice(8));
      if (Number.isInteger(n) && n > 0) r.width = n;
    } else if (arg.startsWith("--height=")) {
      const n = Number(arg.slice(9));
      if (Number.isInteger(n) && n > 0) r.height = n;
    } else if (arg.startsWith("--isolate=")) {
      r.isolate = arg.slice(10).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--transport=")) {
      const v = arg.slice(12);
      if (v === "uds" || v === "ws") r.transport = v;
      else log.warn(`invalid --transport value: ${v} (must be 'uds' or 'ws')`);
    } else if (arg.startsWith("--host=")) {
      // An address, not an authority — the port has its own flag. Deeper
      // validation belongs to the bind itself: Deno.serve refuses a bad
      // hostname loudly, which beats a regex that has to know every IPv6
      // spelling.
      const v = arg.slice(7).trim();
      if (v !== "") r.host = v;
      else log.warn("invalid --host value: empty (an IP or hostname)");
    } else if (
      arg.startsWith("--") &&
      !known.some((k) => k.endsWith("=") ? arg.startsWith(k) : arg === k)
    ) {
      log.warn(`unknown flag ignored: ${arg} — run with --help for usage`);
    }
  }
  return r;
}

/** Prints CLI usage and exits */
export function printHelp(): void {
  log.info(`aio ${VERSION} — all-in-one framework

Usage: deno run -A src/app.ts [flags]

Flags:
  --port=N         Server port (default: 8000)
  --no-persist     Disable persistence (SQLite <data>/state.db)
  --client=X       Client mode: electron|browser|cli|server-only (default: electron)
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
  --transport=X    Transport: 'uds' or 'ws' (default: auto — UDS for electron on linux/mac)
  --isolate=a,b    Only activate the specified cells
  --version        Print version and exit
  --help           Show this help`);
}
