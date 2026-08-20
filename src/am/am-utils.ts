/**
 * @module
 * Utility functions for am — aio manager CLI.
 * Path resolution, payload parsing, entry/appId/port resolution.
 */

import { readDenoJsonSync } from "../server/deno-json.ts";
import { resolveEntryPath } from "../server/paths.ts";
import {
  instances,
  type LockData,
  readLock,
  removeLock,
  resolveAppId,
  writeLock,
} from "../server/single-instance-lock.ts";
import { join } from "@std/path";
import { appDirs } from "../server/app-dirs.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { trojanGet, trojanPost } from "./am-http.ts";

// ── Entry config cache ──────────────────────────────────────

/** Cached config extracted from entry file — appId + port from aio.run() call */
let _entryConfig: { appId?: string; port?: number } | null = null;

export function readEntryConfig(): { appId?: string; port?: number } {
  if (_entryConfig) return _entryConfig;
  _entryConfig = {};
  const entry = resolveEntry();
  if (!entry) return _entryConfig;
  try {
    const src = Deno.readTextFileSync(entry);
    // Match aio.run({ ... }) block — lazy [\s\S]*? handles multiline configs
    const block = src.match(/aio\.run\s*\(\s*\{([\s\S]*?)\}\s*\)/);
    if (block?.[1]) {
      const b = block[1];
      const appId = b.match(/appId\s*:\s*['"]([^'"]+)['"]/);
      if (appId?.[1]) _entryConfig.appId = appId[1];
      const port = b.match(/port\s*:\s*(\d+)/);
      if (port?.[1]) _entryConfig.port = parseInt(port[1], 10);
    }
  } catch { /* unreadable entry */ }
  return _entryConfig;
}

// ── Resolve helpers ─────────────────────────────────────────

export const DEFAULT_PORT = 8000;

/** Resolve the appId for am commands — --app flag > deno.json appId > app.ts aio.run().
 *  am runs in dev only (not compiled), so deno.json is always available. */
export function resolveAmAppId(flag?: string): string {
  if (flag) return resolveAppId(flag);
  try {
    const cfg = JSON.parse(
      Deno.readTextFileSync(join(Deno.cwd(), "deno.json")),
    ) as { appId?: string };
    if (cfg.appId) return resolveAppId(cfg.appId);
  } catch { /* no deno.json */ }
  const ec = readEntryConfig();
  if (ec.appId) return resolveAppId(ec.appId);
  // Zero-config apps (aio.run() with no appId) — mirror the server's
  // inference chain: deno.json title/name, then the project directory name.
  try {
    const cfg = JSON.parse(
      Deno.readTextFileSync(join(Deno.cwd(), "deno.json")),
    ) as { title?: string; name?: string };
    const fromCfg = cfg.title ?? cfg.name?.split("/").pop();
    if (fromCfg) return resolveAppId(fromCfg);
  } catch { /* no deno.json */ }
  const dir = Deno.cwd().split("/").filter(Boolean).pop();
  if (dir) return resolveAppId(dir);
  throw new Error(
    '[am] missing appId — pass --app=X, add "appId" to deno.json, or set appId in aio.run()',
  );
}

/** Resolve port for am commands — --port flag > deno.json port > app.ts aio.run() port > DEFAULT_PORT */
export function resolveAmPort(flag?: number): number {
  if (flag !== undefined) return flag; // AIO-212: don't ignore --port=0
  try {
    const cfg = JSON.parse(
      Deno.readTextFileSync(join(Deno.cwd(), "deno.json")),
    ) as { port?: number };
    if (cfg.port) return cfg.port;
  } catch { /* no deno.json */ }
  return readEntryConfig().port ?? DEFAULT_PORT;
}

/** Resolve entry point: --entry flag > deno.json "entry" > src/app.ts
 *  Convention: entry is src/app.ts. Override via deno.json "entry" if renamed. */
export function resolveEntry(flagEntry?: string): string | null {
  if (flagEntry) {
    try {
      Deno.statSync(flagEntry);
      return flagEntry;
    } catch {
      return null;
    }
  }
  // THE chain (server/paths.ts), not a fourth copy of it: an explicit `entry`,
  // else src/app.ts. It read the same way already — which is exactly how a
  // duplicate survives until the day one copy is updated and the others are not.
  let cfg: Record<string, unknown> | null = null;
  try {
    cfg = readDenoJsonSync(Deno.cwd())?.config ?? {};
  } catch { /* no deno.json — the default still applies */ }
  const entry = resolveEntryPath(cfg);
  try {
    Deno.statSync(entry);
    return entry;
  } catch {
    return null;
  }
}

// ── Lock file helpers (pid compat layer) ────────────────────

