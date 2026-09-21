// Cell composition wiring — extracts composition logic from run()
import {
  type CellEntry,
  type CircuitBreakerConfig,
  composeCells,
  type ComposedCells,
} from "../state/cell.ts";
import { isRefusableCredential, looksSecret } from "../state/secret-names.ts";
import { forUserView } from "../state/cell-reactive.ts";
import {
  applyCellFieldFilter,
  type CellPatchStrategy,
  type PatchFilterFields,
} from "../state/state-filter.ts";
import type {
  Access,
  AccessUser,
  CellDef,
  CellFieldFilter,
} from "../state/cell-types.ts";
import type { AioError, ReportErrorOpts } from "../diagnostics/error.ts";
import { reportError as reportAioError } from "../diagnostics/error.ts";
import { log } from "../diagnostics/logger-api.ts";
import { parseCli } from "./aio-cli.ts";
import { isCompiled } from "./paths.ts";
import { validateWorkerCells } from "./cell-worker-pool.ts";
import { type PerfCheck, perfCheckOn } from "../state/dispatch.ts";
import {
  applyCellDefaults,
  applyLocalFirst,
  type CellDefaults,
  refuseFilteredSyncCells,
} from "../state/cell-defaults.ts";

/** User identity shape — matches AioUser without importing from aio.ts (avoids circular) */
type User = { id: string; role: string };

/** Inputs for cell composition — subset of CellsConfig relevant to wiring */
export type ComposeCellsInput = {
  cellEntries: CellEntry[];
  /** `visible` (alpha52) takes full CellVisibility — forUser/publicFields are
   *  settable as app-wide defaults; `ui` is the deprecated alias. */
  cellDefaults?: CellDefaults;
  /** Local-first execution (perfect-aio D3) — see applyLocalFirst. */
  localFirst?: boolean;
  circuitBreaker?: CircuitBreakerConfig;
  perfCheck?: PerfCheck;
  /** Align the in-process caller with the wire on a refused write — see
   *  `ReduceContext.refusalsReject`. */
  refusalsReject?: boolean;
  /** The app identity — scopes cancellation across apps in one process. */
  appId?: string;
  onError?: (error: AioError) => void;
  beforeReduce?: (
    action: unknown,
    state: unknown,
    user?: User,
  ) => unknown | null;
  onRestore?: (state: unknown) => unknown;
};

/** One row in the per-cell visibility report logged at startup. */
export type VisibilityRow = {
  cell: string;
  ui: CellFieldFilter | "forUser";
  persist: CellFieldFilter;
  /** Who may CALL this cell's methods over the network. Reported beside `ui`
   *  because the two are read together and mean different things — `access`
   *  gates calls, `ui` gates what the broadcast carries. Seeing
   *  `access=admin ui=all` on one line is how an author notices that
   *  "admin-only" cell is readable by everyone. */
  access?: Access;
  /** Whether `ui` was actually DECIDED (by the cell or by cellDefaults).
   *  `ui` above reports `"all"` for both "explicitly everyone" and "never
   *  said"; a warning that cannot tell those apart nags the author who already
   *  answered, and a nagging warning gets muted wholesale. */
  uiDecided: boolean;
  /** Top-level state keys — what a warning has to name to be actionable. */
  fields: string[];
  /** Whether the cell is CRDT-replicated. A sync cell may not hide state at all
   *  (`refuseFilteredSyncCells` throws), so advice that says "add a ui filter"
   *  would send its author straight into a boot refusal. */
  syncs: boolean;
};

/** Everything produced by cell composition wiring */
export type ComposeCellsResult = {
  composed: ComposedCells;
  autoGetDBState: (s: unknown) => unknown;
  autoGetUIState: ((s: unknown, user?: unknown) => unknown) | undefined;
  cellPatchStrategies: Map<string, CellPatchStrategy>;
  cellFilterFields: Map<string, PatchFilterFields>;
  beforeReduce:
    | ((action: unknown, state: unknown, user?: User) => unknown | null)
    | undefined;
  onRestore: ((state: unknown) => unknown) | undefined;
  cellReportOpts: ReportErrorOpts;
  visibilityReport: VisibilityRow[];
};

/** Render a resolved filter as the short string used in the startup report. */
function renderFilter(filter: CellFieldFilter): string {
  if (filter === "all") return "all";
  if (filter === "none") return "none";
  if ("include" in filter) return `include(${filter.include.join(",")})`;
  if ("exclude" in filter) return `exclude(${filter.exclude.join(",")})`;
  return "all";
}

/** Dev-safety warnings for field-level visibility config:
 *  #1 an include/exclude key that isn't a top-level state field is a silent
 *     no-op — field filters only match top-level keys; nested/array fields need
 *     `ui.forUser`. This turns a silent secret leak into a loud warning.
 *  #2 a secret-looking top-level field left exposed to the UI is likely a leak. */
