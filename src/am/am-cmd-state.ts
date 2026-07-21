/**
 * @module
 * State and dispatch commands for am — state, ui, dispatch, actions, tt, persist, snapshot.
 */

import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import {
  amCtx,
  parsePayload,
  resolveAmAppId,
  resolvePath,
  resolvePort,
  runTrojanGet,
} from "./am-utils.ts";
import { httpGet, trojanGet, trojanPost } from "./am-http.ts";

// ── State ───────────────────────────────────────────────────

export async function cmdState(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const path = args[0];

  const fetchAndResolve = async (
    silent = false,
  ): Promise<{ ok: true; data: unknown } | { ok: false }> => {
    const result = await trojanGet(port, "state", appId);
    if (!result.ok) {
      if (!silent) outError(result.error, mode);
      return { ok: false };
    }
    if (!path) return { ok: true, data: result.data };
    const r = resolvePath(result.data, path);
    if (!r.found) {
      if (!silent) {
        const keys = result.data && typeof result.data === "object"
          ? Object.keys(result.data as Record<string, unknown>)
          : [];
        const hint = keys.length ? ` (available: ${keys.join(", ")})` : "";
        outError(`path "${path}" not found in state${hint}`, mode);
      }
      return { ok: false };
    }
    return { ok: true, data: r.value };
  };

  // Single shot (no --wait)
  if (flags.wait === undefined) {
    const r = await fetchAndResolve();
    if (!r.ok) Deno.exit(1);
    out(r.data, mode);
    return;
  }

  // Watch mode: --wait=N polls every N seconds (bare --wait defaults to 2s)
  const interval = (flags.wait || 2) * 1000;
  let lastOk = true;
  while (true) {
    const r = await fetchAndResolve(!lastOk); // suppress repeated errors
    if (!r.ok) {
      if (lastOk) lastOk = false; // first error already printed by fetchAndResolve
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }
    lastOk = true;
    out(r.data, mode);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** `am ui [user]` — server-side UI state (the projected state tree). For live
 *  client inspection use `am surface` (semantic UI surface, the same facility
 *  `testUI` drives). */
export async function cmdUi(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const user = args[0];
  const route = user ? `ui?user=${encodeURIComponent(user)}` : "ui";
  const result = await trojanGet(port, route, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

// ── Actions ─────────────────────────────────────────────────

export async function cmdDispatch(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);

  let action: unknown;
  if (flags.jsonBody) {
    // --body='{"type":"Increment","payload":{"by":1}}'
    try {
      action = JSON.parse(flags.jsonBody);
    } catch {
      outError("invalid --body JSON", mode);
      Deno.exit(1);
    }
  } else if (args.length === 0) {
    outError(
      "usage: am dispatch <Type> [key=val ...] or am dispatch --body='{\"type\":...}'",
      mode,
    );
    Deno.exit(1);
  } else {
    const type = args[0];
    if (args.length <= 1) {
      action = { type };
    } else {
      const rest = args.slice(1);
      // If any arg has '=' → action-style named payload: { key: val }
      // Otherwise → method-style positional args: { args: [...] }
      const hasNamedArgs = rest.some((a) => a.includes("="));
      if (hasNamedArgs) {
        action = { type, payload: parsePayload(rest) };
      } else {
        // Parse each positional arg as JSON if possible, else string
        const parsed = rest.map((a) => {
          try {
            return JSON.parse(a);
          } catch {
            return a;
          }
        });
        action = { type, payload: { args: parsed } };
      }
    }
  }

  const result = await trojanPost(port, "dispatch", action, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(mode === "pretty" ? "dispatched" : result.data, mode);
}

export async function cmdActions(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  await runTrojanGet(amCtx(flags), "history");
}

// ── Time-travel ─────────────────────────────────────────────

export async function cmdTT(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const cmd = args[0];
  if (!cmd) {
    outError("usage: am tt <undo|redo|goto N|pause|resume>", mode);
    Deno.exit(1);
  }
  const arg = cmd === "goto" ? Number(args[1]) : undefined;
  if (cmd === "goto" && (arg === undefined || isNaN(arg))) {
    outError("usage: am tt goto <index>", mode);
    Deno.exit(1);
  }
  const result = await trojanPost(port, "tt", { cmd, arg }, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(
    mode === "pretty"
      ? `tt: ${cmd}${arg !== undefined ? " " + arg : ""}`
      : result.data,
    mode,
  );
}

// ── Persistence ─────────────────────────────────────────────

export async function cmdPersist(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanPost(port, "persist", undefined, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(mode === "pretty" ? "persisted" : result.data, mode);
}

export async function cmdSnapshot(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const sub = args[0];

  if (!sub) {
    // GET snapshot to stdout
    const result = await httpGet(port, "/__aio/snapshot", appId);
    if (!result.ok) {
      outError(result.error, mode);
      Deno.exit(1);
    }
    console.log(result.data);
    return;
  }

  if (sub === "save") {
    const file = args[1] ?? "snapshot.json";
    const result = await httpGet(port, "/__aio/snapshot", appId);
    if (!result.ok) {
      outError(result.error, mode);
      Deno.exit(1);
    }
    Deno.writeTextFileSync(file, result.data as string);
    out(
      mode === "pretty" ? `saved to ${file}` : { file, status: "saved" },
      mode,
    );
    return;
  }

  if (sub === "load") {
    const file = args[1];
    if (!file) {
      outError("usage: am snapshot load <file>", mode);
      Deno.exit(1);
    }
    let json: string;
    try {
      json = Deno.readTextFileSync(file);
    } catch {
      outError(`can't read ${file}`, mode);
      Deno.exit(1);
      return;
    }
    const result = await trojanPost(port, "snapshot", JSON.parse(json), appId);
    if (!result.ok) {
      outError(result.error, mode);
      Deno.exit(1);
    }
    out(
      mode === "pretty" ? `loaded from ${file}` : { file, status: "loaded" },
      mode,
    );
    return;
  }

  outError("usage: am snapshot [save <file>|load <file>]", mode);
  Deno.exit(1);
}