/** Read lock data for current app — replaces old readPid() */
export function readPid(appId?: string): LockData | null {
  const id = appId ?? resolveAmAppId();
  const lock = readLock(id);
  if (!lock) return null;
  // Backward compat: old lock files without status
  if (!lock.status) lock.status = "started";
  return lock;
}

/** Write lock data — replaces old writePid() */
export function writePid(pf: LockData): void {
  writeLock(pf);
}

/** Remove lock — replaces old removePid() */
export function removePid(appId?: string): void {
  removeLock(appId ?? resolveAmAppId());
}

/** Names already reported by {@linkcode resolvePort}, so one `am` invocation
 *  says where it is pointing once, not once per lookup. */
const _targetNoted = new Set<string>();

/** THE target of an `am` command: `--port` > this app's lock > the ONE running
 *  instance > app.ts > 8000.
 *
 *  The "one running instance" rung is the fix for a whole class of confusion.
 *  `am` resolves an appId from the cwd (deno.json `appId`, else title, else the
 *  directory name), and when that guess misses, every port-taking command
 *  silently fell through to **8000** — so `am state` answered "app not running
 *  on port 8000" while the app was serving on 8413, and `am dispatch` with no
 *  `--port` targeted (and sometimes STARTED) a different instance entirely: an
 *  Electron window appearing on a headless box, and minutes spent reading the
 *  state of another process. In the other direction, `am status` reported
 *  `stopped` for the resolved id while `am instances` listed the app as
 *  running — two liveness sources disagreeing, which is the bug class that
 *  makes you distrust your own measurements.
 *
 *  Both are the same defect: a GUESS with no way to see it. So the guess now
 *  falls back to the registry, and the resolution is ECHOED on stderr — stderr
 *  so `--json` output stays machine-clean — the first time it matters.
 *  Ambiguity is never resolved silently: with several instances up and no
 *  match, it says so and lists them rather than picking one. */
export function resolvePort(flag?: number, appId?: string): number {
  if (flag !== undefined) return flag;
  const id = appId ?? resolveAmAppId();
  const pf = readPid(id);
  if (pf) return pf.port;

  const live = instances();
  if (live.length === 1) {
    const only = live[0]!;
    if (!_targetNoted.has(only.appId)) {
      _targetNoted.add(only.appId);
      console.error(
        `[am] note: no app named "${id}" is running — using the one that ` +
          `is: ` +
          `${only.appId} @ :${only.port} (pid ${only.pid}). ` +
          `Pin it with --app=${only.appId}, or run am from its directory.`,
      );
    }
    return only.port;
  }
  if (live.length > 1) {
    const list = live.map((i) => `${i.appId} @ :${i.port}`).join(", ");
    console.error(
      `[am] ✗ no app named "${id}" is running, and ${live.length} others ` +
        `are: ` +
        `${list}. Refusing to guess — pass --app=<id> or --port=N.`,
    );
  }
  return readEntryConfig().port ?? DEFAULT_PORT;
}

// ── State path resolution ───────────────────────────────────

/** Traverse path with JS-like syntax: "fleet[0].stats", "fleet[*].{pair,status}", "owner.{id,name}" */
export function resolvePath(
  obj: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  // Normalize bracket notation: fleet[0] → fleet.0, fleet[*] → fleet.*
  path = path.replace(/\[(\d+|\*)\]/g, ".$1");

  // Wildcard: split on first *, resolve prefix as array, map suffix over elements
  const starIdx = path.indexOf(".*");
  if (starIdx !== -1) {
    const prefix = path.slice(0, starIdx);
    const suffix = path.slice(starIdx + 2); // skip ".*"
    const rest = suffix.startsWith(".") ? suffix.slice(1) : suffix;
    const parent = prefix
      ? resolvePath(obj, prefix)
      : { found: true as const, value: obj };
    if (!parent.found) return parent;
    if (!Array.isArray(parent.value)) return { found: false };
    const arr = parent.value as unknown[];
    if (!rest) return { found: true, value: arr };
    const results: unknown[] = [];
    for (const item of arr) {
      const r = resolvePath(item, rest);
      if (r.found) results.push(r.value);
    }
    return results.length ? { found: true, value: results } : { found: false };
  }

  // Check for brace-pick: "prefix.{a,b,c}" or "{a,b}" at root
  const braceMatch = path.match(/^(.*?)\.?\{([^}]+)\}$/);
  if (braceMatch) {
    const prefix = braceMatch[1];
    const picks = braceMatch[2]!.split(",").map((s) => s.trim());
    const parent = prefix
      ? resolvePath(obj, prefix)
      : { found: true as const, value: obj };
    if (!parent.found) return parent;
    if (parent.value == null || typeof parent.value !== "object") {
      return { found: false };
    }
    const src = parent.value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of picks) {
      // Support nested picks: {stats.pnl} traverses into the picked parent
      if (key.includes(".")) {
        const r = resolvePath(src, key);
        if (r.found) result[key] = r.value;
      } else {
        const idx = /^\d+$/.test(key) ? Number(key) : undefined;
        const val = idx !== undefined && Array.isArray(src)
          ? src[idx]
          : src[key];
        if (val !== undefined) result[key] = val;
      }
    }
    return { found: true, value: result };
  }

  const segments = path.split(".");
  let cur = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return { found: false };
    const idx = /^\d+$/.test(seg) ? Number(seg) : undefined;
    if (idx !== undefined && Array.isArray(cur)) {
      cur = cur[idx];
    } else {
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur === undefined) return { found: false };
  }
  return { found: true, value: cur };
}

