/**
 * @module
 * State and dispatch commands for am — state, ui, dispatch, actions, tt, persist, snapshot.
 */

import { CELL_METHOD_SEP } from "../state/cell-helpers.ts";
import type { GlobalFlags } from "./am-types.ts";
import {
  describe,
  detectMode,
  fail,
  out,
  outData,
  outError,
  outValue,
  sayData,
  stack,
  style,
} from "./am-output.ts";
import {
  amCtx,
  overwriteRefusal,
  parseNumArg,
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
  // A path that is not there has no value to compare. Answering the
  // comparison anyway made a typo pass: `am expect todo.itmes.length ne 0`
  // compared `undefined` with 0, found them different, and printed PASS —
  // the exact assertion a script uses to prove the list is non-empty. Only
  // `absent` is ABOUT a missing path; every other op fails on one, and says
  // which word asks the question it was probably meant to.
  if (!found && op !== "absent" && op !== "exists" && isExpectOp(op)) {
    return {
      ok: false,
      reason: "path not found — no actual value to compare (use `absent` " +
        "to assert a path is missing)",
    };
  }
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

function isExpectOp(op: string): op is typeof EXPECT_OPS[number] {
  return (EXPECT_OPS as readonly string[]).includes(op);
}

/** The usage error for `am expect`'s positionals, or null when they are
 *  well-formed. Pure, so the refusals are testable without a server.
 *
 *  Each of these used to be a PASS or a silent reinterpretation: `eq` with no
 *  value compared against `undefined` (and a missing path "equalled" it), a
 *  fourth word was dropped (`am expect title eq hello world` asserted
 *  "hello"), and an unknown op under `--wait` polled for the whole timeout
 *  before saying the op did not exist. */
export function expectUsageError(args: readonly string[]): string | null {
  const usage = `usage: am expect <path> <op> [value] — ops: ${
    EXPECT_OPS.join(" ")
  }`;
  const [path, op] = args;
  if (!path || !op) return usage;
  if (!isExpectOp(op)) {
    return `unknown op "${op}" (use: ${EXPECT_OPS.join(" ")})`;
  }
  const unary = op === "exists" || op === "absent";
  const want = unary ? 2 : 3;
  if (args.length < want) {
    return `am expect ${path} ${op} needs a value to compare against — ` +
      `e.g. am expect ${path} ${op} 3 (quote a string with spaces)`;
  }
  if (args.length > want) {
    return `am expect ${path} ${op} takes ${
      unary ? "no value" : "exactly one value"
    }, got extra: ${args.slice(want).join(" ")}` +
      (unary ? "" : ` — quote a value with spaces: '"hello world"'`);
  }
  return null;
}

/** Is this `am dispatch` argument a NAMED one (`key=value`)?
 *
 *  "Contains an `=`" was the test, so any positional that happened to hold one
 *  changed the whole call's shape: `am dispatch todo:add
 *  "https://example.com/?q=1"` sent `{"https://example.com/?q": 1}` instead of
 *  the URL, and a JSON positional like `{"f":"a=b"}` went the same way. A
 *  payload key is a property name, so the key must look like one.
 *
 *  A NAME, though, not a JS identifier. The first tightening took
 *  `[A-Za-z_$][\w$]*`, and `due-date=…`, `user.name=…` and `título=…` — named
 *  arguments for as long as the verb existed — silently became positionals.
 *  So: a letter (any script), `_` or `$`, then letters, digits, `_`, `$`, `-`
 *  and `.`. What the rule exists to keep positional still is: a URL (`:`, `/`,
 *  `?`), a sentence (a space), a JSON value (`{`, `[`, `"`), a leading digit. */
export function isNamedArg(arg: string): boolean {
  return /^[\p{L}_$][\p{L}\p{N}_$.-]*=/u.test(arg);
}

/** `am expect <path> <op> [value]` — assert on live server state; exit 1 on
 *  mismatch. `--wait=<s>` polls until it passes (state settles async in e2e).
 *  The building block for a scripted `deno task test:e2e` over the real socket. */
export async function cmdExpect(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const usageError = expectUsageError(args);
  if (usageError) {
    outError(usageError, mode);
    Deno.exit(1);
  }
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId, {
    explicit: flags.app !== undefined,
  });
  const [path, op, rawValue] = args as [string, string, string | undefined];
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

/** The state PATH among `am state`'s arguments — the first positional.
 *
 *  `am state --watch todo.items` and `am state todo.items --watch` mean the
 *  same thing. Reading `args[0]` blindly made the flag itself the path, so the
 *  command went looking for a state key called "--watch". */
export function _pathOfArgs(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

/** The refusal for `am state` given more than one path, or null.
 *
 *  `_pathOfArgs` reads the FIRST positional, so every other one used to be
 *  dropped without a word: `am state counter count` — the dot forgotten —
 *  answered `{"count": 5}` with exit 0, a whole object where a number was
 *  asked for. This is the primary scripting surface, and its value goes
 *  straight into a shell variable or an agent's next step, so a silently
 *  narrowed question is the worst answer it can give.
 *
 *  The message carries the fix, and there are two of them, because there are
 *  two ways to get here. The forgotten dot is one. The other is the SHELL:
 *  `am state fleet[0].{name,active}` is a real path syntax and bash expands
 *  the braces before `am` sees them, so it arrives as two arguments and the
 *  pick silently became its first field. Quoting is the fix there, and
 *  `.{name,active}` is not a dotted path, so the two hints are told apart by
 *  the shape of what arrived. Pure. @internal */
export function _extraPathError(args: readonly string[]): string | null {
  const paths = args.filter((a) => !a.startsWith("-"));
  if (paths.length < 2) return null;
  const head = `am state reads ONE state path, and ${paths.length} were ` +
    `given (${paths.join(" ")}) — the rest would have been dropped in ` +
    `silence.`;
  const brace = _braceHint(paths);
  if (brace) {
    return `${head} That is a field pick the shell expanded — quote it: ` +
      `am state '${brace}'`;
  }
  // No shared `prefix.`, so the two readings are INDISTINGUISHABLE from here
  // and both are named. `{counter,page}` — "pick from root" — is documented
  // path syntax, and bash expands it to exactly the two arguments a forgotten
  // dot makes; naming only the dot sent a caller who wrote the documented
  // form to `am state counter.page`, a path that does not resolve, for a
  // second wrong answer in a row.
  return `${head} A path is dotted: am state ${paths.join(".")} — or, if ` +
    `that was a field pick from the root, quote it: ` +
    `am state '{${paths.join(",")}}'`;
}

/** The `prefix{a,b}` these expanded paths came from, or null when they do not
 *  share a prefix ending at a `.` — i.e. when this was a forgotten dot rather
 *  than a shell brace expansion. Pure. @internal */
export function _braceHint(paths: readonly string[]): string | null {
  const first = paths[0]!;
  let i = 0;
  while (i < first.length && paths.every((p) => p[i] === first[i])) i++;
  const cut = first.lastIndexOf(".", i - 1) + 1;
  if (cut === 0) return null;
  const prefix = first.slice(0, cut);
  const tails = paths.map((p) => p.slice(cut));
  if (tails.some((t) => t === "")) return null;
  return `${prefix}{${tails.join(",")}}`;
}

export async function cmdState(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  // ONE path per call — asked before the app is even resolved, because a
  // second positional means the question is not the one that would be
  // answered. (`--ui` too: its argument is a single user.)
  const extra = _extraPathError(args);
  if (extra) fail(extra, detectMode(flags));
  // `--ui`: the filtered UI-state projection (optionally per user) instead of
  // raw state — the command that used to be spelled `am ui`.
  if (flags.ui) return uiProjection(args, flags);
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId, {
    explicit: flags.app !== undefined,
  });
  const path = _pathOfArgs(args);

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

  // `--watch`: a line per observed change, not a line per poll. It is still a
  // POLL underneath — a value that changes and changes back between two reads
  // prints nothing — and the help says so rather than promising every change.
  //
  // `--wait=N` already re-read the value every N seconds and printed it every
  // time — which is a poll loop with nicer syntax, and both reports that asked
  // for this wrote `until` loops around `am state` anyway, all session (report 7
  // §6). What they wanted was to be told when something HAPPENED. A change is
  // rare and a tick is not, so printing per tick buries the one line that
  // matters under hundreds that do not.
  const watch = args.includes("--watch");

  // Single shot (no --wait, no --watch)
  if (flags.wait === undefined && !watch) {
    const r = await fetchAndResolve();
    if (!r.ok) Deno.exit(1);
    outValue(r.data, mode);
    return;
  }

  // --wait=N sets the poll interval for both modes (bare --wait defaults to 2s)
  const interval = (flags.wait || 2) * 1000;
  let lastOk = true;
  let lastSeen: string | undefined;
  while (true) {
    const r = await fetchAndResolve(!lastOk); // suppress repeated errors
    if (!r.ok) {
      if (lastOk) lastOk = false; // first error already printed by fetchAndResolve
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }
    lastOk = true;
    if (watch) {
      // Compared by VALUE, not by identity: the state arrives freshly parsed
      // every poll, so every object would differ by reference and "changed"
      // would mean "polled".
      const now = JSON.stringify(r.data ?? null);
      if (now !== lastSeen) {
        // The FIRST reading prints too — an agent that starts watching needs
        // to know where it is starting from, or the first real change is
        // unreadable for want of a baseline.
        lastSeen = now;
        outValue(r.data, mode);
      }
    } else {
      outValue(r.data, mode);
    }
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
  outValue(result.data, mode);
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
  // The SHARED rule — `cell:method` and `cell.method` alike. This tested only
  // `:`, while the trojan route it posts to normalises both, so the dot form
  // reached the method with NO arguments: the named pairs were sent as a bare
  // payload, the method's parameter was `undefined`, the key was deleted from
  // state, and `am` reported `{"ok":true}`.
  const isCellMethod = CELL_METHOD_SEP.test(type);
  return isCellMethod ? { args: [named] } : named;
}

/**
 * Shape a RAW JSON value for the action type it is going to.
 *
 * `envelopePayload` above takes named PAIRS — the `k=v` form the CLI parses.
 * A text box holds something else: one JSON value the person typed, and for a
 * cell method the natural spelling of "positional arguments" is a JSON ARRAY.
 * amui's box says so in its own placeholder (`["ada@example.com"]`), then fed
 * the parsed value to `envelopePayload`, which wraps whatever it gets as ONE
 * argument. So the documented spelling produced `args: [["ada@example.com"]]`:
 * the method's first parameter was an Array where a string was expected, the
 * wrong value was persisted, and the trojan answered ok so the UI reported
 * "dispatched".
 *
 * The rule, matching `am dispatch --args='[…]'`:
 *   • not a cell method → the value IS the payload (redux-style).
 *   • cell method + array → those are the positional arguments.
 *   • cell method + anything else → one argument, as before.
 *
 * Pure — exported for the test that pins all three.
 */
export function envelopeJsonPayload(type: string, value: unknown): unknown {
  // A plain action's payload IS the value — nothing to decide, and inventing a
  // wrapper here would be the same class of guess this function exists to end.
  if (!CELL_METHOD_SEP.test(type)) return value;
  return { args: Array.isArray(value) ? value : [value] };
}

/** The forms `am dispatch` actually accepts — printed on every usage error so
 *  the working spellings are the documented ones. A method taking ONE STRING
 *  had no spelling at all here: `--body='{"args":["x"]}'` was re-wrapped into
 *  the method's single object argument and the app persisted `[object Object]`.
 *  `--args` is that spelling. */
export const DISPATCH_USAGE = `usage: am dispatch <cell:method> [args…]
  am dispatch conn:setHost 192.168.1.9            positional args (no '=') → setHost("192.168.1.9")
  am dispatch conn:setHost --args='["192.168.1.9"]'   the same, JSON-exact (use when a value contains '=' or must keep its type)
  am dispatch conn:import --args=@rows.json     the argument list from a FILE (--args=- reads stdin; --body takes both too) — for a payload too big for the command line
  am dispatch conn:configure host=h port=8000     named pairs → configure({host:"h", port:8000})
  am dispatch Increment by=1                      a plain (non-cell) action → payload {by:1}
  am dispatch Increment --body='{"by":1}'         --body after a type is that action's PAYLOAD
  am dispatch --body='{"type":"conn:setHost","payload":{"args":["192.168.1.9"]}}'   the whole envelope
values are auto-parsed as JSON when possible (numbers, booleans, arrays), else kept as strings`;

/** The `--args` FLAG's value, written as a POSITIONAL argument instead.
 *
 *  `am dispatch counter:increment '{"args":[0]}'` parses to an object and is
 *  passed as ONE argument, so the payload becomes the double wrap
 *  `{ args: [ { args: [0] } ] }` and the method receives the wrapper where it
 *  expected a number. MEASURED on the counter example: `s.count += by` made
 *  `count` the string `"2[object Object]"`, the dispatch answered
 *  `{"ok":true}`, and the app ran on until the NEXT boot, where the persist
 *  shape-drift check finally refused it — a corruption reported a restart
 *  late, by a check about something else.
 *
 *  The shape is unmistakable (an object whose only key is `args`, holding an
 *  array) and no method meaningfully takes it, so it is refused at the
 *  keystroke that meant something else. An app that genuinely wants that
 *  object still has `--args='[{"args":[…]}]'`, which the refusal names.
 *
 *  Returns the refusal text, or null when the arguments are fine. */
export function argsFlagAsPositional(
  type: string,
  rest: string[],
  parsed: unknown[],
): string | null {
  const at = parsed.findIndex((v) =>
    !!v && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(v as Record<string, unknown>).length === 1 &&
    Array.isArray((v as { args?: unknown }).args)
  );
  if (at === -1) return null;
  const inner = JSON.stringify((parsed[at] as { args: unknown[] }).args);
  return `argument ${at + 1} is \`${rest[at]}\` — that is the shape of the ` +
    `\`--args\` FLAG, passed as a positional value, so the method would ` +
    `receive the wrapper object itself instead of the arguments inside it.\n` +
    `  did you mean: am dispatch ${type} --args=${inner}\n` +
    `  or, to pass that object as a real argument: ` +
    `am dispatch ${type} --args='[${rest[at]}]'`;
}

/** Where a `--args` / `--body` value really lives.
 *
 *  `--args='<300 KB>'` cannot be spawned at all — the kernel refuses an argv
 *  entry that long — so a big payload had no spelling. `@path` reads it from a
 *  file and `-` from stdin. Additive: neither is valid JSON for an argument
 *  list or an envelope, so no working command changes meaning. `readStdin` is
 *  injectable for tests. */
export async function readFlagPayload(
  value: string | undefined,
  flag: "--args" | "--body",
  readStdin: () => Promise<string> = () =>
    new Response(Deno.stdin.readable).text(),
): Promise<
  { ok: true; value: string | undefined } | { ok: false; error: string }
> {
  if (value === "-") {
    try {
      return { ok: true, value: await readStdin() };
    } catch (e) {
      return {
        ok: false,
        error: `${flag}=- could not read stdin: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
  }
  if (value !== undefined && value.startsWith("@")) {
    const path = value.slice(1);
    try {
      return { ok: true, value: await Deno.readTextFile(path) };
    } catch (e) {
      return {
        ok: false,
        error: `${flag}=@${path}: cannot read that file (${
          e instanceof Error ? e.message : String(e)
        }) — @<path> reads the JSON from a file, - from stdin`,
      };
    }
  }
  return { ok: true, value };
}

/** The first number literal in `json` that JSON.parse cannot hold EXACTLY —
 *  an integer beyond ±2^53 (it is rounded: a 19-digit id arrives as another
 *  id) or one past the double range (`Infinity`, which the wire then carries
 *  as `null`) — or null. Not JSON at all is null too: the caller keeps such a
 *  value as a string, which is exact.
 *
 *  Fractions are not judged: `0.1` is inexact in binary by nature and nobody
 *  typing a decimal expects otherwise. An INTEGER that silently changes is a
 *  different thing — an account number, a snowflake, a card number.
 *
 *  Pure — reads each literal's SOURCE text (JSON.parse source access). */
export function lossyNumberLiteral(json: string): string | null {
  let hit: string | null = null;
  try {
    JSON.parse(json, (_k: string, v: unknown, ctx?: { source?: string }) => {
      if (hit === null && typeof v === "number") {
        const src = ctx?.source ?? String(v);
        if (!Number.isFinite(v) || (/^-?\d+$/.test(src) && !exactInt(src, v))) {
          hit = src;
        }
      }
      return v;
    });
  } catch {
    return null; // not JSON — kept as a string, which is exact
  }
  return hit;
}

/** Whether the integer literal `src` reached JSON.parse as `v` UNCHANGED: `v`
 *  is that integer (not a neighbour) and prints back as `src` (what the wire,
 *  `am state` and every JSON consumer shows). Past ±2^53 plenty of integers
 *  are both — 2^53 itself, 10^20 — and `Number.isSafeInteger` refused them
 *  with "would reach the method as 9007199254740992, a different value",
 *  naming the very number typed. `-0` arrives as 0, the same number. */
function exactInt(src: string, v: number): boolean {
  if (Number.isSafeInteger(v)) return true;
  return String(v) === src && BigInt(v) === BigInt(src);
}

/** The refusal for a {@linkcode lossyNumberLiteral} hit. */
function lossyNumberRefusal(literal: string, type: string | undefined): string {
  const n = Number(literal);
  // Printed as the value it IS. `String(n)` is the shortest spelling that
  // parses back to `n`, which can be the literal itself (1152921504606847000
  // is really 2^60) — then only the exact digits show the difference.
  const became = !Number.isFinite(n)
    ? "null"
    : String(n) === literal
    ? `${BigInt(n)}`
    : String(n);
  return `${literal} is a number JSON cannot hold exactly — it would reach ` +
    `the method as ${became}, a different value, under ok.\n` +
    `  to send it as text (an id, an account number): ` +
    `am dispatch ${type ?? "<cell:method>"} '"${literal}"'  (or ` +
    `--args='["${literal}"]')\n` +
    `  every integer up to ±${Number.MAX_SAFE_INTEGER} is exact`;
}

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

/** The one line worth adding when a dispatch that used `--args` fails.
 *
 *  `--args` is the argument LIST: `--args='["a","b"]'` passes two arguments,
 *  and a method taking a single array wants `--args='[["a","b"]]'`. Both are
 *  legal, so this is never a refusal — the CLI cannot know which was meant. It
 *  is offered only when the app has ALREADY refused the call, where the reader
 *  is looking for a reason and the app's own message (about a value its author
 *  never knowingly passed) does not point at the command line.
 *
 *  Silent when `--args` was not used, and when the list is empty: there is no
 *  other reading of nothing. */
export function argsShapeHint(
  jsonArgs: string | undefined,
  action: unknown,
): string | undefined {
  if (jsonArgs === undefined) return undefined;
  const sent =
    ((action as { payload?: { args?: unknown[] } } | null)?.payload?.args) ??
      [];
  if (!Array.isArray(sent) || sent.length === 0) return undefined;
  const one = JSON.stringify(sent);
  const n = sent.length;
  return `--args is the ARGUMENT LIST: this sent ${n} argument${
    n === 1 ? "" : "s"
  }. ` +
    `If the method takes a SINGLE array, wrap it — --args='[${one}]'`;
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

  // `@path` / `-` → the value itself, before anything reads it. A copy of the
  // flags, so the hint below (`argsShapeHint`) sees the JSON actually sent.
  for (
    const [k, flag] of [["jsonArgs", "--args"], ["jsonBody", "--body"]] as const
  ) {
    const r = await readFlagPayload(flags[k], flag);
    if (!r.ok) {
      outError(r.error, mode);
      Deno.exit(1);
      return;
    }
    if (r.value !== flags[k]) flags = { ...flags, [k]: r.value };
  }
  // Every value below is auto-parsed as JSON, and JSON.parse ROUNDS a number
  // it cannot hold: `am dispatch bot:setChannel 1234567890123456789` stored
  // 1234567890123456800 under {"ok":true}. Refused here, on the raw text,
  // while the literal the person typed still exists to be named.
  {
    const named = args.slice(1).some(isNamedArg);
    const texts = [
      flags.jsonArgs,
      flags.jsonBody,
      // Named form: only a pair's VALUE is parsed (a bare word there is a
      // `true` flag, never JSON). Positional form: every argument.
      ...args.slice(1).map((a) =>
        !named ? a : isNamedArg(a) ? a.slice(a.indexOf("=") + 1) : undefined
      ),
    ];
    for (const t of texts) {
      const lossy = t === undefined ? null : lossyNumberLiteral(t);
      if (lossy !== null) {
        outError(lossyNumberRefusal(lossy, args[0]), mode);
        Deno.exit(1);
      }
    }
  }
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
    if (body !== null && typeof body === "object" && args.length > 0) {
      // An ARRAY body used to fall through this branch untouched, so
      // `--body='["x"]'` posted a bare array as the whole action — no `type`,
      // refused at the far end for a reason that named nothing the caller had
      // typed. It is the same question `--args` answers, so it gets the same
      // answer: for a cell method, an array IS the argument list.
      action = { type: args[0], payload: envelopeJsonPayload(args[0]!, body) };
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
      // If any arg is `key=value` → action-style named payload: { key: val }
      // Otherwise → method-style positional args: { args: [...] }
      const hasNamedArgs = rest.some(isNamedArg);
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
        const refusal = argsFlagAsPositional(type!, rest, parsed);
        if (refusal) {
          outError(refusal, mode);
          Deno.exit(1);
        }
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
    // A method that threw on the arguments it was handed gets ONE extra line,
    // and only then. `--args` is the ARGUMENT LIST, so `--args='["a","b"]'`
    // passes two arguments — and the thing people mean is usually one array.
    // The app then throws about a value its author never knowingly passed
    // (`v.startsWith is not a function`, report 3 §4), and nothing in that
    // message points back at the command line. The CLI cannot tell which
    // reading was meant — both are legal — but it knows it just sent N
    // arguments, and it can say the other reading exists.
    outError(result.error, mode, argsShapeHint(flags.jsonArgs, action));
    Deno.exit(1);
  }
  const data = result.data as {
    result?: unknown;
    resultDropped?: boolean;
    unsaved?: string | null;
    short?: string;
  };
  // `ok: true` means APPLIED — the method ran, the commit is broadcast — and
  // says nothing about the disk: the write reaches SQLite with the next
  // persist window, by design (a flush per CLI call would be a second write
  // pattern nobody asked for). What CAN be said without forcing anything is
  // whether the write path is refusing right now — the last cycle's verdict,
  // the one `/__aio/health` and `am stop` already speak — and saying nothing
  // there is how an agent reads `{"ok":true}` as "on disk" while every write
  // since some poisoned field is in RAM only.
  // The reply carries the verdict itself when the server is new enough to
  // send it (`unsaved`: a refusal, or `null` for "consulted, none"); an older
  // server says nothing, and then health is asked — one extra request, never
  // a wrong answer.
  const unsaved = "unsaved" in data
    ? (typeof data.unsaved === "string" ? data.unsaved : null)
    : await persistRefusal(port, appId);
  const notSaved = unsaved ? `\n  ⚠ NOT SAVED — ${unsaved}` : "";
  // The call RAN with arguments missing. The framework has always known — it
  // warns at `methodArgs` — and has always said it into the SERVER LOG, while
  // this command printed a clean "dispatched" to the person who made the call.
  // An agent driving a live app never reads that log. Measured shape:
  // `am dispatch todo:add` for `add(s, text)` wrote a row whose declared field
  // was simply gone, under `{"ok":true}`.
  const short = typeof data?.short === "string" ? `\n  ⚠ ${data.short}` : "";
  if (mode === "pretty") {
    const label = flags.asServer ? "dispatched (as server)" : "dispatched";
    if (data?.resultDropped) {
      out(
        `${label} — the method returned a value JSON cannot carry${notSaved}${short}`,
        mode,
      );
    } else if (data && "result" in data) {
      // The RETURN VALUE, in the house style rather than as raw JSON with
      // braces and quotes. `--json` still carries it verbatim — this is the
      // human branch, and a method that returns a record is exactly the case
      // an aligned `label  value` block reads better than `{ "a": 1 }`.
      // DATA: the method's return value is the app's text (a ZWJ, an RLM, its
      // own colours are the data), so the data sink, not the message one.
      outData(
        { message: label, result: data.result },
        mode,
        () =>
          (typeof data.result === "object" && data.result !== null
            ? stack(style.dim(label), describe(data.result))
            : `${style.dim(label)} ${String(data.result)}`) + notSaved + short,
      );
    } else out(label + notSaved + short, mode);
  } else {
    // Additive: the reply object verbatim, plus `unsaved` only when there is
    // a refusal to carry — a healthy app's `am dispatch --json` is byte-for-
    // byte what it was.
    out(
      unsaved && data && typeof data === "object"
        ? { ...data, unsaved }
        : result.data,
      mode,
    );
  }
}

/** Is this app's persistence REFUSING writes right now?
 *
 *  The verdict of the most recent persist cycle, read from `/__aio/health`
 *  (`persist: { ok, error }`) — the same `lastCycleError()` that `am persist`
 *  rejects on and `am stop` exits 1 for — worded the way the trojan words it
 *  (`persist failed: …`, see `PERSIST_REFUSED` in server-trojan.ts) so the
 *  NOT SAVED line reads the same at every door. Asked WITHOUT forcing a
 *  flush: a dispatch is acked when it is applied, and this must not turn it
 *  into something else. `null` when the write path is fine, and when the
 *  question could not be put (no health route, a transport that is gone): "I
 *  could not ask" is not data loss and is never reported as it. */
async function persistRefusal(
  port: number,
  appId: string,
): Promise<string | null> {
  const r = await httpGet(port, "/__aio/health", appId);
  if (!r.ok) return null;
  type Health = { persist?: { ok?: boolean; error?: string } };
  let health: Health | null = null;
  try {
    health = JSON.parse(r.data) as Health;
  } catch {
    // aio-ok: not an aio health document — the dispatch already succeeded
    // against this port, so this is "could not ask", not a verdict.
  }
  return health?.persist?.ok === false
    ? `persist failed: ${health.persist.error ?? "(no reason given)"}`
    : null;
}

export async function cmdActions(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  // `am actions 50` is the documented spelling (docs/clients/app-manager.md)
  // and `--lines=50` the one every other listing verb takes; both were
  // accepted and ignored. Either one, never both, and never a word that is
  // not a count.
  const mode = detectMode(flags);
  if (args.length > 1 || (args.length === 1 && flags.lines !== undefined)) {
    outError(
      `am actions takes one count — am actions 50, or am actions --lines=50`,
      mode,
    );
    Deno.exit(1);
  }
  let lines = flags.lines;
  if (args.length === 1) {
    const n = parseNumArg(args[0], "am actions <count>", {
      min: 1,
      integer: true,
    });
    if (!n.ok) {
      outError(n.error, mode);
      Deno.exit(1);
    }
    lines = n.value;
  }
  if (lines === undefined) {
    await runTrojanGet(amCtx(flags), "history");
    return;
  }
  const ctx = amCtx(flags);
  const r = await trojanGet(ctx.port, "history", ctx.appId);
  if (!r.ok) {
    outError(r.error, ctx.mode);
    Deno.exit(1);
  }
  outValue(lastHistoryEntries(r.data, lines), ctx.mode);
}

/** `am actions --lines=N`: the NEWEST N entries — the same meaning `--lines`
 *  has on `timeline`, `logs` and `errors`. It was accepted and ignored, so the
 *  whole 2000-entry window printed. `index` stays what the app reports (a
 *  position in the FULL history, which `total` now states) — entries carry
 *  their own `id`, and ids are what `am timetravel goto` takes. */
export function lastHistoryEntries(data: unknown, n: number): unknown {
  const h = data as { entries?: unknown[] } | null;
  if (!h || !Array.isArray(h.entries)) return data;
  return {
    ...h,
    entries: h.entries.slice(-n),
    shown: Math.min(n, h.entries.length),
    total: h.entries.length,
  };
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
  // The subcommand set is CLOSED and printed in the usage line — and an
  // unknown one answered `{"ok":true}` and did nothing, because the trojan
  // route acks any `cmd` string. `am tt puase` reported success and left the
  // app paused=false; the trojan-dispatch route two functions away refuses an
  // unknown method precisely because "ok:true must mean EXECUTED".
  const TT_COMMANDS = ["undo", "redo", "goto", "pause", "resume"];
  if (!TT_COMMANDS.includes(cmd)) {
    outError(
      `am timetravel: unknown subcommand "${cmd}" — ${
        TT_COMMANDS.join(", ")
      }. It would have been acknowledged and done nothing.`,
      mode,
    );
    Deno.exit(1);
  }
  const arg = cmd === "goto" ? Number(args[1]) : undefined;
  if (cmd === "goto" && (arg === undefined || isNaN(arg))) {
    outError("usage: am tt goto <index>", mode);
    Deno.exit(1);
  }
  if (cmd === "goto" && (!Number.isInteger(arg) || (arg as number) < 0)) {
    outError(
      // `am tt` was REMOVED in alpha70 and the CLI refuses it by name, so a
      // message that leads with it hands the reader a command that answers
      // "`am tt` is spelled `am timetravel` now" — an error inside an error.
      `am timetravel goto: ${args[1]} is not a history id — ids are whole ` +
        `numbers ` +
        `from 0, and \`am actions\` lists the ones this app holds. They are ` +
        `IDS, not positions in that list: the window rolls and \`resume\` ` +
        `truncates, so the two stop matching after any real session. (A ` +
        `number matching no entry used to answer ok:true and leave the app ` +
        `exactly where it was — the server refuses it now.)`,
      mode,
    );
    Deno.exit(1);
  }
  const before = await trojanGet(port, "history", appId);
  const result = await trojanPost(port, "tt", { cmd, arg }, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  const after = await trojanGet(port, "history", appId);
  const verdict = before.ok && after.ok
    ? ttMoved(cmd, before.data, after.data)
    : null;
  out(
    mode === "pretty"
      ? `tt: ${cmd}${arg !== undefined ? " " + arg : ""}` +
        (verdict && !verdict.moved ? ` — nothing moved: ${verdict.note}` : "")
      : verdict
      ? {
        ...(result.data as Record<string, unknown>),
        moved: verdict.moved,
        ...(verdict.moved ? {} : { note: verdict.note }),
      }
      : result.data,
    mode,
  );
}

/** Did a time-travel command change anything? Compared on the app's own
 *  history before and after, so the answer is what happened rather than a
 *  prediction of it.
 *
 *  `undo` at the oldest entry and `redo` at the newest are no-ops by design
 *  (`time-travel.ts`), and the route answered `{"ok":true}` for both — a loop
 *  of `am timetravel undo` "succeeded" forever at index 0. The exit stays 0
 *  (being at the end of history is not an error) and `ok` keeps its meaning
 *  ("the command was accepted"); `moved` and `note` are added beside it. */
export function ttMoved(
  cmd: string,
  before: unknown,
  after: unknown,
): { moved: boolean; note: string } {
  type H = { entries?: unknown[]; index?: number; paused?: boolean };
  const b = (before ?? {}) as H, a = (after ?? {}) as H;
  const moved = b.index !== a.index || b.paused !== a.paused ||
    (b.entries?.length ?? 0) !== (a.entries?.length ?? 0);
  if (moved) return { moved, note: "" };
  const total = a.entries?.length ?? 0;
  const note = total === 0
    ? "the history is empty"
    : cmd === "undo"
    ? `already at the oldest entry (index ${a.index}) — nothing to undo`
    : cmd === "redo"
    ? `already at the newest entry (index ${a.index}) — nothing to redo`
    : cmd === "pause"
    ? "already paused"
    : cmd === "resume"
    ? "not paused — nothing to resume"
    : `already at that entry (index ${a.index})`;
  return { moved, note };
}

// ── Persistence ─────────────────────────────────────────────

/** `am migrations` — declared vs stored per-cell versions, what the last boot's
 *  migration pass did, and any unaccounted shape drift. */
export async function cmdMigrations(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  // A RUNNING app answers this. The app most likely to be asked about is the
  // one a dev boot just REFUSED over shape drift — which is not running, so
  // the bare "does not know which app to target" read as a wrong app name.
  const offline = (why: string, mode: ReturnType<typeof detectMode>) => {
    outError(
      `${why} — \`am migrations\` needs a running app. A dev boot that ` +
        `refused over shape drift ("persist: REFUSING to boot") already ` +
        `printed the same picture: the drifted fields per cell and the way out.`,
      mode,
    );
    Deno.exit(1);
  };
  let ctx: ReturnType<typeof amCtx>;
  try {
    ctx = amCtx(flags);
  } catch (e) {
    return offline(
      e instanceof Error ? e.message : String(e),
      detectMode(flags),
    );
  }
  const r = await trojanGet(ctx.port, "migrations", ctx.appId);
  if (!r.ok) {
    outError(r.error, ctx.mode);
    Deno.exit(1);
  }
  if (ctx.mode !== "pretty") {
    outValue(r.data, ctx.mode);
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
    // A DATA document for a script — byte-true (see sayData).
    sayData(
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data),
    );
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
    // A snapshot REPLACES the whole state. The app refuses one whose cell set
    // does not match its own (loading another app's file used to wipe every
    // cell and exit 0); `--force` is how an operator says they meant it.
    const result = await trojanPost(
      port,
      flags.force ? "snapshot/force" : "snapshot",
      JSON.parse(json),
      appId,
    );
    if (!result.ok) {
      outError(result.error, mode);
      Deno.exit(1);
    }
    // The route closes the persist window before it answers, and a refused
    // write rides back as `unsaved` — the restore IS in memory and on every
    // screen, so the reply is not an error, but "loaded" over a store that
    // still holds the pre-restore rows is the alpha76 shape exactly. Same
    // field, same line, same exit code as `am stop`.
    const unsaved = (result.data as { unsaved?: string } | null)?.unsaved;
    out(
      mode === "pretty"
        ? `loaded from ${file}` +
          (unsaved ? `\n  ⚠ NOT SAVED — ${unsaved}` : "")
        : { file, status: "loaded", ...(unsaved ? { unsaved } : {}) },
      mode,
    );
    if (unsaved) Deno.exit(1);
    return;
  }

  outError("usage: am snapshot [save <file>|load <file>]", mode);
  Deno.exit(1);
}
