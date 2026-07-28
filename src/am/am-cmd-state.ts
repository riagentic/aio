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

// ── am expect: e2e assertion over server state (risoto #5) ──────────────────

const EXPECT_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "exists",
  "absent",
] as const;

/** Compare a resolved state value against an operator + expected value — pure,
 *  so the e2e assertion is unit-testable. `found` distinguishes a missing path
 *  (for exists/absent) from a present null/undefined. */
export function compareValue(
  actual: unknown,
  op: string,
  expected: unknown,
  found: boolean,
): { ok: boolean; reason: string } {
  const j = (v: unknown) => JSON.stringify(v);
  const num = (v: unknown) => Number(v);
  switch (op) {
    case "exists":
      return { ok: found, reason: found ? "present" : "path not found" };
    case "absent":
      return {
        ok: !found,
        reason: found ? `present (${j(actual)})` : "absent",
      };
    case "eq":
      return {
        ok: j(actual) === j(expected),
        reason: `${j(actual)} vs ${j(expected)}`,
      };
    case "ne":
      return {
        ok: j(actual) !== j(expected),
        reason: `${j(actual)} vs ${j(expected)}`,
      };
    case "gt":
      return {
        ok: num(actual) > num(expected),
        reason: `${j(actual)} > ${j(expected)}`,
      };
    case "gte":
      return {
        ok: num(actual) >= num(expected),
        reason: `${j(actual)} >= ${j(expected)}`,
      };
    case "lt":
      return {
        ok: num(actual) < num(expected),
        reason: `${j(actual)} < ${j(expected)}`,
      };
    case "lte":
      return {
        ok: num(actual) <= num(expected),
        reason: `${j(actual)} <= ${j(expected)}`,
      };
    case "contains":
      if (typeof actual === "string") {
        return {
          ok: actual.includes(String(expected)),
          reason: `"${actual}" ⊇ ${j(expected)}`,
        };
      }
      if (Array.isArray(actual)) {
        return {
          ok: actual.some((x) => j(x) === j(expected)),
          reason: `${j(actual)} ∋ ${j(expected)}`,
        };
      }
      return { ok: false, reason: `${j(actual)} is not a string/array` };
    default:
      return {
        ok: false,
        reason: `unknown op "${op}" (use: ${EXPECT_OPS.join(" ")})`,
      };
  }
}

/** `am expect <path> <op> [value]` — assert on live server state; exit 1 on
 *  mismatch. `--wait=<s>` polls until it passes (state settles async in e2e).
 *  The building block for a scripted `deno task test:e2e` over the real socket. */
export async function cmdExpect(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const [path, op, rawValue] = args;
  if (!path || !op) {
    outError(
      `usage: am expect <path> <op> [value] — ops: ${EXPECT_OPS.join(" ")}`,
      mode,
    );
    Deno.exit(1);
  }
  const expected = rawValue === undefined ? undefined : parseScalar(rawValue);

  const evaluate = async (): Promise<{ ok: boolean; reason: string }> => {
    const result = await trojanGet(port, "state", appId);
    if (!result.ok) return { ok: false, reason: result.error };
    const r = resolvePath(result.data, path);
    return compareValue(r.found ? r.value : undefined, op, expected, r.found);
  };

  const deadline = flags.wait !== undefined
    ? Date.now() + flags.wait * 1000
    : 0;
  let outcome = await evaluate();
  while (!outcome.ok && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    outcome = await evaluate();
  }

  if (outcome.ok) {
    out(
      mode === "pretty"
        ? `PASS  ${path} ${op}${rawValue !== undefined ? ` ${rawValue}` : ""}`
        : { ok: true, path, op },
      mode,
    );
    return;
  }
  outError(
    `FAIL  ${path} ${op}${
      rawValue !== undefined ? ` ${rawValue}` : ""
    } — ${outcome.reason}`,
    mode,
  );
  Deno.exit(1);
}

/** Parse a CLI value as JSON when possible (numbers, booleans, quoted strings,
 *  arrays), else keep it a bare string. */