function warnFieldFilters(composed: ComposedCells): void {
  for (const f of composed.cells) {
    const state = (f.__aio.state ?? {}) as Record<string, unknown>;
    const topKeys = Object.keys(state);
    const topSet = new Set(topKeys);

    // #1 — filter keys that don't match any top-level field are ignored silently
    for (
      const [kind, filter] of [
        ["ui", f.__aio.ui],
        ["persist", f.__aio.persist],
      ] as const
    ) {
      if (!filter || filter === "all" || filter === "none") continue;
      const isInclude = "include" in filter;
      const keys = isInclude
        ? filter.include
        : "exclude" in filter
        ? filter.exclude
        : [];
      for (const key of keys) {
        if (key.includes(".")) {
          // Dot-paths: supported for exclude (deep removal, arrays traversed
          // element-wise); include stays a top-level allowlist.
          // NOT dead: `cell()` throws on a dotted include, but an app-level
          // `cellDefaults: { persist | visible: { include: ["a.b"] } }` is
          // copied onto each cell by applyCellDefaults without that check, and
          // this is the only place it is ever named.
          if (isInclude) {
            log.warn(
              "visibility",
              `[${f.__aio.id}] ${kind} include key "${key}" — include filters ` +
                `are top-level only (an allowlist). To hide a nested field, ` +
                `use exclude: ["${key}"] (deep removal) or visible.forUser.`,
            );
          } else if (!topSet.has(key.split(".")[0]!)) {
            log.warn(
              "visibility",
              `[${f.__aio.id}] ${kind} exclude path "${key}" — its head ` +
                `segment "${key.split(".")[0]}" is not a top-level field of ` +
                `the cell, so this excludes nothing. Typo?`,
            );
          }
        } else if (!topSet.has(key)) {
          log.warn(
            "visibility",
            `[${f.__aio.id}] ${kind} filter key "${key}" is not a top-level ` +
              `field of the cell, so this is silently ignored. For a nested ` +
              `field use a dot-path exclude (e.g. "items.${key}") or ` +
              `visible.forUser.`,
          );
        }
      }
    }

    // #2 — secret-looking field exposed to the UI (skip when forUser rewrites it)
    if (!f.__aio.uiForUser) {
      const ui = f.__aio.ui;
      const publicFields = new Set(f.__aio.uiPublicFields ?? []);
      // A container whose secret sub-path is already deep-excluded is handled —
      // warning about it would penalize the *correct* fix. Collect the
      // heads that have any dot-path exclude under them.
      const uiExcludes = ui && typeof ui === "object" && "exclude" in ui
        ? ui.exclude
        : [];
      // …and the exclude has to actually REMOVE something secret-looking.
      //
      // This asked only whether SOME exclude path starts with `key + "."`,
      // which made it a one-character escape hatch: `exclude:
      // ["apiKey.whatever"]` or even `["password."]` skipped the credential
      // check entirely — measured, both booted green with the credential
      // broadcast to every client, and not even the soft warning fired,
      // because the `continue` skips both tiers.
      //
      // Two conditions now. The excluded path must end at a segment that looks
      // secret (so it removes the thing the check is about), and `key` itself
      // must NOT be the credential — if `apiKey` IS the exposed field, no
      // sub-path under it can help, because the value is the secret.
      const deepExcludedHead = (key: string): boolean => {
        if (looksSecret(key) || isRefusableCredential(key)) return false;
        return uiExcludes.some((p) => {
          if (!p.startsWith(key + ".")) return false;
          const leaf = p.slice(p.lastIndexOf(".") + 1);
          return leaf !== "" &&
            (looksSecret(leaf) || isRefusableCredential(leaf));
        });
      };
      const isExposed = (key: string): boolean => {
        if (ui === "none") return false;
        if (!ui || ui === "all") return true;
        if ("include" in ui) return ui.include.includes(key);
        if ("exclude" in ui) return !ui.exclude.includes(key);
        return true;
      };
      // Use the SAME prod signal the rest of boot resolves to, not just the
      // raw `--prod` flag: a compiled binary auto-detects prod (aio.ts), so a
      // shipped release must take the prod path (log-and-continue) here too —
      // otherwise it would REFUSE to boot on this heuristic even though the
      // developer's `--prod` smoke test passed. `isCompiled()` covers the
      // shipped-binary case; a source run stays dev (dev-stricter is allowed).
      const isDev = !parseCli().prod && !isCompiled();
      // Collect ALL offending fields, then emit ONE paste-ready message per cell
      // (2026-07-24 Ugly #7) had to add six `publicFields` one
      // boot-refusal at a time because we threw on the first field. The snippets
      // below list every offending field so a single edit clears the whole cell.
      const hardKeys: string[] = []; // unambiguous credentials
      const softKeys: string[] = []; // secret-looking, ambiguous
      for (const key of topKeys) {
        // Explicit "this is public" acknowledgement, or its secret sub-paths are
        // already excluded → don't cry wolf at correctly-handled state.
        if (publicFields.has(key) || deepExcludedHead(key)) continue;
        if (!isExposed(key)) continue;
        // AIO-426: an unambiguous credential broadcast to every
        // client is a real leak, not a maybe. Guards (public-hint / metadata
        // suffix) still apply so `apiKeyName`, `publicKey` don't trip it.
        if (isRefusableCredential(key)) hardKeys.push(key);
        else if (looksSecret(key)) softKeys.push(key);
      }
      const list = (ks: string[]) => `[${ks.map((k) => `"${k}"`).join(", ")}]`;
      // Soft warnings first (non-blocking) so they're still visible if the hard
      // refusal below aborts boot.
      if (softKeys.length) {
        const one = softKeys.length === 1;
        log.warn(
          "visibility",
          `[${f.__aio.id}] ${one ? "field" : "fields"} ${list(softKeys)} ${
            one ? "looks" : "look"
          } secret and ${
            one ? "is" : "are"
          } exposed to the UI — broadcast to every connected client. Restrict ` +
            `${one ? "it" : "them"}: visible: { exclude: ${
              list(softKeys)
            } } (or a ` +
            `nested visible.exclude of the secret sub-path, visible.forUser, or visible: "none"). ` +
            `If genuinely public, declare ${one ? "it" : "them"}: ` +
            `visible: { publicFields: ${list(softKeys)} }.`,
        );
      }
      if (hardKeys.length) {
        const one = hardKeys.length === 1;
        const msg =
          `[${f.__aio.id}] ${one ? "field" : "fields"} ${list(hardKeys)} ${
            one ? "is a credential" : "are credentials"
          } exposed to the UI — broadcast to every connected client. Hide ${
            one ? "it" : "them"
          }: visible: { exclude: ${
            list(hardKeys)
          } } (or visible.forUser / visible: "none"). ` +
          `If genuinely NOT ${one ? "a secret" : "secrets"}, declare ${
            one ? "it" : "them"
          } public: visible: { publicFields: ${list(hardKeys)} }.`;
        // REFUSE to boot in dev (a warning is too soft — you can ship it); in
        // prod, log loud (don't crash a live deployment on a heuristic).
        if (isDev) {
          throw new Error(`[aio] SECURITY — refusing to start. ${msg}`);
        }
        log.error("visibility", `SECURITY: ${msg}`);
      }
    }
  }
}

