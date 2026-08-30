/**
 * @module
 * State and dispatch commands for am — state, ui, dispatch, actions, tt, persist, snapshot.
 */

import type { GlobalFlags } from "./am-types.ts";
import {
  describe,
  detectMode,
  out,
  outError,
  stack,
  style,
} from "./am-output.ts";
import {
  amCtx,
  overwriteRefusal,
  parsePayload,
  resolveAmAppId,
  resolvePath,
  resolvePort,
  runTrojanGet,
} from "./am-utils.ts";
import { httpGet, trojanGet, trojanPost } from "./am-http.ts";

// ── am expect: e2e assertion over server state ──────────────────

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
  // An ordering op on something that is not a number used to answer "false" —
  // indistinguishable from a real assertion failure, so `am expect n gt 1O`
  // (or a path holding a string) sent people to debug the app instead of the
  // command. NaN never decides an assertion; it says so.
  const order = (
    sym: string,
    cmp: (a: number, b: number) => boolean,
  ): { ok: boolean; reason: string } => {
    const a = Number(actual), b = Number(expected);
    const bad = !Number.isFinite(a)
      ? `actual ${j(actual)}`
      : !Number.isFinite(b)
      ? `expected ${j(expected)}`
      : null;
    return bad
      ? { ok: false, reason: `${sym} needs numbers — ${bad} is not one` }
      : { ok: cmp(a, b), reason: `${j(actual)} ${sym} ${j(expected)}` };
  };
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
      return order(">", (a, b) => a > b);
    case "gte":
      return order(">=", (a, b) => a >= b);
    case "lt":
      return order("<", (a, b) => a < b);
    case "lte":
      return order("<=", (a, b) => a <= b);
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
  const port = resolvePort(flags.port, appId, {
    explicit: flags.app !== undefined,
  });
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
  // `--ui`: the filtered UI-state projection (optionally per user) instead of
  // raw state — the command that used to be spelled `am ui`.
  if (flags.ui) return uiProjection(args, flags);
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId, {
    explicit: flags.app !== undefined,
  });
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
/** The server-side UI-STATE PROJECTION — `am state --ui [user]`. It was
 *  `am ui` before alpha52; that name now opens amui (the visual manager), and
 *  the projection is a VIEW of state, so it lives on the state command. */
async function uiProjection(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId, {
    explicit: flags.app !== undefined,
  });
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

/** The forms `am dispatch` actually accepts — printed on every usage error so
 *  the working spellings are the documented ones. A method taking ONE STRING
 *  had no spelling at all here: `--body='{"args":["x"]}'` was re-wrapped into
 *  the method's single object argument and the app persisted `[object Object]`.
 *  `--args` is that spelling. */
export const DISPATCH_USAGE = `usage: am dispatch <cell:method> [args…]
  am dispatch conn:setHost 192.168.1.9            positional args (no '=') → setHost("192.168.1.9")
  am dispatch conn:setHost --args='["192.168.1.9"]'   the same, JSON-exact (use when a value contains '=' or must keep its type)
  am dispatch conn:configure host=h port=8000     named pairs → configure({host:"h", port:8000})
  am dispatch Increment by=1                      a plain (non-cell) action → payload {by:1}
  am dispatch Increment --body='{"by":1}'         --body after a type is that action's PAYLOAD
  am dispatch --body='{"type":"conn:setHost","payload":{"args":["192.168.1.9"]}}'   the whole envelope
values are auto-parsed as JSON when possible (numbers, booleans, arrays), else kept as strings`;

/** Parse `--args` — a JSON ARRAY of positional arguments for a cell method.
 *
 *  Pure, and loud on both near-misses: `--args='"x"'` and `--args='{"host":…}'`
 *  are the two things a caller reaches for first, and silently accepting either
 *  would rebuild the exact bug this flag exists to kill (an argument arriving
 *  as the wrong shape and getting persisted). */