/** Parse CLI arguments into command, positional args, and global flags (--json, --quiet, --port, --app) */
export function parseGlobalFlags(
  raw: string[],
): { command: string; args: string[]; flags: GlobalFlags } {
  const flags: GlobalFlags = {};
  const rest: string[] = [];

  // Flags that REQUIRE a value accept both `--k=v` and `--k v`. Only the
  // equals form used to be understood, so `am dispatch … --body '{"a":1}'`
  // silently passed the literal "--body" and the JSON as positional args —
  // the method then received "--body" as its first argument and failed inside
  // Immer, which reads like a bug in the app rather than a mistyped command.
  // Flags whose value is OPTIONAL (--wait, --client) are deliberately absent:
  // there, `--wait 5` cannot be told apart from `--wait` plus an argument.
  const takesValue = new Set([
    "--port",
    "--body",
    "--args",
    "--filter",
    "--lines",
    "--entry",
    "--transport",
    "--app",
    "--client-index",
  ]);
  const expanded: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    if (takesValue.has(a) && i + 1 < raw.length) {
      expanded.push(`${a}=${raw[++i]}`);
    } else if (a === "-i" && i + 1 < raw.length) {
      // `-i N` — the short form of `--client-index=N`.
      expanded.push(`--client-index=${raw[++i]}`);
    } else expanded.push(a);
  }

  // A numeric flag that does not parse is recorded as `flags.error` (first
  // one wins) and `am` exits loud on it — `--lines=1O0` silently printing
  // the default line count is the same NaN bug class `parseNumArg` exists
  // for, and these flags predate it.
  const num = (raw: string, label: string): number | undefined => {
    const r = parseNumArg(raw, label);
    if (r.ok) return r.value;
    flags.error ??= r.error;
    return undefined;
  };
  for (const a of expanded) {
    if (a === "--json") flags.json = true;
    else if (a === "--data") flags.data = true;
    else if (a === "--print") flags.print = true;
    else if (a === "--tables") flags.tables = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--stale") flags.stale = true;
    else if (a === "--as-server") flags.asServer = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a.startsWith("--port=")) flags.port = num(a.slice(7), "--port");
    else if (a.startsWith("--body=")) flags.jsonBody = a.slice(7);
    else if (a.startsWith("--args=")) flags.jsonArgs = a.slice(7);
    else if (a.startsWith("--filter=")) flags.filter = a.slice(9);
    else if (a.startsWith("--lines=")) flags.lines = num(a.slice(8), "--lines");
    else if (a.startsWith("--wait=")) flags.wait = num(a.slice(7), "--wait");
    else if (a === "--wait") flags.wait = 0; // bare --wait = use default
    else if (a === "--follow" || a === "-f") flags.follow = true;
    else if (a.startsWith("--entry=")) flags.entry = a.slice(8);
    else if (a.startsWith("--transport=")) flags.transport = a.slice(12);
    else if (a.startsWith("--app=")) flags.app = a.slice(6);
    else if (a.startsWith("--client-index=")) {
      flags.client = num(a.slice(15), "--client-index");
    } else if (a === "--client-index") flags.client = 0;
    else if (a.startsWith("-i") && a.length > 2) {
      // `-i2` — attached short form of `--client-index=2`.
      flags.client = num(a.slice(2), "-i (client index)");
    } // ── deprecated spellings of the client INDEX (renamed in alpha52:
    // `--client=N` collides with the runtime's `--client=<kind>`, so an
    // `am`-vs-app confusion read as a valid flag on both sides). Accepted
    // through beta, with a hint naming the new one. ──
    else if (a.startsWith("--client=")) {
      // Numeric = the deprecated am client INDEX. Anything else is the
      // RUNTIME's --client=<kind> — forwarded as a positional so commands
      // that launch an app (`am ui --client=browser`) can pass it through.
      if (/^\d+$/.test(a.slice(9).trim())) {
        console.error(
          "am: warning: --client=N is now --client-index=N (or -i N) — the old " +
            "spelling still works, but collides with the app runtime's " +
            "--client=<kind>",
        );
        flags.client = num(a.slice(9), "--client");
      } else rest.push(a);
    } else if (a.startsWith("-c") && a.length > 2) {
      // `-c2` was the short form of `--client=2`. `-c2x` used to fail the
      // isNaN test and fall through to the POSITIONAL args, where it became a
      // command argument — the same NaN class, silent one step further along.
      console.error("am: warning: -cN is now -i N (client index)");
      flags.client = num(a.slice(2), "-c (client index)");
    } else if (a === "--client") flags.client = 0;
    else if (a === "--ui") flags.ui = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else rest.push(a);
  }

  const command = rest[0] ?? "help";
  const args = rest.slice(1);
  return { command, args, flags };
}