/** The leaf segment of a (possibly dotted) filter path — `seeds.encSeed` is
 *  hidden because of `encSeed`, and that is the name to judge. */
function pathLeaf(p: string): string {
  return p.slice(p.lastIndexOf(".") + 1);
}

/** A name that says "a secret lives here" — the same two-tier rule the exposure
 *  heuristic reads, asked of a hidden field or of a method. */
function secretShaped(name: string): boolean {
  return looksSecret(name) || isRefusableCredential(name);
}

/** A METHOD name that turns a hidden cell into an ORACLE: one that performs a
 *  privileged operation on a caller's behalf and hands the result back.
 *
 *  Field names and method names are not the same question, and reading them
 *  with one rule left the sharp half uncovered: `looksSecret` matched
 *  `encrypt` (a noun-ish name that also reads as a field) and missed `decrypt`
 *  and `sign` — the two that make an oracle. Encrypting on request leaks
 *  little; DECRYPTING on request is the whole attack, and signing on request
 *  is the wallet version of it.
 *
 *  Verbs only, and anchored, because the cry-wolf risk here is entirely about
 *  ordinary words: `signIn`, `signUp`, `signOut`, `signal`, `assign`,
 *  `design`, `resign` and `cosign` are all common method names that contain
 *  "sign" and mean nothing of the sort. This is one condition of three (no
 *  `access`, at least one callable method, a name that says a secret is
 *  involved), so a false positive here still needs the other two to speak. */
function oracleVerb(name: string): boolean {
  const n = name.toLowerCase();
  // `sign` only where it is the operation: the whole name, or followed by a
  // capital in the original (`signTx`, `signMessage`) — never `signIn`,
  // `signUp`, `signOut`, and never as a fragment of another word.
  if (/^sign(?:in|up|out|al|ature)?$/.test(n)) return n === "sign";
  if (/^sign[A-Z]/.test(name)) return true;
  return /^(?:de|un)(?:crypt|seal|lock|wrap|obfuscate)/.test(n) ||
    /^(?:derive|reveal|unseal|unlock|unwrap)/.test(n) ||
    /^export(?:key|secret|seed|mnemonic|private)/.test(n);
}

