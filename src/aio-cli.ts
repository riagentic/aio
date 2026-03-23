// CLI parsing — pure functions, no aio.ts internal dependencies
import { log } from "./logger.ts";

/** Framework version — printed by --version, checked in tests */
export const VERSION = "1.0.0-alpha2";

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
  help?: boolean;
  serverUrl?: string;
  width?: number;
  height?: number;
  cert?: string;
  key?: string;
  isolate?: string[];
  transport?: "uds" | "ws";
  killExisting?: boolean;
  backupLogs?: boolean;
};

/** Parses CLI flags from Deno.args (or custom array for testing) */
export function parseCli(args: readonly string[] = Deno.args): CliFlags {
  const r: CliFlags = { verbose: false };
  const known = [
    "--port=",
    "--no-persist",
    "--client=",
    "--keep-server",
    "--title=",
    "--verbose",
    "--prod",
    "--version",
    "--expose",
    "--help",
    "--server-url",
    "--width=",
    "--height=",
    "--cert=",
    "--key=",
    "--isolate=",
    "--transport=",
    "--kill-existing",
    "--backup-logs",
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
    else if (arg === "--help") r.help = true;
    else if (arg === "--server-url") r.serverUrl = "";
    else if (arg.startsWith("--server-url=")) r.serverUrl = arg.slice(13);
    else if (arg === "--kill-existing") r.killExisting = true;
    else if (arg === "--backup-logs") r.backupLogs = true;
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
  console.log(`aio ${VERSION} — all-in-one framework

Usage: deno run -A src/app.ts [flags]

Flags:
  --port=N         Server port (default: 8000)
  --no-persist     Disable Deno.Kv persistence
  --client=X       Client mode: electron|browser|cli|server-only (default: electron)
  --keep-server    Server survives Electron close (electron only)
  --title=X        Override window/page title
  --verbose        Verbose logging (actions, state, effects, WS, HTTP)
  --prod           Serve pre-built dist/app.js
  --expose         Bind 0.0.0.0 + HTTPS + generate auth token for LAN access
  --cert=PATH      TLS certificate file (PEM) — used with --expose (auto-generated if omitted)
  --key=PATH       TLS private key file (PEM) — used with --expose (auto-generated if omitted)
  --server-url[=X] Connect to remote aio server (Electron thin client)
  --kill-existing  Kill running instance and take over
  --backup-logs    Keep previous logs on restart (rotate to .1, .2, etc.)
  --width=N        Initial window width (default: 800)
  --height=N       Initial window height (default: 600)
  --transport=X    Transport: 'uds' or 'ws' (default: auto — UDS for electron on linux/mac)
  --isolate=a,b    Only activate specified features (v0.5)
  --version        Print version and exit
  --help           Show this help`);
}