/** Parse a numeric CLI argument, or say why it is not one. Never returns NaN.
 *
 *  `Number("2s")` is NaN, and NaN is the SILENT kind of wrong: handed to
 *  `setTimeout` it becomes 1ms, so `am discover --timeout=2s` swept the LAN for
 *  one millisecond and then reported "no aio apps found" — complete with a
 *  confident note about UDP being blocked on some networks. The typo was in the
 *  flag; the answer sent people to their firewall. A flag we cannot read is an
 *  error, never a default and never a plausible-looking result.
 *
 *  Pure: the caller renders the message with its own `outError(…, mode)`. */
export function parseNumArg(
  raw: string | undefined,
  label: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): { ok: true; value: number } | { ok: false; error: string } {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) {
    return { ok: false, error: `${label} must be a number (got "${raw}")` };
  }
  if (opts.integer && !Number.isInteger(n)) {
    return {
      ok: false,
      error: `${label} must be a whole number (got "${raw}")`,
    };
  }
  if (opts.min !== undefined && n < opts.min) {
    return { ok: false, error: `${label} must be ≥ ${opts.min} (got ${n})` };
  }
  if (opts.max !== undefined && n > opts.max) {
    return { ok: false, error: `${label} must be ≤ ${opts.max} (got ${n})` };
  }
  return { ok: true, value: n };
}

/** Parse "key=val" pairs → object, auto-parse values */
export function parsePayload(args: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq === -1) {
      result[arg] = true;
      continue;
    }
    const key = arg.slice(0, eq);
    const raw = arg.slice(eq + 1);
    try {
      result[key] = JSON.parse(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}

// ── Command context (complexity audit) ──────────────────────────────
// The `mode/appId/port` preamble appeared 26× across am-cmd-* files, and the
// `if (!result.ok) { outError; exit(1) }` guard 18× — every new command
// re-typed both. One resolver + one guard.

/** Everything a command needs to talk to a running app. */
export type AmCtx = {
  mode: ReturnType<typeof detectMode>;
  appId: string;
  port: number;
};

/** Resolve the standard command context from global flags. */
/** Where an app's durable journal lives, for the commands that read one
 *  without being told (`am record`, `am timeline --from`, `am replay`).
 *
 *  `<data>/journal` is the answer for any app on the current layout. The legacy
 *  `./data.db.journal` is still accepted as a fallback so a developer sitting in
 *  an un-migrated project directory gets their file rather than a "no journal"
 *  error — the app itself migrates it on its next boot. */
export function defaultJournalPath(appId: string): string {
  const current = appDirs(appId).journal;
  try {
    Deno.statSync(current);
    return current;
  } catch { /* not there — try the pre-alpha38 location */ }
  const legacy = join(Deno.cwd(), "data.db.journal");
  try {
    Deno.statSync(legacy);
    return legacy;
  } catch { /* neither exists — report the current path in the error */ }
  return current;
}

export function amCtx(flags: GlobalFlags): AmCtx {
  const appId = resolveAmAppId(flags.app);
  return {
    mode: detectMode(flags),
    appId,
    port: resolvePort(flags.port, appId),
  };
}

/** GET a trojan route and print the result — exits(1) loudly on failure.
 *  The one-call body of most read-only am commands. */
export async function runTrojanGet(
  ctx: AmCtx,
  route: string,
  timeoutMs?: number,
): Promise<void> {
  const result = await trojanGet(ctx.port, route, ctx.appId, timeoutMs);
  if (!result.ok) {
    outError(result.error, ctx.mode);
    Deno.exit(1);
  }
  out(result.data, ctx.mode);
}

/** POST to a trojan route and print the result — exits(1) loudly on failure. */
export async function runTrojanPost(
  ctx: AmCtx,
  route: string,
  body: unknown,
): Promise<void> {
  const result = await trojanPost(ctx.port, route, body, ctx.appId);
  if (!result.ok) {
    outError(result.error, ctx.mode);
    Deno.exit(1);
  }
  out(result.data, ctx.mode);
}