/** #3 — this cell HIDES state and gates no CALLS.
 *
 *  `visible` gates READS; `access` gates CALLS; neither implies the other. An
 *  audit of an app that holds keys measured what reading one as both costs: a
 *  cell with `visible: "none"` still has every method callable by any connected
 *  client, with the return value travelling back, so a PBKDF2
 *  `encrypt`/`decrypt` cell shipped as a decryption oracle and an unmetered
 *  passphrase oracle — sitting next to a carefully maintained `visible.exclude`
 *  list that existed to prevent exactly that. The author believed one key did
 *  both jobs, and nothing in the framework said otherwise.
 *
 *  A NOTICE, never a refusal: apps boot with this shape today, and "anyone may
 *  call, nobody may read" is a real design (a worker cell driven from the UI).
 *  Only the author can say which one this is — so it is said once, at boot, in
 *  dev and in prod alike (observe-only; a warning that only dev sees is a
 *  warning a packaged app never gets to print).
 *
 *  WHAT KEEPS IT FROM CRYING WOLF. Three conditions, each of which removes a
 *  whole class of honest cells:
 *  - `access` unset — declaring ANY rule (including `access: () => true`, "open
 *    on purpose") answers the question and silences this forever;
 *  - the cell has at least one callable method — a state-only cell has no door;
 *  - a NAME in the cell says a secret is involved: a hidden field's name, or a
 *    method's. The scratch-state pattern the docs recommend
 *    (`visible: { exclude: ["prevBytes"] }`) and a background worker cell
 *    (`visible: "none"` over a queue) never trip it, because nothing they hide
 *    or expose is secret-shaped. It reads the same two-tier name rule as the
 *    exposure heuristic, so `pubKey`, `seedId` and `lastLatencyMs` are quiet
 *    there and quiet here. */
function warnHiddenButCallable(composed: ComposedCells): void {
  for (const f of composed.cells) {
    const why = hiddenButCallableReason(f.__aio as HiddenCallableInput);
    if (why) log.warn("visibility", why);
  }
}

/** What a cell must look like for the notice to have an opinion. Structural,
 *  so a test can state the shape without booting a runtime. @internal */
export type HiddenCallableInput = {
  id: string;
  access?: unknown;
  ui?: unknown;
  state?: unknown;
  actionKeys?: readonly string[];
};

/** The notice's whole decision, as a string or `null` — PURE.
 *
 *  Split out because the condition it turns on could not fire on the shape the
 *  feature was built for and nothing noticed: the loop above logged directly,
 *  so the only way to test the rule was to boot an app and read stderr, and
 *  nobody did. A predicate that returns its own reason is a predicate a test
 *  can ask. @internal */
export function hiddenButCallableReason(
  a: HiddenCallableInput,
): string | null {
  {
    // The call side was answered — whatever the answer is, it was a decision.
    if (a.access !== undefined) return null;
    const ui = a.ui as ComposedCells["cells"][number]["__aio"]["ui"];
    if (!ui || ui === "all") return null; // nothing hidden: a different warning
    const stateKeys = Object.keys((a.state ?? {}) as Record<string, unknown>);
    // What this cell's READ side takes away. `include` is an allowlist, so the
    // hidden set is its complement — the same hazard as an `exclude`, and the
    // reason it is not left out: `include: ["summary"]` over a state that also
    // holds `apiKey` hides the credential exactly as `exclude: ["apiKey"]` does.
    const hidden = ui === "none"
      ? stateKeys
      : "exclude" in ui
      ? ui.exclude.map(pathLeaf)
      : "include" in ui
      ? stateKeys.filter((k) => !ui.include.includes(k))
      : [];
    // An empty hidden set means "hides nothing" for a FILTER — `exclude: []`,
    // or an `include` that names every key — and for a bare `forUser`, which
    // is screened per client rather than structurally. It does NOT mean that
    // for `"none"`: that is a blanket over the whole cell, present state and
    // future, so a cell whose state happens to be empty today is still a cell
    // that hides everything.
    //
    // Skipping on `hidden.length === 0` therefore silenced this notice on the
    // EXACT shape it was written for: the audit's oracle cell — no state,
    // `visible: "none"`, and public `decrypt`/`sign` methods behind no
    // `access` rule. A gate that cannot fire on its own origin story is worse
    // than no gate, because the boot's silence reads as approval.
    if (ui !== "none" && hidden.length === 0) return null;
    // `__`-prefixed framework types are refused at every wire entry point
    // (protocol/action-gate.ts), so they are not a door.
    const callable = (a.actionKeys ?? []).filter((k) => !k.startsWith("__"));
    if (callable.length === 0) return null;
    // Two rules, because they are two questions: what the cell HIDES is a
    // field name, what it EXPOSES is an operation.
    const why = [
      ...hidden.filter(secretShaped),
      ...callable.filter((k) => secretShaped(k) || oracleVerb(k)),
    ];
    if (why.length === 0) return null;
    const one = callable.length === 1;
    return (`[${a.id}] this cell hides state (visible: ${
      ui === "none" ? '"none"' : renderFilter(ui as CellFieldFilter)
    }) but declares no \`access\` — its ${
      one ? "method" : `${callable.length} methods`
    } [${
      callable.map((k) => `"${k}"`).join(", ")
    }] stay callable by any connected client, and what they RETURN travels ` +
      `back. \`visible\` gates READS, \`access\` gates CALLS — neither ` +
      // Deliberately NOT the words the exposure heuristic uses ("looks
      // secret"): two different findings that read alike are two findings
      // nobody can tell apart — in a log, and in the tests that assert on one
      // of them.
      `implies the other. Flagged by NAME: ${
        why.map((k) => `"${k}"`).join(", ")
      } — a cell that hides nothing secret-shaped is never flagged. ` +
      `Decide the call side: access: false (server-side only), ` +
      `access: true (any authenticated caller), access: "admin" (a role), ` +
      `a predicate for row-level checks — or access: () => true to say ` +
      `"open on purpose" and silence this.`);
  }
}