function parseScalar(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

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

/**
 * Shape a named payload for the action type it is going to.
 *
 * Two protocols share one command. A plain redux-style action carries its
 * payload directly (`{by: 1}`), but a CELL METHOD is called with positional
 * arguments and the wire form is `{args: [...]}` — so `am dispatch
 * nav:setPanelType panel=0 type=x` sent `{panel: 0, type: "x"}` to a method
 * expecting `payload.args`, and failed with "Cannot read properties of
 * undefined". That reads like a bug in the cell, and cost a real detour
 * chasing one. `cell:method` is unambiguous in the type, so use it: named
 * pairs become the method's single object argument, which is what a method
 * taking named options wants anyway.
 *
 * Pure — exported for the test that pins both protocols.
 */
export function envelopePayload(
  type: string,
  named: Record<string, unknown>,
): Record<string, unknown> {
  const isCellMethod = type.includes(":");
  return isCellMethod ? { args: [named] } : named;
}

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
    // `--body` wants the whole ENVELOPE, but the natural guess is that it wants
    // the payload — and that guess used to fail deep inside Immer, with an
    // error that read like a bug in the app's cell rather than a wrong command.
    //
    // The type itself decides, not the body's shape: if the caller already
    // NAMED the action positionally (`am dispatch nav:setPanelType --body …`),
    // the body cannot be the envelope, because the envelope would have to
    // carry that same type. Sniffing for a `type` key instead would be wrong
    // exactly where it matters — `{"panel":0,"type":"nfts"}` is a payload whose
    // own field is called `type`, which is how this was first hit.
    const body = action as Record<string, unknown> | null;
    if (
      body !== null && typeof body === "object" && !Array.isArray(body) &&
      args.length > 0
    ) {
      action = { type: args[0], payload: envelopePayload(args[0]!, body) };
    }
  } else if (args.length === 0) {
    outError(
      "usage: am dispatch <cell:method> [key=val ...] " +
        "(a cell method takes ONE object argument, or positional JSON values) " +
        'or am dispatch <Type> --body=\'{"type":...,"payload":...}\'',
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
        action = { type, payload: envelopePayload(type!, parsePayload(rest)) };
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

/** `am migrations` — declared vs stored per-cell versions, what the last boot's
 *  migration pass did, and any unaccounted shape drift (risoto #1). */
export async function cmdMigrations(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const ctx = amCtx(flags);
  const r = await trojanGet(ctx.port, "migrations", ctx.appId);
  if (!r.ok) {
    outError(r.error, ctx.mode);
    Deno.exit(1);
  }
  if (ctx.mode !== "pretty") {
    out(r.data, ctx.mode);
    return;
  }
  const m = r.data as {
    declared: Record<string, number>;
    stored: Record<string, number>;
    report: { cell: string; from: number; to: number; outcome: string }[];
    drift: {
      cell: string;
      path: string;
      issue: string;
      storedType: string;
      declaredType?: string;
    }[];
  };
  const lines: string[] = [];
  const cells = [
    ...new Set([...Object.keys(m.declared), ...Object.keys(m.stored)]),
  ].sort();
  lines.push("versions (declared → stored):");
  if (cells.length === 0) lines.push("  (none tracked)");
  for (const c of cells) {
    const d = m.declared[c] ?? 0;
    const s = m.stored[c] ?? 0;
    lines.push(`  ${c}: v${d}${s !== d ? ` (stored v${s})` : ""}`);
  }
  if (m.report.length > 0) {
    lines.push("", "last boot migration:");
    for (const r of m.report) {
      lines.push(`  ${r.cell}: v${r.from}→v${r.to} [${r.outcome}]`);
    }
  }
  lines.push("", `shape drift: ${m.drift.length}`);
  for (const d of m.drift) {
    const where = d.path ? `${d.cell}.${d.path}` : d.cell;
    const detail = d.issue === "type-changed"
      ? `${d.storedType} ≠ declared ${d.declaredType}`
      : d.issue === "unknown-cell"
      ? "stored, no longer declared"
      : `${d.storedType}, not in initialState`;
    lines.push(`  ⚠ ${where} — ${detail}`);
  }
  out(lines.join("\n"), ctx.mode);
}

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