export function parseArgsFlag(
  raw: string,
): { ok: true; args: unknown[] } | { ok: false; error: string } {
  const example = `--args='["192.168.1.9"]'`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: `--args must be a JSON array of positional arguments — ` +
        `${example} (got ${JSON.stringify(raw)}, which is not JSON)`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `--args must be a JSON ARRAY of positional arguments — ` +
        `${example} (got ${JSON.stringify(parsed)}). ` +
        `For a method taking one object, wrap it: --args='[{"host":"…"}]'`,
    };
  }
  return { ok: true, args: parsed };
}

export async function cmdDispatch(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId, {
    explicit: flags.app !== undefined,
  });

  let action: unknown;
  if (flags.jsonArgs !== undefined) {
    // `--args` IS the whole argument list, so anything else that also carries
    // arguments is a contradiction, not a merge — refuse rather than pick.
    if (flags.jsonBody !== undefined) {
      outError(
        "--args and --body both carry the arguments — pass one, not both.\n" +
          DISPATCH_USAGE,
        mode,
      );
      Deno.exit(1);
    }
    if (args.length === 0) {
      outError(`--args needs the action type: ${DISPATCH_USAGE}`, mode);
      Deno.exit(1);
    }
    if (args.length > 1) {
      outError(
        `--args carries every argument — drop the extra positional ` +
          `${args.length > 2 ? "args" : "arg"} (${
            args.slice(1).join(" ")
          }) or drop --args.\n${DISPATCH_USAGE}`,
        mode,
      );
      Deno.exit(1);
    }
    const parsed = parseArgsFlag(flags.jsonArgs);
    if (!parsed.ok) {
      outError(parsed.error, mode);
      Deno.exit(1);
      return;
    }
    action = { type: args[0], payload: { args: parsed.args } };
  } else if (flags.jsonBody) {
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
    outError(DISPATCH_USAGE, mode);
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

  // `--as-server` — dispatch with SERVER provenance, past the cell `access`
  // gate. "Public read, server-only write" (`access: false` + `visible: "all"`)
  // is a shape aio encourages, and it left the operator unable to call one
  // method from the CLI; the fallback was `am snapshot save/load`, which
  // bypasses validation entirely and is the wrong tool for "call this method".
  // The trojan is already dev-only and loopback-only, so this widens nothing —
  // it replaces a bypass through the snapshot file with a named, logged door.
  const route = flags.asServer ? "dispatch?as=server" : "dispatch";
  const result = await trojanPost(port, route, action, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  const data = result.data as { result?: unknown; resultDropped?: boolean };
  if (mode === "pretty") {
    const label = flags.asServer ? "dispatched (as server)" : "dispatched";
    if (data?.resultDropped) {
      out(`${label} — the method returned a value JSON cannot carry`, mode);
    } else if (data && "result" in data) {
      // The RETURN VALUE, in the house style rather than as raw JSON with
      // braces and quotes. `--json` still carries it verbatim — this is the
      // human branch, and a method that returns a record is exactly the case
      // an aligned `label  value` block reads better than `{ "a": 1 }`.
      out(
        { message: label, result: data.result },
        mode,
        () =>
          typeof data.result === "object" && data.result !== null
            ? stack(style.dim(label), describe(data.result))
            : `${style.dim(label)} ${String(data.result)}`,
      );
    } else out(label, mode);
  } else out(result.data, mode);
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
  const port = resolvePort(flags.port, appId, {
    explicit: flags.app !== undefined,
  });
  const cmd = args[0];
  if (!cmd) {
    outError("usage: am timetravel <undo|redo|goto N|pause|resume>", mode);
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
 *  migration pass did, and any unaccounted shape drift. */
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
  const port = resolvePort(flags.port, appId, {
    explicit: flags.app !== undefined,
  });
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
  const port = resolvePort(flags.port, appId, {
    explicit: flags.app !== undefined,
  });
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
    // `am backup` refuses to write over an existing file; this wrote over it
    // silently. One family, one rule.
    const clobber = overwriteRefusal(file, !!flags.force, "a state snapshot");
    if (clobber) {
      outError(clobber, mode);
      Deno.exit(1);
    }
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