/** How strong a declarative `access` rule is, as a total order over the shapes
 *  the framework can actually compare. Used ONLY to decide "is this rule at
 *  least as strong as that one" — never to decide a request. */
function _accessRank(rule: Access | undefined): number {
  if (rule === undefined) return 0; // no rule at all — any network caller
  if (rule === true) return 1; // any authenticated user
  if (rule === false) return 3; // server-side only, never from the network
  return 2; // an exact role, or a predicate
}

/** True when `owner` gates AT LEAST as tightly as `listener`. Equal-rank rules
 *  must be the SAME rule: `access: "editor"` is not `access: "admin"`, and two
 *  different predicates are not each other. Incomparable ⇒ not satisfied — a
 *  gate we cannot prove is a gate we do not have. */
function _gatesAtLeastAs(
  owner: Access | undefined,
  listener: Access | undefined,
): boolean {
  const [ro, rl] = [_accessRank(owner), _accessRank(listener)];
  if (ro > rl) return true;
  if (ro < rl) return false;
  return owner === listener;
}

/** THE compose-time check for access ESCALATION THROUGH `listensTo`.
 *
 *  The runtime gate (`dispatchNetwork` in aio-server.ts) evaluates the rule of
 *  the cell NAMED BY THE ACTION TYPE'S PREFIX. But an action is reduced by its
 *  owner AND by every cell that `listensTo` it — so a cell declaring
 *  `access: "admin"` that listens to an ungated cell's action was reduced, with
 *  the ungated cell's rule (none), whenever ANY client called that method. The
 *  author's strongest declaration was routed around by their own wiring. The
 *  same hole with the same shape swallowed BARE action types: the runtime gate
 *  only runs when the type contains a `:`, and a bare `"tick"` has no owning
 *  cell to gate at all.
 *
 *  It is checked HERE, once, at composition, rather than per request, because
 *  it is a property of the WIRING and not of any caller: both cells, both
 *  rules and the whole listener graph are known at boot, nothing about them
 *  changes later, and a design error caught at boot can never ship. That also
 *  means the runtime gate's `type.includes(":")` condition is SOUND rather than
 *  lucky — a bare type reaching a gated listener cannot get past this function.
 *
 *  Dev REFUSES to boot; prod logs it at error level. Same category as the
 *  credential-name gate above (dev stricter than prod, never the reverse): a
 *  framework upgrade must not kill a running deployment, but it must never let
 *  the hole ship out of a dev machine either. */
function refuseAccessEscalation(composed: ComposedCells): void {
  const byId = new Map(composed.cells.map((c) => [c.__aio.id, c]));
  const problems: string[] = [];
  for (const listener of composed.cells) {
    const rule = listener.__aio.access;
    if (rule === undefined) continue; // ungated cell — nothing to escalate to
    for (const type of listener.__aio.foreignActions) {
      const colon = type.indexOf(":");
      const ownerId = colon === -1 ? undefined : type.slice(0, colon);
      const owner = ownerId ? byId.get(ownerId) : undefined;
      if (_gatesAtLeastAs(owner?.__aio.access, rule)) continue;
      const shown = (r: Access | undefined) =>
        r === undefined
          ? "no access rule"
          : typeof r === "function"
          ? "access: <predicate>"
          : `access: ${JSON.stringify(r)}`;
      problems.push(
        `  "${listener.__aio.id}" (${shown(rule)}) listens to "${type}", ` +
          (owner
            ? `owned by "${owner.__aio.id}" (${shown(owner.__aio.access)})`
            : ownerId
            ? `whose cell "${ownerId}" is not booted here`
            : `a BARE action type no cell owns — nothing gates it`),
      );
    }
  }
  if (problems.length === 0) return;
  const msg = `access escalation through listensTo — a gated cell is reduced ` +
    `by an action that a LESS gated caller can dispatch, so its \`access\` ` +
    `rule is bypassed:\n${problems.join("\n")}\n\n` +
    `Fix (either one): give the action's source the same or a stronger ` +
    `\`access\` rule, so the caller is checked before the action exists at ` +
    `all — or drop the \`listensTo\` and have the gated cell expose its own ` +
    `method, which the runtime gate does check.`;
  // Dev is STRICTER (see the doc comment): refuse here, log loud in prod.
  if (!parseCli().prod && !isCompiled()) {
    throw new Error(`[aio] SECURITY — refusing to start. ${msg}`);
  }
  log.error("auth", `SECURITY: ${msg}`);
}

/** A selector may only depend on a cell that is actually booted. Throws here,
 *  at composition, so the author gets a clear error at boot rather than at
 *  first use. */
function refuseUnknownSelectorDeps(composed: ComposedCells): void {
  for (const f of composed.cells) {
    const deps = f.__aio.selectorDeps as Record<string, readonly string[]>;
    for (const [key, depList] of Object.entries(deps)) {
      for (const dep of depList) {
        if (!composed.cellNames.includes(dep)) {
          throw new Error(
            `[${f.__aio.id}] selector '${key}' depends on unknown cell '${dep}' — known cells: ${
              composed.cellNames.join(", ")
            }`,
          );
        }
      }
    }
  }
}

