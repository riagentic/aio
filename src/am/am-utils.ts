/**
 * @module
 * Utility functions for am — aio manager CLI.
 * Path resolution, payload parsing, entry/appId/port resolution.
 */

import {
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
  try {
    const cfg = JSON.parse(Deno.readTextFileSync("deno.json")) as {
      entry?: string;
    };
    if (cfg.entry) {
      try {
        Deno.statSync(cfg.entry);
        return cfg.entry;
      } catch {
        return null;
      }
    }
  } catch { /* no deno.json */ }
  try {
    Deno.statSync("src/app.ts");
    return "src/app.ts";
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

/** --port flag > lock file > app.ts > default 8000. */
export function resolvePort(flag?: number, appId?: string): number {
  if (flag !== undefined) return flag;
  const pf = readPid(appId);
  if (pf) return pf.port;
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

  for (const a of raw) {
    if (a === "--json") flags.json = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a.startsWith("--port=")) {
      const v = Number(a.slice(7));
      flags.port = isNaN(v) ? undefined : v;
    } else if (a.startsWith("--body=")) flags.jsonBody = a.slice(7);
    else if (a.startsWith("--filter=")) flags.filter = a.slice(9);
    else if (a.startsWith("--lines=")) {
      const v = Number(a.slice(8));
      flags.lines = isNaN(v) ? undefined : v;
    } else if (a.startsWith("--wait=")) {
      const v = Number(a.slice(7));
      flags.wait = isNaN(v) ? undefined : v;
    } else if (a === "--wait") flags.wait = 0; // bare --wait = use default
    else if (a === "--follow" || a === "-f") flags.follow = true;
    else if (a.startsWith("--entry=")) flags.entry = a.slice(8);
    else if (a.startsWith("--transport=")) flags.transport = a.slice(12);
    else if (a.startsWith("--app=")) flags.app = a.slice(6);
    else if (a.startsWith("--client=")) {
      const v = Number(a.slice(9));
      flags.client = isNaN(v) ? undefined : v;
    } else if (
      a.startsWith("-c") && a.length > 2 && !isNaN(Number(a.slice(2)))
    ) {
      flags.client = Number(a.slice(2));
    } else if (a === "--client") flags.client = 0;
    else if (a === "--all") flags.all = true;
    else rest.push(a);
  }

  const command = rest[0] ?? "help";
  const args = rest.slice(1);
  return { command, args, flags };
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