/** EVERY composition-time refusal + dev warning a real boot runs, in boot
 *  order — the single list, so there is one place that decides what a booting
 *  app is refused for.
 *
 *  It is exported because the in-process harnesses do NOT boot through
 *  `aio.run()`: `testUI`/`bootCells` compose the cells on the standalone
 *  runtime directly, so none of these ran there. An app whose cell exposes
 *  `apiKey` to the UI therefore went GREEN under the harness the docs push
 *  hardest and was REFUSED the moment it started — in dev AND in prod. Tests
 *  are the strictest environment, never the most permissive: the harness calls
 *  this (via `src/testing/test-strict.ts`) before it boots anything.
 *
 *  Takes an already-composed system rather than raw entries so the caller
 *  decides WHICH cells are in scope (the server drops client-scoped cells; the
 *  harness mirrors that) and nothing here re-derives composition. */
export function refuseUnsafeComposition(composed: ComposedCells): void {
  refuseFilteredSyncCells(composed);
  refuseAccessEscalation(composed);
  warnFieldFilters(composed);
  warnHiddenButCallable(composed);
  refuseUnknownSelectorDeps(composed);
}

/** Compose cells, apply defaults, build state filters + middleware chain */
export function composeCellsWiring(
  input: ComposeCellsInput,
): ComposeCellsResult {
  const cellReportOpts: ReportErrorOpts = { onError: input.onError };
  const perfEnabled = perfCheckOn(input.perfCheck);

  const defOf = (entry: unknown) =>
    (entry as { cell?: CellDef }).cell ?? (entry as CellDef);
  // Worker cells are validated BEFORE the client-scoped ones are dropped. The
  // pool validates only what reaches it, so `worker: true` + `scope: "client"`
  // — a combination `validateWorkerCells` refuses by name — was filtered out
  // below and booted without a word, while every harness (boot-refusals.ts)
  // refused it. The app must refuse what its tests refuse.
  validateWorkerCells(
    input.cellEntries.map(defOf).filter((d) => d?.__aio?.worker === true),
  );

  // AIO-5.1: client-scoped cells never register with the server store — one
  // `cells` array can hold both scopes; client cells are skipped here, not errored.
  const serverEntries = input.cellEntries.filter((entry) => {
    const def = defOf(entry);
    if (def.__aio?.scope === "client") {
      log.debug(`skipping client-scoped cell '${def.__aio.id}' on server`);
      return false;
    }
    return true;
  });

  const composed = composeCells(serverEntries, {
    onCellError: (err) => reportAioError(err, cellReportOpts),
    circuitBreaker: input.circuitBreaker,
    perfCheck: perfEnabled,
    appId: input.appId,
    refusalsReject: input.refusalsReject === true,
  });

  applyCellDefaults(composed, input.cellDefaults);
  applyLocalFirst(composed, input.localFirst === true);
  // AFTER defaults + local-first: both can change what a cell hides and whether
  // it syncs, so the contradiction is only decidable once they have run.
  // AIO-3.1: the whole refusal list, shared with the in-process harnesses so a
  // test cannot pass an app that boot refuses (see refuseUnsafeComposition).
  refuseUnsafeComposition(composed);
  const autoGetDBState = buildDBStateGetter(composed);
  const { autoGetUIState, cellPatchStrategies, cellFilterFields } =
    buildUIStateGetter(composed);
  const beforeReduce = input.beforeReduce;
  const onRestore = input.onRestore as
    | ((state: unknown) => unknown)
    | undefined;

  const visibilityReport = buildVisibilityReport(composed);
  logComposition(composed, visibilityReport);

  return {
    composed,
    autoGetDBState,
    autoGetUIState,
    cellPatchStrategies,
    cellFilterFields,
    beforeReduce,
    onRestore,
    cellReportOpts,
    visibilityReport,
  };
}

/** Build getDBState from per-cell persist filters.
 *  Default resolution: cell.persist > cellDefaults.persist > "all".
 *  Every cell always gets an entry; "all" persists the full slice, "none" is filtered out. */
function buildDBStateGetter(composed: ComposedCells): (s: unknown) => unknown {
  const cellPersistFilters = new Map<string, CellFieldFilter>();
  const cellPersistTransforms = new Map<
    string,
    (state: Record<string, unknown>) => Record<string, unknown>
  >();
  for (const f of composed.cells) {
    const resolved: CellFieldFilter = f.__aio.persist ?? "all";
    if (resolved !== "none") {
      cellPersistFilters.set(f.__aio.id, resolved);
      const t = f.__aio.persistTransform;
      if (t) cellPersistTransforms.set(f.__aio.id, t);
    }
  }
  return (s: unknown) => {
    const full = s as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [cellName, filter] of cellPersistFilters) {
      const cellState = full[cellName];
      if (!cellState || typeof cellState !== "object") continue;
      const filtered = applyCellFieldFilter(
        filter,
        cellState as Record<string, unknown>,
      );
      if (!filtered) continue;
      // `persist: { transform }` — the app SHAPES what goes to disk (report 9 §8.4).
      // AFTER include/exclude, so the two compose in the order they read.
      //
      // A THROW HERE IS NOT SWALLOWED. This runs on the persist path, and
      // "the write quietly stopped happening" is the worst outcome aio has:
      // the app keeps running on state that is not on disk. So the error is
      // re-thrown with the cell named, and the persistence layer's own
      // PERSIST_ERROR reporting carries it — the same treatment a failed
      // write gets, because it is the same failure.
      const transform = cellPersistTransforms.get(cellName);
      if (!transform) {
        result[cellName] = filtered;
        continue;
      }
      let shaped: Record<string, unknown>;
      try {
        shaped = transform(filtered);
      } catch (e) {
        throw new Error(
          `[cell:${cellName}] persist.transform threw — nothing was written ` +
            `for this cell. It runs on every persist cycle, so this will not ` +
            `resolve on its own.\n  cause: ${
              e instanceof Error ? e.message : String(e)
            }`,
          { cause: e },
        );
      }
      if (shaped === null || typeof shaped !== "object") {
        throw new Error(
          `[cell:${cellName}] persist.transform returned ${
            shaped === null ? "null" : typeof shaped
          } — it must return the OBJECT to write. Returning nothing would ` +
            `persist an empty cell, which restores as one.`,
        );
      }
      result[cellName] = shaped;
    }
    return result;
  };
}

type UiEntry = {
  filter: CellFieldFilter;
  forUser?: (
    exposed: Record<string, unknown>,
    user?: AccessUser,
  ) => Record<string, unknown>;
};

type UIStateResult = {
  autoGetUIState: ((s: unknown, user?: unknown) => unknown) | undefined;
  cellPatchStrategies: Map<string, CellPatchStrategy>;
  cellFilterFields: Map<string, PatchFilterFields>;
};

/** `visible.forUser`'s decision for one cell and one client — `forUserView`
 *  itself (the pure rule the harness's client view uses too, which also
 *  observes a REJECTING async filter's Promise). Shared by the broadcast and
 *  the headless render (server-surface.ts) so they cannot decide two ways. */
export function decideForUser(
  cellName: string,
  forUser: NonNullable<UiEntry["forUser"]>,
  structural: Record<string, unknown>,
  user: AccessUser | undefined,
  wholeCell = false,
): { view: Record<string, unknown> } | { omit: string } {
  return forUserView(cellName, forUser, structural, user, wholeCell);
}

/** Build getUIState from per-cell ui filters + patch strategy map (with memoization).
 *  Default resolution: cell.ui > cellDefaults.ui > "all".
 *  Every cell always gets a UiEntry; "all" exposes the full slice, "none" is filtered out. */
function buildUIStateGetter(composed: ComposedCells): UIStateResult {
  const cellPatchStrategies = new Map<string, CellPatchStrategy>();
  const cellFilterFields = new Map<string, PatchFilterFields>();
  const cellUiEntries = new Map<string, UiEntry>();

  for (const f of composed.cells) {
    const resolved: CellFieldFilter = f.__aio.ui ?? "all";
    // ORDER IS LOAD-BEARING: `uiForUser` outranks the "all" shortcut.
    //
    // `normalizeUiFilter` returns undefined for a `ui` with no
    // include/exclude (cell-helpers.ts), so `ui: { forUser }` ALONE resolved
    // to "all" and classified as `raw` — the `uiForUser` branch below was
    // unreachable without a structural filter beside it. Raw means Immer
    // patches computed from UNFILTERED server state go to every client,
    // subscription-filtered only (server-broadcast.ts): the per-user filter
    // guarded the full-state frame and nothing else.
    //
    // That is a privacy hole AND a corruption bug — raw ops carry raw ARRAY
    // INDICES, but the client's array was shortened by forUser, so patches
    // land at the wrong index (a field report: "one field reflected the
    // filter, another was stale"; the author added a nine-field `include`
    // purely to force this classification).
    //
    // `forUser` states the intent unambiguously and "full" implements it
    // exactly — which is what docs/state/cell-visibility.md has always
    // documented. `"none"` still wins: an invisible cell stays invisible.
    if (resolved === "none") {
      cellPatchStrategies.set(f.__aio.id, "skip");
    } else if (f.__aio.uiForUser) {
      cellPatchStrategies.set(f.__aio.id, "full");
    } else if (resolved === "all") {
      cellPatchStrategies.set(f.__aio.id, "raw");
    } else {
      cellPatchStrategies.set(f.__aio.id, "filter");
      if ("include" in resolved) {
        // Split exactly as `exclude` is split below — a dot path is a DEEP
        // rule on both sides, and holding `"profile.name"` in `fields` (which
        // the patch filter compares against a single path SEGMENT) meant no
        // patch for that cell ever matched. See `deepIncludes`.
        const plain = resolved.include.filter((k) => !k.includes("."));
        const deep = resolved.include
          .filter((k) => k.includes("."))
          .map((k) => k.split("."));
        cellFilterFields.set(f.__aio.id, {
          mode: "include",
          fields: new Set(plain),
          ...(deep.length > 0 ? { deepIncludes: deep } : {}),
        });
      } else if ("exclude" in resolved) {
        const plain = resolved.exclude.filter((k) => !k.includes("."));
        const deep = resolved.exclude
          .filter((k) => k.includes("."))
          .map((k) => k.split("."));
        cellFilterFields.set(f.__aio.id, {
          mode: "exclude",
          fields: new Set(plain),
          ...(deep.length > 0 ? { deepExcludes: deep } : {}),
        });
      }
    }
    cellUiEntries.set(f.__aio.id, {
      filter: resolved,
      forUser: f.__aio.uiForUser,
    });
  }

  // Memoization state — closure-captured, preserved across calls
  let _structCache: Record<string, unknown> | null = null;
  let _structStateRef: unknown = null;

  const getStructural = (s: unknown): Record<string, unknown> => {
    if (s === _structStateRef && _structCache) return _structCache;
    _structStateRef = s;
    const full = s as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [cellName, entry] of cellUiEntries) {
      const cellState = full[cellName];
      if (!cellState || typeof cellState !== "object") continue;
      const filtered = applyCellFieldFilter(
        entry.filter,
        cellState as Record<string, unknown>,
      );
      if (filtered) result[cellName] = filtered;
    }
    _structCache = result;
    return result;
  };

  const hasForUser = [...cellUiEntries.values()].some((e) => e.forUser);
  let autoGetUIState: (s: unknown, user?: unknown) => unknown;

  if (hasForUser) {
    autoGetUIState = (s: unknown, user?: unknown) => {
      const structural = getStructural(s);
      const result: Record<string, unknown> = { ...structural };
      for (const [cellName, entry] of cellUiEntries) {
        if (!entry.forUser || !result[cellName]) continue;
        // FAIL CLOSED, by the one spelling of the rule (`forUserView`): a
        // filter that throws, returns a Promise, or returns a non-object has
        // decided nothing, so this client gets NOTHING for the cell — never
        // the pre-filter value. With `visible: { forUser }` alone that value is
        // the WHOLE CELL, so the old "structural fallback" broadcast every
        // user's data to whoever tripped the throw. Omitting is never more
        // than the filter would have returned, and one broken filter must not
        // mute the rest of the app (server-broadcast.ts drops the whole frame
        // only when getUIState itself throws).
        const out = decideForUser(
          cellName,
          entry.forUser,
          result[cellName] as Record<string, unknown>,
          user as AccessUser | undefined,
          entry.filter === "all",
        );
        if ("view" in out) {
          result[cellName] = out.view;
        } else {
          delete result[cellName];
          log.error(out.omit);
        }
      }
      return result;
    };
  } else {
    autoGetUIState = (s: unknown) => getStructural(s);
  }

  return { autoGetUIState, cellPatchStrategies, cellFilterFields };
}

/** Build the per-cell visibility report — one row per cell with resolved ui/persist filters. */
function buildVisibilityReport(composed: ComposedCells): VisibilityRow[] {
  const rows: VisibilityRow[] = [];
  for (const f of composed.cells) {
    // "none" outranks forUser, exactly as the strategy does: an invisible
    // cell sends nothing, so reporting "forUser" would claim a filter is
    // doing work on a wire that carries no data at all. The report is the one
    // place an author checks that their filter is in force — it must never
    // name a filter the broadcast path is not applying.
    const ui = f.__aio.ui ?? "all";
    const uiResolved: CellFieldFilter | "forUser" = ui === "none"
      ? "none"
      : f.__aio.uiForUser
      ? "forUser"
      : ui;
    rows.push({
      cell: f.__aio.id,
      ui: uiResolved,
      persist: f.__aio.persist ?? "all",
      access: f.__aio.access,
      uiDecided: f.__aio.ui !== undefined || !!f.__aio.uiForUser,
      fields: Object.keys(
        (f.__aio.state ?? {}) as Record<string, unknown>,
      ),
      syncs: !!f.__aio.syncConfig,
    });
  }
  return rows;
}

/** Log cell composition info */
function logComposition(
  composed: ComposedCells,
  report: VisibilityRow[],
): void {
  log.info(`cells: ${composed.cellNames.join(", ")}`);
  for (const row of report) {
    const uiStr = row.ui === "forUser" ? "forUser" : renderFilter(row.ui);
    const accStr = row.access === undefined
      ? ""
      : ` access=${
        typeof row.access === "function" ? "predicate" : String(row.access)
      }`;
    log.info(
      `cells: ${row.cell}${accStr} visible=${uiStr} persist=${
        renderFilter(row.persist)
      }`,
    );
  }
  for (const f of composed.cells) {
    if (f.__aio.foreignActions.length) {
      for (const fa of f.__aio.foreignActions) {
        log.info(`${f.__aio.id}: listens to ${fa}`);
      }
    }
  }
}
