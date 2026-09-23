// cell-methods-internals.ts — machine, reducer, and executor builders for methods-based cells

import { eventArgWarning } from "./event-arg.ts";
import { isScheduleEffect, type ScheduleEffect } from "./schedule.ts";
import { trackCall, trackPending } from "./method-cancel.ts";
import { _isTTPausedRefusal, markInflight } from "./dispatch.ts";
import { isOwnEffect, type OwnEffect } from "./own.ts";
import { isNotifyEffect } from "./notify.ts";
import type { AsyncMethod, Method, Mutation, SyncMethod } from "./cell-impl.ts";
import {
  applyMutations,
  conflictPath,
  createBatcher,
  createLiveProxy,
  createReadWatch,
  resolveCall,
  setKey,
  snapshotForRead,
} from "./cell-impl.ts";
import {
  type CellExecuteFn,
  type CellReduceFn,
  markReturn,
  type Msg,
  type ScopedApp,
} from "./cell-types.ts";
import { resolveSelfAction } from "./self.ts";
import { inServerOrigin } from "./call-origin.ts";
import { materializeValue, withDraftDo } from "./cell-impl.ts";
import { current, type Draft, isDraft } from "immer";
import { type AioError, createAioError } from "../diagnostics/error.ts";
import { log } from "../diagnostics/logger-api.ts";
import { refuseRetired, removalOf, removalsAreFatal } from "./removals-core.ts";
import {
  buildCallTable,
  unwrapCallView,
  withUnknownCallRefusal,
} from "./cell-call.ts";
import { type ArgSpec, validateMethodArgs } from "./arg-schema.ts";
import {
  beginPolicyCall,
  type ConcurrencyMode,
  createPolicyStore,
  setQueueTail,
} from "./method-policy.ts";
import { isDeliberateRejection, rejectionLine } from "./method-rejection.ts";

// ── The effect channel: s.$do (alpha52) ────────────────────────────────

type Effect = ScheduleEffect | OwnEffect;

/** Prod-only throttle for the retired return-effects channel: the refusal is
 *  per CALL, not per boot, so an app that returns an effect in a loop would
 *  otherwise turn one mistake into a log flood. Dev throws every time. */
const _returnRefused = new Set<string>();
/** @internal test seam — re-arm the once-per-method prod refusal. */
export function _resetReturnEffectHints(): void {
  _returnRefused.clear();
}

/** Retired in alpha76: `return` carries VALUES, `s.$do(...)` carries effects.
 *  The two could never share the channel — a method that returned an effect
 *  resolved its caller with `undefined`, silently — so keeping it through beta
 *  would have frozen `return` out of ever carrying an effect-shaped value.
 *  Dev throws (the author is here); prod logs the registry line once per
 *  method and still runs the effects, so an upgraded app says so on every
 *  boot rather than silently dropping a timer. */
function refuseReturnedEffects(cellName: string, methodKey: string): void {
  const k = `${cellName}:${methodKey}`;
  if (!removalsAreFatal() && _returnRefused.has(k)) return;
  _returnRefused.add(k);
  refuseRetired(
    removalOf("return effect(s) from a method"),
    `${cellName}.${methodKey}`,
  );
}

function describeNonEffect(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  const t = typeof v;
  if (t === "object") {
    const type = (v as { type?: unknown }).type;
    return typeof type === "string"
      ? `an object with type "${type}"`
      : "an object";
  }
  return t === "function" ? "a function" : `${t} ${JSON.stringify(v)}`;
}

/** Detach Immer drafts anywhere inside an effect (payloads referencing the
 *  method's `s` — `payload: { args: [s.items] }`). A draft is a Proxy, which
 *  structuredClone REFUSES, so an un-detached ref meant the effect was
 *  loudly dropped at the clone seam. `current()` snapshots the draft's value
 *  at capture time — exactly what the author meant. Untouched subtrees keep
 *  their identity (zero cost for the common plain-payload case). */
function detachDrafts(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  // deno-lint-ignore no-explicit-any
  if (isDraft(v)) return current(v as Draft<any>);
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < v.length; i++) {
      const m = detachDrafts(v[i]);
      if (m !== v[i] && out === null) out = v.slice();
      if (out !== null) out[i] = m;
    }
    return out ?? v;
  }
  let outObj: Record<string, unknown> | null = null;
  for (const k of Object.keys(v as Record<string, unknown>)) {
    const cur = (v as Record<string, unknown>)[k];
    const m = detachDrafts(cur);
    if (m !== cur && outObj === null) {
      outObj = { ...(v as object) } as Record<string, unknown>;
    }
    if (outObj !== null) outObj[k] = m;
  }
  return outObj ?? v;
}

/** Dev/test: refuse, at the `$do` call, an effect the effect seam cannot copy.
 *
 *  Every effect is structured-cloned on its way out of the reduce
 *  (cell-compose-reduce.ts `cloneEffects`), and one that cannot be — a
 *  function or a class instance in a scheduled action's payload — is logged
 *  at ERROR and DROPPED there. That is the right PROD answer (shipping a
 *  corrupted payload is worse), but it happens after the method has returned:
 *  the call resolved, the timer was never armed, and a test asserting on
 *  state stayed green. Tests are the strictest environment, so under
 *  `__aioDev` the same clone runs HERE, in the method's own stack, and the
 *  call fails naming the effect. Category (b): dev throws where prod degrades;
 *  the value handed on is unchanged either way. */
function refuseUncloneableEffect<T>(
  cellName: string,
  methodKey: string,
  eff: T,
): T {
  if ((globalThis as Record<string, unknown>).__aioDev !== true) return eff;
  try {
    structuredClone(eff);
  } catch (e) {
    const o = (eff ?? {}) as Record<string, unknown>;
    const named = [o.type, o.kind, o.id]
      .filter((x) => typeof x === "string")
      .join(" ");
    throw new Error(
      `[${cellName}] ${methodKey}(): s.$do(...) effect "${named || "?"}" ` +
        `cannot be structured-cloned, so it would be DROPPED when it leaves ` +
        `the method (prod logs and drops it; dev and tests refuse it here). ` +
        `Effects — and a scheduled action's payload — must be plain data: no ` +
        `functions, class instances or DOM nodes. Original: ${
          e instanceof Error ? e.message : String(e)
        }`,
    );
  }
  return eff;
}

/** Validate + self-resolve one `$do` argument — the shared gate for the sync
 *  collector and the async immediate-dispatch path. Throws loud on anything
 *  that is not a schedule/own effect. */
function toDoneEffect(
  cellName: string,
  methodKey: string,
  v: unknown,
  hasMethod: (m: string) => boolean,
  knownMethods: () => string[],
): Effect {
  if (!isScheduleEffect(v) && !isOwnEffect(v) && !isNotifyEffect(v)) {
    throw new Error(
      `[${cellName}] ${methodKey}(): s.$do(...) only takes effects ` +
        `(schedule.* / own.* / notify()) — got ${
          describeNonEffect(v)
        }. To run another ` +
        `method, call it directly (or schedule it: ` +
        `s.$do(schedule.next("id", self("method")))); to hand a value to the ` +
        `caller, just \`return\` it.`,
    );
  }
  // Resolve self("m") at the capture site — the only place the owning cell is
  // known — so an unknown method throws HERE, in the method's own stack.
  // The public union names two of the three framework effects; the third
  // rides the same channel (route-effect.ts decides) and cannot be named here
  // without reshaping a frozen type. Nothing below applies to it.
  if (isNotifyEffect(v)) return v as unknown as Effect;
  if (isScheduleEffect(v) && v.kind !== "cancel") {
    const action = resolveSelfAction(
      v.action,
      cellName,
      hasMethod,
      knownMethods,
    );
    if (action !== v.action) return { ...v, action };
  }
  return v;
}

// ── Machine builder ────────────────────────────────────────────────────

/** Build and clone the machine config for a methods-based cell.
 *  Auto-generates from listensTo, injects __setMethod/__error transitions for async methods. */
export function buildMethodsMachine(
  name: string,
  // deno-lint-ignore no-explicit-any
  config: any,
  methodNames: string[],
  asyncMethods: Set<string>,
  generatorNames: string[],
  explicitActionNames: string[],
  // deno-lint-ignore no-explicit-any
): any {
  let machine = config.machine === false || !config.machine
    ? false
    : config.machine;

  // Auto-generate machine from listensTo
  if (config.listensTo?.length && machine === false) {
    const on: Record<string, string> = {};
    for (const key of methodNames) on[key] = "active";
    for (const key of asyncMethods) on[setKey(key)] = "active";
    for (const key of generatorNames) on[key] = "active";
    for (const key of explicitActionNames) on[key] = "active";
    if (asyncMethods.size > 0) on["__error"] = "active";
    for (const entry of config.listensTo) {
      const actionType = typeof entry === "string" ? entry : entry.type;
      on[actionType] = "active";
    }
    machine = { initial: "active", states: { active: on } };
  }

  // Inject __setMethod and __error transitions for async methods.
  // Clone first — never mutate the user-provided config object.
  if (machine !== false) {
    const cloned = {
      ...machine,
      states: Object.fromEntries(
        Object.entries(machine.states).map(([k, v]: [string, unknown]) => [
          k,
          { ...(v as object) },
        ]),
      ),
    };
    for (
      const stateConfig of Object.values(cloned.states) as Record<
        string,
        unknown
      >[]
    ) {
      for (const [key, target] of Object.entries(stateConfig)) {
        if (key.includes(":") || !asyncMethods.has(key)) continue;
        if (typeof target === "function") {
          // AIO-380: function target — possible targets unknown statically.
          // Allow the method's writes in every state (consistent with "if the
          // method is allowed, its writes are allowed").
          for (
            const [sn, sc] of Object.entries(cloned.states) as [
              string,
              Record<string, unknown>,
            ][]
          ) {
            if (!(setKey(key) in sc)) sc[setKey(key)] = sn;
          }
        } else if (cloned.states[target as string]) {
          // __setMethod must be allowed in the TARGET state (self-transition),
          // not the source — async proxy writes dispatch after the machine
          // has already transitioned to the target state.
          (cloned.states[target as string] as Record<string, string>)[
            setKey(key)
          ] = target as string;
        }
      }
    }
    if (asyncMethods.size > 0) {
      for (
        const [stateName, stateConfig] of Object.entries(cloned.states) as [
          string,
          Record<string, string>,
        ][]
      ) {
        stateConfig["__error"] = stateName;
        // AIO-381: async methods can return schedule effects — routed through
        // an internal self-loop action so they reach the scheduler.
        stateConfig["__effects"] = stateName;
      }
    }
    machine = cloned;
    if (
      typeof (globalThis as Record<string, unknown>).__aioDev !== "undefined"
    ) {
      log.debug("aio", `${name} machine: ${JSON.stringify(machine, null, 2)}`);
    }
  }
  return machine;
}

// ── Return-array classification ────────────────────────────────────────

/** ONE decider for what a method's returned ARRAY means — shared by the sync
 *  reducer and the async executor. The two paths used to disagree: sync looked
 *  only at element[0] (so `[effect, data]` dispatched the data as a bogus
 *  effect), async required `every(isEffect)` (so the same return silently never
 *  armed the timer and handed the whole array back as a value). All elements
 *  effects → effects; none → value; a MIX has no coherent meaning, so it throws
 *  the same teachable error on both paths (sync: REDUCE_ERROR rejects the
 *  caller; async: the catch rejects the caller — loud either way).
 *
 *  @decider */
export function classifyReturnedArray(
  cellName: string,
  methodKey: string,
  value: readonly unknown[],
): "effects" | "value" {
  let effects = 0;
  for (const v of value) {
    if (isScheduleEffect(v) || isOwnEffect(v) || isNotifyEffect(v)) effects++;
  }
  if (effects === 0) return "value";
  if (effects === value.length) return "effects";
  throw new Error(
    `[${cellName}] method '${methodKey}' returned an array mixing ${effects} ` +
      `effect(s) with ${value.length - effects} plain value(s) — effects and ` +
      `values cannot share a return array. Return ONLY effects ` +
      `(schedule.*/own.*) to run them, or ONLY data to hand the array to the ` +
      `caller; to do both, write the data to state and return the effects.`,
  );
}

// ── Reducer builder ────────────────────────────────────────────────────

/** A call that supplies FEWER arguments than the method declares.
 *
 *  Measured, on a running app: `{"type":"ar:addTwo","payload":{"args":["one"]}}`
 *  for `addTwo(s, a, b)` answered `{"ok":true}` and wrote `{"a":"one"}` — the
 *  declared field simply absent from the row, on every client's screen, with
 *  the persist guard naming the damage one window later. TypeScript catches
 *  this for an in-process call; nothing did for a call that arrives as DATA
 *  (`am dispatch`, the trojan route, a stale client after a signature change).
 *
 *  A WARNING, not a refusal, and the reason is exact: `fn.length` stops at the
 *  first parameter with a default, so a method that defaults in its BODY
 *  (`reset(s, to) { to ??= 0 }`) reports as requiring an argument it does not,
 *  and refusing on the count would break a call that works today. The warning
 *  names that fix too — moving the default into the signature makes the
 *  optionality visible to everything, this check included.
 *
 *  Said once per method+count: a stale client repeats the same short call on
 *  every action, and one line per action is how a real signal gets scrolled
 *  away.
 *
 *  It lives at `methodArgs`, "the one place both method kinds pass through",
 *  so sync and async and every transport get the identical answer. */
const _shortCallWarned = new Set<string>();
/** @internal Test seam — the dedupe must not leak between test cases. */
export function _resetShortCallWarnings(): void {
  _shortCallWarned.clear();
}
function _warnShortCall(
  cell: string,
  key: string,
  fn: unknown,
  supplied: number,
): void {
  if (typeof fn !== "function") return;
  const required = Math.max(0, fn.length - 1); // minus the state draft
  if (supplied >= required) return;
  const id = `${cell}:${key}|${supplied}`;
  if (_shortCallWarned.has(id)) return;
  _shortCallWarned.add(id);
  log.warn(
    "cell",
    `${cell}:${key} declares ${required} argument${
      required === 1 ? "" : "s"
    } and this call passed ${supplied} — the missing one${
      required - supplied === 1 ? " is" : "s are"
    } \`undefined\` inside the method, which writes a row whose declared ` +
      `field is simply gone rather than failing. Pass them ` +
      `(\`payload.args\`), or — if the method fills its own in — give the ` +
      `parameter a default in the SIGNATURE (\`${key}(s, x = 0)\`), which is ` +
      `what makes its optionality visible here. A \`?\` alone does not make a ` +
      `parameter optional here — TypeScript erases it, so \`${key}(s, x?: T)\` ` +
      `still counts \`x\`; give it a default (\`= undefined\`). ` +
      `Said once per method and count.`,
  );
}

const _eventArgWarned = new Set<string>();

/** A DOM Event in a declared parameter — the hint, once per method
 *  (src/state/event-arg.ts). Observe-only: the call proceeds unchanged. */
function _warnEventArg(
  cell: string,
  key: string,
  fn: unknown,
  args: readonly unknown[],
): void {
  const id = `${cell}:${key}`;
  if (_eventArgWarned.has(id)) return;
  const msg = eventArgWarning(cell, key, fn, args);
  if (!msg) return;
  _eventArgWarned.add(id);
  log.warn("cell", msg);
}

/** Build the CellReduceFn for a methods-based cell. */
export function buildMethodsReducer(
  actionTypeToKey: Map<string, string>,
  methods: Record<string, Method<Record<string, unknown>>>,
  syncMethods: Set<string>,
  asyncMethods: Set<string>,
  prefix: string,
  // Foreign action type → SYNC method that reacts to it (listensTo object
  // form, D1). Runs with the FOREIGN action's payload as the single arg.
  foreignHandlers: Map<string, string> | undefined,
  // `args:` — per-method argument rules. Checked HERE because `methodArgs` is
  // the one place both method kinds pass through, which is what makes the
  // guard identical for a sync method, an async one, `am dispatch`, a form and
  // a hand-written action alike.
  argSchemas?: Record<string, readonly ArgSpec[]>,
): CellReduceFn {
  // AIO-427: the ONE classifier for what a sync method's return means. Both
  // entry points — an own method action and a `listensTo` reaction to a foreign
  // one — run it, because the ambiguity is a property of the RETURN VALUE, not
  // of which action carried it. The listensTo path used to hand its result back
  // raw: compose-reduce only treats an ARRAY as effects, so a lone
  // `schedule.after(...)` was silently dropped (the same method called directly
  // ran it), a returned DATA array was misclassified as effects and blamed on
  // the FOREIGN action, and a dropped `own.set(...)` leaked its factory in
  // pendingFactories for the process lifetime.
  // The dispatching cell's method set — what self("m") resolves against.
  const hasMethod = (m: string) => typeof methods[m] === "function";
  const knownMethods = () => Object.keys(methods);
  const classify = (
    key: string,
    result: unknown,
    // Effects the method ran via `s.$do(...)` — already validated + resolved.
    captured: Effect[] = [],
  ): ReturnType<CellReduceFn> => {
    // AIO-8.2: a sync-classified method returning a thenable means the build
    // transpiled async functions (constructor.name check defeated). The
    // method's synchronous prefix has already mutated the draft; returning
    // here would let Immer FINALIZE that half-applied mutation and broadcast
    // corrupt state. THROW in both dev and prod (dispatch converts a reducer
    // throw into a reported REDUCE_ERROR + rejected action without crashing)
    // so the partial draft is discarded either way — never commit it.
    // Doctrine: no silent dev/prod divergence, and this trigger is
    // build-dependent (more likely in the compiled build, exactly where a
    // silent prod-only corruption would hide).
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error(
        // `prefix` IS the cell name (cell-methods-factory: `prefix = name`).
        // This said `${name}`, which this function never receives — so it
        // silently resolved to the global `name`, the empty string, and the
        // message read "[] method 'foo' …". The one diagnostic whose whole
        // job is to say WHICH cell was mis-transpiled did not say it.
        `[${prefix}] method '${key}' returned a Promise but was classified sync — ` +
          `your build transpiled async functions. Wrap it: ` +
          `${key}: markAsync(async (s) => {...})`,
      );
    }
    // A single tagged effect → wrapped to the reducer's effects array; an
    // all-effect array (classifyReturnedArray — shared with the async path) →
    // passed through as effects; anything else (primitive, plain object, data
    // array, `[]`) is a transported VALUE, wrapped in a RETURN_TAG envelope so
    // compose-reduce never mistakes it for a `Msg[]` effects array. A MIXED
    // array throws (see classifyReturnedArray).
    //
    // alpha52: effects the method ran via `s.$do(...)` ride alongside EITHER
    // outcome — with a value they travel in the envelope (`markReturn(value,
    // captured)`), with the deprecated return-effects they merge in front.
    // Returning effects keeps working through beta, with a one-time hint.
    //
    // `undefined` — and ONLY undefined — means "this method returned nothing".
    // A loose `== null` also swallowed `null`, so a sync method returning the
    // standard not-found sentinel resolved its caller with `undefined` while
    // the identical async method resolved `null`: a sync/async parity break on
    // the documented return contract, on every transport.
    if (result === undefined) {
      return captured.length > 0 ? captured : undefined;
    }
    if (
      isScheduleEffect(result) || isOwnEffect(result) || isNotifyEffect(result)
    ) {
      refuseReturnedEffects(prefix, key);
      return [
        ...captured,
        refuseUncloneableEffect(
          prefix,
          key,
          detachDrafts(
            toDoneEffect(prefix, key, result, hasMethod, knownMethods),
          ),
        ) as Effect,
      ];
    }
    if (
      Array.isArray(result) && result.length > 0 &&
      classifyReturnedArray(prefix, key, result) === "effects"
    ) {
      refuseReturnedEffects(prefix, key);
      return [
        ...captured,
        ...result.map((e) =>
          refuseUncloneableEffect(
            prefix,
            key,
            detachDrafts(toDoneEffect(prefix, key, e, hasMethod, knownMethods)),
          )
        ),
      ] as (Msg | ScheduleEffect | OwnEffect)[];
    }
    return markReturn(result, captured.length > 0 ? captured : undefined);
  };
  /** The positional argument list an action's payload carries, or a throw.
   *
   *  `args` is the framework's OWN envelope (`{ args: [...] }`, built by the
   *  action creator and by every client binding), so anything else in that
   *  slot is a malformed action, not an app value — and the reduce is the one
   *  place both method kinds pass through, which is what makes the refusal
   *  identical for both. Absent is legal (a no-argument method, and a
   *  hand-dispatched `{ type }`); present-and-not-an-array is refused. */
  const methodArgs = (
    cell: string,
    key: string,
    payload: unknown,
  ): unknown[] => {
    const raw = (payload as Record<string, unknown> | undefined)?.args;
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw)) {
      _warnShortCall(cell, key, methods[key], raw.length);
      _warnEventArg(cell, key, methods[key], raw);
      // Validated and COERCED before the method sees them. A schema returns
      // the parsed value and that value is what runs — which is the dozen
      // hand-written coercions the reports counted (report 9 §9.6, report 3 §12.7).
      return validateMethodArgs(cell, key, argSchemas?.[key], raw);
    }
    throw new Error(
      `[${cell}:${key}] action payload.args must be an ARRAY of positional ` +
        `arguments (got ${
          typeof raw === "object" ? "an object" : `a ${typeof raw}`
        }: ` +
        `${JSON.stringify(raw)?.slice(0, 60) ?? String(raw)}). ` +
        `Call the method (${cell}.${key}(a, b)) or dispatch ` +
        `{ type: "${cell}:${key}", payload: { args: [a, b] } } — a non-array ` +
        `here is spread character by character or throws mid-spread.`,
    );
  };
  /** Run a sync method with `s.$do` served on its draft, then classify. */
  const runSync = (
    key: string,
    fn: SyncMethod<Record<string, unknown>>,
    s: Record<string, unknown>,
    args: unknown[],
  ): ReturnType<CellReduceFn> => {
    const captured: Effect[] = [];
    const doFn = (...effects: unknown[]) => {
      if (effects.length === 0) {
        throw new Error(
          `[${prefix}] ${key}(): s.$do() called with no effect — pass one or ` +
            `more schedule.*/own.* effects.`,
        );
      }
      for (const e of effects) {
        captured.push(
          refuseUncloneableEffect(
            prefix,
            key,
            detachDrafts(
              toDoneEffect(prefix, key, e, hasMethod, knownMethods),
            ),
          ) as Effect,
        );
      }
    };
    // A missing slice (a raw `composed.reduce` on a state that never booted
    // the cell) hands a non-object draft through — a Proxy target must be an
    // object, and the method's own error (not a proxy TypeError) is the
    // informative one.
    // `s.$call.sibling(...)` — the sibling's body on THIS draft, in THIS
    // commit. Deferred: the table binds to the wrapper, and the wrapper needs
    // the table.
    // A box, not a `let`: the binding is genuinely deferred (the table needs
    // the wrapper, the wrapper needs the table), and a box says that in the
    // type instead of leaving a variable that looks reassignable.
    const box: { draft: unknown } = { draft: undefined };
    // Built on the first `s.$call` read, not per dispatch: the chain tables
    // behind it (cell-call.ts `ChainLink`) cost ~1.2 KB a call, measured with
    // v8 `total_allocated_bytes` over 10k `counter.increment` reduces (9.97 KB
    // eager → 8.73 KB lazy), and a method that never says `$call` paid it on
    // every dispatch. Memoized, so `s.$call === s.$call` still holds.
    let callTable: Record<string, (...args: unknown[]) => unknown> | undefined;
    const callFns = () =>
      callTable ??= withUnknownCallRefusal(
        prefix,
        key,
        buildCallTable(prefix, key, methods, () => box.draft, true),
      );
    box.draft = s !== null && typeof s === "object"
      ? withDraftDo(s, doFn, callFns)
      : s;
    // A method body IS server code: what it calls on another cell bypasses
    // `access:` exactly as it does over a socket, where a cell→cell call never
    // reaches the network gate. See call-origin.ts.
    let result: unknown = inServerOrigin(() =>
      fn(
        box.draft as Parameters<SyncMethod<Record<string, unknown>>>[0],
        ...args,
      )
    );
    // `return s` must hand back the real draft, not the wrapper (snapshotReturn
    // relies on isDraft) — also when `s` came back from a sibling, which was
    // handed its own chain view of the same draft (see cell-call.ts).
    if (unwrapCallView(result) === box.draft) result = s;
    return classify(key, result, captured);
  };
  return (
    state: unknown,
    action: Msg,
  ): ReturnType<CellReduceFn> => {
    const s = state as Record<string, unknown>;
    // listensTo reaction — a foreign action with a mapped handler method.
    const foreignKey = foreignHandlers?.get(action.type);
    if (foreignKey) {
      const handler = methods[foreignKey];
      if (handler) {
        // Method actions carry the positional `{ args }` envelope — spread it
        // so the handler is written with the foreign method's own parameter
        // list (`onAdded(s, item, qty)`), not a hand-destructured envelope
        //. Non-method triggers pass payload as-is.
        const p = action.payload as { args?: unknown[] } | undefined;
        const args = p && Array.isArray(p.args) ? p.args : [action.payload];
        return runSync(
          foreignKey,
          handler as SyncMethod<Record<string, unknown>>,
          s,
          args,
        );
      }
    }
    const ownKey = actionTypeToKey.get(action.type);
    if (!ownKey) return;

    // Handle batched mutations from async methods
    if (ownKey.startsWith("__set")) {
      const payload = action.payload as { mutations: Mutation[] };
      // STRICT: this is the commit, the last word. A write that cannot be
      // applied here throws, the reduce fails, and the async method that made
      // it rejects — instead of a warn on the console while its caller is told
      // the change landed.
      applyMutations(s, payload.mutations, true);
      return;
    }

    // Error action — no state change
    if (ownKey === "__error") return;

    // AIO-381: schedule effects returned by an async method — the executor
    // bridges them here so they flow through the standard effect path.
    if (ownKey === "__effects") {
      const eff = (action.payload as { effects?: unknown[] })?.effects;
      return Array.isArray(eff)
        ? (eff as (Msg | ScheduleEffect | OwnEffect)[])
        : undefined;
    }

    // Method-style: call method directly on draft
    const method = methods[ownKey];
    if (method) {
      // ONE decider for the positional envelope, BEFORE the sync/async split.
      // Both halves used to write `(payload?.args as unknown[]) ?? []` and
      // spread the result unchecked, so a payload from the network deciding
      // what `...args` means: `args: "hi"` spread PER CHARACTER (`s.n += "n"`
      // turned a number into `"0n"`, acked `ok: true`, and every later call
      // appended another character), and a non-iterable object threw at the
      // spread — answered `ok: false` by the sync half and, by the async half,
      // an `EFFECT_ERROR` blaming the app's method while the client was still
      // told `ok: true`. The envelope is the framework's own; a malformed one
      // is refused here, identically for both kinds.
      const args = methodArgs(prefix, ownKey, action.payload);
      if (syncMethods.has(ownKey)) {
        return runSync(
          ownKey,
          method as SyncMethod<Record<string, unknown>>,
          s as Record<string, unknown>,
          args,
        );
      }
      if (asyncMethods.has(ownKey)) {
        const p = (action.payload ?? {}) as Record<string, unknown>;
        const _callId = p._callId as string | undefined;
        return [{
          type: `${prefix}:__exec`,
          payload: { _method: ownKey, _args: args, _callId },
        }];
      }
      return;
    }
  };
}

// ── Executor builder ───────────────────────────────────────────────────

/** Build the CellExecuteFn for a methods-based cell (async method dispatch + effect handlers). */
/** The app identity a scoped app carries (`_appId`, set by the runtime that
 *  composed the cells) — `""` when it has none, the wildcard scope. */
function appIdOf(app: unknown): string {
  const id = (app as { _appId?: unknown } | null)?._appId;
  return typeof id === "string" ? id : "";
}

export function buildMethodsExecutor(
  name: string,
  prefix: string,
  methods: Record<string, Method<Record<string, unknown>>>,
  asyncMethods: Set<string>,
  // deno-lint-ignore no-explicit-any
  config: any,
  effectKeys: string[],
  explicitExecute:
    | Record<string, (app: ScopedApp, payload: unknown) => void | Promise<void>>
    | undefined,
): CellExecuteFn {
  // `concurrency` / `ttl` bookkeeping, owned by THIS cell — see PolicyStore.
  const policyStore = createPolicyStore();
  // Per-cell serialize mutex:
  // this cell's transactional ASYNC methods run one at a time, so two of them
  // can't interleave a read-modify-write. A promise chain; the NEXT method
  // captures its snapshot only after the previous has committed.
  //
  // What it does NOT do — and the file used to claim otherwise, which cost the
  // reporter a shipped data bug: serialize a SYNC method
  // against a running async one. Sync methods are reducers; they commit
  // whenever they are dispatched, including mid-await. That hole is closed by
  // conflict detection below, not by the mutex.
  const txConfig = (config as {
    transaction?: boolean | { serialize?: boolean; conflict?: string };
  } | undefined)?.transaction;
  // `transaction: { serialize: false }` reads like "transactions off" and turns
  // them ON — the OBJECT is the opt-in, whatever is inside it, and `serialize`
  // is a knob of an already-enabled transaction whose default is already
  // `false`. So that spelling is either redundant (you wanted them on) or the
  // exact opposite of what it looks like (you wanted them off), and the
  // difference is invisible: pinned reads make a stand-down guard inert and
  // buffered writes stop a spinner ever reaching the client, with no error.
  // Refuse it at the `cell()` site, where the author can still read this.
  if (
    typeof txConfig === "object" && txConfig !== null &&
    txConfig.serialize === false
  ) {
    throw new Error(
      `[cell:${name}] \`transaction: { serialize: false }\` turns transactions ` +
        `ON — any object value is the opt-in, and \`serialize: false\` is ` +
        `already the default for an enabled transaction, so this spelling ` +
        `either says nothing or says the opposite of what it reads like. ` +
        `FIX: \`transaction: false\` (or omit \`transaction\`) to turn them ` +
        `OFF; \`transaction: true\` for the default transactional behaviour; ` +
        `\`transaction: { conflict: "warn" }\` to configure an enabled ` +
        `transaction without the redundant key.`,
    );
  }
  const serialize = typeof txConfig === "object" && !!txConfig?.serialize;
  // What to do when a read the method made has been overwritten by someone else
  // before it commits: "abort" (default — reject the call, commit nothing) or
  // "warn" (report loudly, commit anyway). There is no silent third option.
  const onConflict =
    (typeof txConfig === "object" ? txConfig?.conflict : undefined) ?? "abort";
  let serializeTail: Promise<unknown> = Promise.resolve();
  /** Methods already told that time travel paused them mid-flight. */
  const ttPausedWarned = new Set<string>();

  return (app: ScopedApp, effect: Msg): void => {
    // Handle async method execution
    if (effect.type === `${prefix}:__exec`) {
      const { _method, _args, _callId } = effect.payload as {
        _method: string;
        _args: unknown[];
        _callId?: string;
      };
      // "Is it defined" is a SHAPE question, and the index type cannot say
      // `undefined` — so asking it of the looked-up value read as always-true
      // to the compiler while the runtime hands back `undefined` for a name
      // this cell does not have. Ask the map, and bind the value for the call.
      const defined = Object.hasOwn(methods, _method);
      const method = methods[_method];
      if (!defined || !asyncMethods.has(_method)) {
        // A silent `return` here stranded the CALL: the registration this
        // effect carries is settled by the method that runs, and no method
        // ran — so an awaiting caller waited out the full ceiling and was
        // then told the method "may still be running". Nothing started, and
        // saying so costs one line.
        resolveCall(
          _callId,
          undefined,
          new Error(
            `[${prefix}] no async method '${_method}' to run — the executor ` +
              `was handed '${prefix}:__exec' for a method that is ${
                defined ? "SYNC" : "not defined on this cell"
              } (async methods: ${[...asyncMethods].join(", ") || "none"}).`,
          ),
        );
        return;
      }

      // `concurrency:` / `ttl:` — what happens when this method is called
      // again while it is still running (report 8 §15). Decided BEFORE any
      // controller, tracking or proxy exists, because two of the three answers
      // are "do not run".
      const policyMode = (config as {
        concurrency?: Record<string, ConcurrencyMode>;
      } | undefined)?.concurrency?.[_method];
      const policyTtl = (config as {
        ttl?: Record<string, number>;
      } | undefined)?.ttl?.[_method];
      const decision = beginPolicyCall(
        prefix,
        _method,
        _args,
        policyMode,
        policyTtl,
        policyStore,
      );
      if (decision.kind === "adopt") {
        // A `first` dedup or a `ttl` hit. The caller ADOPTS the other call's
        // outcome — resolving it with `undefined` instead is the first-wins
        // bug the report shipped.
        decision.outcome.then(
          (o) =>
            resolveCall(
              _callId,
              o.value,
              o.error === undefined ? undefined : o.error as Error,
            ),
          // Whatever goes wrong between the runner's outcome and this caller
          // is THIS caller's rejection — never an unhandled one, which takes
          // the process down and leaves the adopter waiting forever.
          (e: unknown) =>
            resolveCall(
              _callId,
              undefined,
              e instanceof Error ? e : new Error(String(e)),
            ),
        );
        return;
      }
      const settlePolicy = decision.settle;

      // Transactional methods: reads see a STABLE snapshot captured
      // at entry (an `await` never changes them), and writes buffer + commit
      // atomically at return. Mid-method publishing is spelled `s.$commit()`;
      // deliberately fresh reads are `s.$live`.
      //
      // OPT-IN, by the boot-detectable rule (.katana/_aio.md): alpha52 made it
      // the default and alpha57 took that back. The flip changed the semantics
      // of every existing async method — pinned reads made stand-down guards
      // inert, and buffered writes stopped a spinner ever reaching the client —
      // with no type error, no runtime error and no failed test to find it by.
      // Only a cell that ASKS for the isolation gets it.
      const txValue = (config as { transaction?: unknown } | undefined)
        ?.transaction;
      const transactional = txValue === true ||
        (typeof txValue === "object" && txValue !== null);
      // Cancellation (perfect-aio D1): every async call gets an
      // AbortController; cancelOn triggers abort it, the method observes it via
      // `s.$signal`. Untracked on settle either way.
      //
      // Created HERE — when the call is DISPATCHED — not inside runOnce, which
      // under `serialize: true` does not run until every earlier call has
      // committed. A controller that does not exist yet cannot be aborted:
      // `notifyMethodCancel` only reaches `_inflight`, so an explicit Stop
      // pressed during job 1 left jobs 2 and 3 queued behind it running in
      // full, each reading `s.$signal.aborted === false`. Same hazard shape
      // shutdown hit and closed with `_shutdownCells` (method-cancel.ts).
      //
      // The window closes by construction, with no epoch flag to clear: a
      // cancel trigger fires during REDUCE of the trigger action, while a
      // call's controller is created when its `__exec` EFFECT runs — and
      // effects of an action always run before the next action is reduced
      // (dispatch drains its queue in order). So a call dispatched BEFORE the
      // trigger has a controller when the trigger fires (aborted, queued or
      // not), and a call dispatched AFTER it creates its controller after the
      // trigger is gone (never aborted). That is also exactly why
      // `cancelOn: "self"` can abort its elders but never the incoming call.
      const controller = new AbortController();
      // The owning app's identity (method-cancel.ts AppScope): two apps in one
      // process may each hold a `cell("ledger", …)`, and a cancel in one must
      // never reach the other. The scoped app carries it as `_appId`; a
      // runtime that has not been threaded one yet is the wildcard ("").
      const appScope = appIdOf(app);
      const untrack = trackCall(prefix, _method, controller, appScope);
      // Run the method once. For serialize, this is deferred until the previous
      // transactional call has committed (so its snapshot is fresh); otherwise
      // it runs now, concurrently, exactly as before.
      const runOnce = (): Promise<unknown> => {
        const batcher = createBatcher(prefix, (a) => app.dispatch(a), {
          deferred: transactional,
        });
        // Snapshot Σ — captured once, in a ref so `s.$commit()` can re-capture
        // it after a mid-method publish. Immer commits produce new objects, so
        // the reference stays pinned to entry-time state across every await.
        const snap: { s: Record<string, unknown> | null } = {
          s: transactional ? (app.getState() as Record<string, unknown>) : null,
        };
        // The state this method's reads are pinned to. Conflict detection asks
        // one question of it: has anything the method READ changed since?
        //
        // It must be a REAL committed state object, because identity is the
        // comparator (Immer's structural sharing is what makes an untouched
        // subtree free to check). It therefore moves with `snap.s` at every
        // `s.$commit()` — see `rebase` below. Pinning it at entry forever was
        // a shipped bug: after ONE `$commit`, every container path that commit
        // published compared entry-value against Immer's freshly built value
        // and read as "changed by another action" with no other action in the
        // process. `$commit` poisoned the rest of its own transaction.
        let origin = snap.s;
        const watch = transactional ? createReadWatch() : undefined;
        // The live state at the last `$commit`'s flush, while that write-set
        // has not been applied yet — null when there is nothing to re-base.
        let rebasePre: Record<string, unknown> | null = null;
        /** Re-pin the epoch (`origin` + the read snapshot) to the state our own
         *  `$commit` produced. Returns whether it is settled.
         *
         *  Why it can be decided by identity alone: `flush()` dispatches, and
         *  dispatch either applies inline (the method resumed OUTSIDE the
         *  dispatch loop — state moves before `flush()` returns) or queues
         *  behind the loop we are running inside, which drains synchronously
         *  and FIFO. So while `getState()` is still the very object we saw at
         *  flush, nothing at all has committed since — not our write-set, not
         *  anyone else's — and the previous `origin` is still exactly the state
         *  our reads reflect (`conflictPath` short-circuits on `origin ===
         *  live`). The instant it differs, our write-set is in it, and adopting
         *  it as the new base is both sound and identity-comparable again. */
        const rebase = (): boolean => {
          if (rebasePre === null) return true;
          const cur = app.getState() as Record<string, unknown>;
          if (cur === rebasePre) return false;
          snap.s = cur;
          origin = cur;
          rebasePre = null;
          return true;
        };
        // Snapshot isolation is only sound while nothing the method read has
        // moved underneath it. Validate at every commit point — the moment a
        // stale read stops being harmless and becomes the state we write.
        const guardCommit = (): void => {
          if (!watch) return;
          // Settle any pending `$commit` re-base first: validating against a
          // stale epoch is what turned our own publish into a phantom conflict.
          rebase();
          // Publishing nothing is trivially serializable — a read-only
          // stand-down (the documented `s.$live` re-check pattern) must be
          // able to return without being told its reads moved.
          if (watch.writes.size === 0 && batcher.pending().length === 0) return;
          const stale = conflictPath(
            origin,
            app.getState() as Record<string, unknown>,
            watch,
            serialize,
          );
          if (stale === null) return;
          const where = stale === "" ? "this cell's shape" : `s.${stale}`;
          const base = `[${name}] ${_method}(): ${where} was changed by ` +
            `another action while this transactional method awaited, and its ` +
            `reads are pinned to entry — committing would overwrite that ` +
            `change with a value computed from stale state.`;
          if (onConflict === "abort") {
            batcher.discard();
            throw createAioError(
              "TX_CONFLICT",
              base +
                ` Read through s.$live to work from current state, retry the ` +
                `call, or set transaction: { conflict: "warn" } to commit anyway.`,
              { cellName: name, actionType: `${prefix}:${_method}` },
            );
          }
          log.error(
            "cell",
            base + ` Committing anyway (transaction: { conflict: "warn" }).`,
          );
        };
        // Mid-method atomic publish: flush the buffer, then re-snapshot so reads
        // after $commit() see the just-committed state.
        // `s.$commit(minMs?)` — publish now, or at most once per `minMs`.
        //
        // The throttle exists because every long method hand-rolled it. One
        // report wrote the same shape twice in one app —
        // `if (++ticks % 8 === 0) s.$commit()` in a filesystem walk and
        // `if (pct - published >= 0.01) s.$commit()` in a hasher — which is
        // the counter, the threshold and the bookkeeping variable that the
        // framework can simply own. `long:` made "this runs for minutes" a
        // first-class category; publishing progress from one is what those
        // methods then all have to do.
        //
        // A bare `s.$commit()` is unchanged: publish, unconditionally.
        let lastCommitAt = 0;
        const commit = transactional
          ? (minMs?: number) => {
            if (typeof minMs === "number" && minMs > 0) {
              const now = Date.now();
              // The first call always publishes: a progress bar that waits one
              // interval before its first frame looks like a hang.
              if (lastCommitAt !== 0 && now - lastCommitAt < minMs) return;
              lastCommitAt = now;
            } else {
              lastCommitAt = Date.now();
            }
            guardCommit();
            // Capture the write-set before flush clears it, then dispatch the
            // real atomic commit.
            const muts = batcher.pending().slice();
            const pre = app.getState() as Record<string, unknown>;
            batcher.flush();
            // What the method scheduled so far is published with what it
            // wrote so far — the same boundary.
            publishTxEffects();
            if (watch) {
              // Everything up to here was just validated and published —
              // re-baseline so the NEXT validation covers only what this
              // method reads and writes from now on. Without this, a
              // read-only tail (or serialize mode) re-flags already-settled
              // reads as conflicts.
              watch.reads.clear();
              watch.writes.clear();
            }
            if (muts.length === 0) return;
            // A new epoch starts here: reads after `$commit` see the committed
            // state, and conflict detection is pinned to it.
            rebasePre = pre;
            if (!rebase() && snap.s) {
              // Our write-set is queued behind the dispatch loop we are inside.
              // Advance the LOCAL snapshot by the same mutations so reads see
              // them NOW, without waiting for the round-trip; `rebase` swaps in
              // the real committed objects on the next microtask (the loop is
              // synchronous, so it has drained by then) — and `guardCommit`
              // settles it too, so no commit point can ever validate against a
              // half-published epoch.
              const next = snapshotForRead(snap.s) as Record<string, unknown>;
              applyMutations(next, muts);
              snap.s = next;
              queueMicrotask(rebase);
            }
          }
          : undefined;
        const live = () => app.getState() as Record<string, unknown>;
        // `s.$do(effect, ...)` — the effect channel (alpha52). Outside a
        // transaction it is dispatched IMMEDIATELY (not buffered to method
        // return): the effect rides the cell's `__effects` bridge in the same
        // tick, so an `own.set` factory is consumed while its token is fresh.
        // Inside one it is held with the write-set — see `txEffects`; a held
        // `own.set` whose transaction aborts leaves its factory to the parked
        // registry's stale sweep, exactly as a sync method that throws after
        // `own.set` does. Validation and self() resolution are the same gate
        // the sync collector uses, at the call either way.
        const sendEffects = (resolved: unknown[]): void => {
          if (resolved.length === 0) return;
          app.dispatch(markInflight({
            type: `${prefix}:__effects`,
            payload: { effects: resolved },
            _source: "Effect",
          }) as Msg);
        };
        // A TRANSACTION's effects belong to its write-set. The spec's abort
        // (docs/state/transactional-methods.md §4) discards W on a throw, a
        // TX_CONFLICT or a cancel — and the effects used to go out anyway, the
        // moment `$do` was called: a withdrawal refused as a conflict still
        // sent its receipt, and a superseded `cancelOn: "self"` call still
        // scheduled its follow-up, while the cancel path's own comment said
        // "no effects". They are held here and published with the writes (at
        // return, or at `s.$commit()`), and dropped with them. Validation still
        // happens at the `$do` call, so a bad effect throws in the method's own
        // stack. A NON-transactional method is unchanged: its writes commit
        // incrementally, and its effects go out immediately.
        let txEffects: unknown[] = [];
        const publishTxEffects = (): void => {
          const out = txEffects;
          txEffects = [];
          sendEffects(out);
        };
        const dropTxEffects = (): void => {
          if (txEffects.length === 0) return;
          log.debug(
            "cell",
            `${name} ${_method}(): ${txEffects.length} buffered effect(s) ` +
              `discarded with the aborted transaction`,
          );
          txEffects = [];
        };
        const doDispatch = (...effects: unknown[]) => {
          if (effects.length === 0) {
            throw new Error(
              `[${name}] ${_method}(): s.$do() called with no effect — pass ` +
                `one or more schedule.*/own.* effects.`,
            );
          }
          const resolved = effects.map((e) =>
            // materializeValue: a payload referencing the live proxy
            // (`payload: { args: [s.items] }`) becomes plain data — a Proxy
            // would be refused by structuredClone at the effect-clone seam.
            refuseUncloneableEffect(
              name,
              _method,
              materializeValue(toDoneEffect(
                name,
                _method,
                e,
                (m) => typeof methods[m] === "function",
                () => Object.keys(methods),
              )),
            )
          );
          if (transactional) {
            txEffects.push(...resolved);
            return;
          }
          sendEffects(resolved);
        };
        // `s.$live` — the sanctioned way out of snapshot isolation: same
        // batcher (so writes still commit atomically), unwatched reads (they
        // are current by construction), built only if the method asks for it.
        let liveProxy: Record<string, unknown> | undefined;
        const liveView = () =>
          liveProxy ??= createLiveProxy(
            name,
            prefix,
            _method,
            live,
            batcher,
            [],
            new Map(),
            { v: null },
            controller.signal,
            // Same commit closure as the pinned proxy — `s.$live.$commit()`
            // must publish, not silently no-op.
            commit,
            undefined,
            undefined,
            doDispatch,
            // And `s.$live.$call` — the same draft read another way, so the
            // same siblings; it was `undefined` in a transaction only.
            callTable,
          );
        // `s.$call.sibling(...)` — same draft, same commit, no second
        // dispatch. Bound lazily for the same reason as the sync side.
        // A box for the same reason as the sync side above.
        const ref: { proxy: unknown } = { proxy: undefined };
        const callTable = withUnknownCallRefusal(
          prefix,
          _method,
          buildCallTable(prefix, _method, methods, () => ref.proxy, false),
        );
        const proxy = createLiveProxy(
          name,
          prefix,
          _method,
          transactional ? () => snap.s as Record<string, unknown> : live,
          batcher,
          [],
          new Map(),
          { v: null },
          controller.signal,
          commit,
          watch,
          transactional ? liveView : undefined,
          doDispatch,
          callTable,
        );
        ref.proxy = proxy;
        // Server origin, continuation-local: a sibling called AFTER an await
        // inside this body is still the server calling itself. See
        // call-origin.ts.
        return inServerOrigin(() =>
          (method as AsyncMethod<Record<string, unknown>>)(
            proxy as Parameters<AsyncMethod<Record<string, unknown>>>[0],
            ..._args,
          )
        )
          .then(async (value) => {
            // Cancelled ⇒ the transaction ABORTS. The spec is explicit
            // (docs/state/transactional-methods.md §4, "Abort"): a method that
            // throws OR is cancelled discards its write-set — the `.catch`
            // below only ever covered the throw half.
            //
            // Non-transactionally there is nothing here to discard: writes
            // flush incrementally, so a superseded call's pre-`await` writes
            // already landed FIRST and the winner overwrites them — harmless.
            // With `transaction: true` the WHOLE write-set buffers to the end,
            // so the superseded run commits LAST and clobbers the winner: the
            // documented supersession pattern (`cancelOn: { run: "self" }` +
            // `if (s.$signal.aborted) return`) left `query` and the spinner
            // pinned to the ABANDONED call, silently and permanently.
            //
            // This is also right for shutdown's blanket abort: an interrupted
            // transaction must not persist half of itself, and whatever the
            // method deliberately published mid-flight via `s.$commit()` is
            // already committed and survives.
            if (transactional && controller.signal.aborted) {
              const dropped = batcher.pending().length;
              batcher.discard();
              dropTxEffects();
              if (dropped > 0) {
                log.debug(
                  "cell",
                  `${name} ${_method}(): cancelled — ${dropped} buffered ` +
                    `write(s) discarded (transaction abort)`,
                );
              }
              // A cancelled transaction still has to answer for what it
              // ALREADY published: an `s.$commit()` earlier in the method
              // dispatched a real write-set, and if the store REFUSED it that
              // rejection was dropped on the floor — this was the one exit
              // that skipped `settled()`. Cancellation means "the rest did not
              // happen", never "whatever already happened is fine". A throw
              // here lands in the .catch below and rejects the caller.
              await batcher.settled();
              // No effects either: scheduling follow-up work is the one thing
              // a cancelled call must not do. Resolving `undefined` matches
              // the cancellation path the docs tell methods to take.
              settlePolicy({ value: undefined });
              resolveCall(_callId, undefined);
              return;
            }
            // Transactional commit: apply the whole method's buffered
            // write-set as ONE atomic `__set`, before resolving the caller — so an
            // awaiter sees committed state, and other clients saw no intermediate.
            // A non-transactional batcher flushes on a microtask, which can land
            // AFTER the check below — so flush here either way. For a
            // non-transactional method this only commits the remainder a beat
            // sooner (the queued flush then finds an empty batch).
            // …but first: is what we are about to write still based on state
            // that is current? A throw here lands in the .catch below, which
            // discards the write-set and rejects the caller — the whole point
            // is that a lost update can never be the quiet outcome.
            // Last check before the commit. The body-settled check above ran
            // before this method awaited its effect-return and its own commit
            // machinery; an abort that lands in between must still abort — the
            // whole point of holding the tracking open past the body.
            if (transactional && controller.signal.aborted) {
              batcher.discard();
              dropTxEffects();
              await batcher.settled(); // same reason as the branch above
              settlePolicy({ value: undefined });
              resolveCall(_callId, undefined);
              return;
            }
            guardCommit();
            batcher.flush();
            // …then find out whether the store ACCEPTED it. A refused write-set
            // (classically `s.x = { ...s.x, y }` — a proxy-derived value assigned
            // back into state) used to be logged and dropped while this method
            // resolved normally, so the caller was told a change had landed that
            // never did: a build panel frozen at step 0 with an empty log and a
            // green test suite. Rethrowing here routes it into the
            // .catch below, which rejects the caller and reports the error —
            // identical in dev, prod and every test harness.
            await batcher.settled();
            // The write-set is in and accepted — only now do the effects the
            // transaction scheduled go out (see `txEffects`).
            if (transactional) publishTxEffects();
            // SEAL HERE, not in the trailing `.finally`.
            //
            // The write-set is in and accepted; from this instant a write
            // through `s` (or `s.$live`) can only come from a callback that
            // outlived the method. Closing in the `.finally` put that instant
            // two microtask turns AFTER the caller's promise resolved — so a
            // write in that window was still ACCEPTED, which is exactly the
            // behaviour `close()`'s own comment describes as the bug
            // ("persisted, broadcast, ok: true, not a line in any log"), and
            // it happened after `await cell.method()` had already returned.
            // `close()` is idempotent; the `.finally` still calls it for the
            // paths that never reach here.
            batcher.close();
            // AIO-381/382: async methods can return schedule + own effects,
            // same as sync methods. Detection is conservative — only
            // `__schedule`/`__own`-typed values count, so data returns to
            // direct callers are never eaten. Arrays go through the SAME
            // classifier as the sync path (classifyReturnedArray): all
            // effects → effects, none → value, mixed → throws into the
            // .catch below, which rejects the caller.
            const retEffects = isScheduleEffect(value) || isOwnEffect(value) ||
                isNotifyEffect(value)
              ? [value as ScheduleEffect | OwnEffect]
              : Array.isArray(value) && value.length > 0 &&
                  classifyReturnedArray(name, _method, value) === "effects"
              ? value as (ScheduleEffect | OwnEffect)[]
              : [];
            if (retEffects.length > 0) {
              // Deprecated channel (alpha52): still works through beta, with a
              // one-time hint — `s.$do(...)` is the way. self() descriptors in
              // it resolve here (same gate as $do), so they stay loud.
              refuseReturnedEffects(name, _method);
              const resolved = retEffects.map((e) =>
                refuseUncloneableEffect(
                  name,
                  _method,
                  materializeValue(toDoneEffect(
                    name,
                    _method,
                    e,
                    (m) => typeof methods[m] === "function",
                    () => Object.keys(methods),
                  )),
                )
              );
              app.dispatch(markInflight({
                type: `${prefix}:__effects`,
                payload: { effects: resolved },
                _source: "Effect",
              }) as Msg);
            }
            if (
              (app as Record<string, unknown>)._isDisabled &&
              ((app as Record<string, unknown>)._isDisabled as () => boolean)()
            ) {
              const disabledErr = new Error(
                `[${name}] cell disabled while ${_method}() was running`,
              );
              settlePolicy({ error: disabledErr });
              resolveCall(_callId, undefined, disabledErr);
            } else {
              // An effect return is a SCHEDULING instruction, not a value —
              // documented as resolving `undefined`, which is what the sync
              // path does. The async path resolved the effect object itself,
              // so the same `return schedule.after(...)` gave callers two
              // different answers depending on whether the method happened to
              // be async. Parity is the contract.
              // materializeValue: array read methods hand back LIVE element
              // proxies (so writes through them land — cell-impl.ts), and
              // `return s.items.filter(...)` therefore returns proxies. A
              // Proxy is refused by structuredClone at the transport seam, so
              // the return crosses to the caller as plain data. Values with no
              // proxy inside are returned by reference and cost nothing.
              const settled = retEffects.length > 0
                ? undefined
                : materializeValue(value);
              settlePolicy({ value: settled });
              resolveCall(_callId, settled);
            }
          })
          .catch((e: Error) => {
            // Transactional abort: a throw/cancel discards the whole
            // buffered write-set — no partial commit.
            if (transactional) {
              batcher.discard();
              dropTxEffects();
            }
            // Same instant, the failing way out: the call is over, so the
            // view is sealed before its caller hears about it.
            batcher.close();
            settlePolicy({ error: e });
            resolveCall(_callId, undefined, e);
            const _onError = (app as Record<string, unknown>)._onError as
              | ((err: AioError) => void)
              | undefined;
            if (_isTTPausedRefusal(e)) {
              // The developer paused time travel while this method was still
              // running — not an app failure, so not an ERROR (and not an
              // error diagnostic, which feedback auto-capture would file as a
              // bug report). Its caller is still rejected and the writes stay
              // dropped: time travel's semantics are unchanged, only what is
              // SAID about them. Once per method; the door already says once
              // per action type that each write was not applied.
              const m = `${prefix}:${_method}`;
              if (!ttPausedWarned.has(m)) {
                ttPausedWarned.add(m);
                log.warn(
                  `time travel was paused while ${m}() was running — its ` +
                    `in-flight writes were dropped, not applied, and its ` +
                    `caller was rejected. Resume time travel and run ${m}() ` +
                    `again (further pauses of this method are not repeated).`,
                );
              }
            } else if (_onError) {
              _onError(createAioError("EFFECT_ASYNC_ERROR", e, {
                cellName: name,
                actionType: `${prefix}:${_method}`,
                ...(isDeliberateRejection(e)
                  ? { rejected: rejectionLine(`${prefix}:${_method}`, e) }
                  : {}),
              }));
            } else if (isDeliberateRejection(e)) {
              // A refusal, not a crash — method-rejection.ts.
              log.info("cell", rejectionLine(`${prefix}:${_method}`, e));
            } else {
              log.error("cell", `${name} ${_method}() threw: ${e}`);
            }
            app.dispatch(markInflight({
              type: `${prefix}:__error`,
              // `_callId` names WHICH call failed, so a sink that recorded
              // the call (the timeline) can mark it — `_method` alone matches
              // every call of the method.
              payload: { _method, error: String(e), _callId },
              _source: "Effect",
            }) as Msg);
          })
          // Untrack LAST, not on a `.finally` in front of the commit.
          //
          // `untrack()` takes this call's controller out of the cancellable
          // set, and it used to run the moment the method BODY settled —
          // before `guardCommit()`, `flush()` and `settled()`. A cancelOn
          // trigger firing in that window found nothing to abort, so a
          // `transaction: true` method committed its whole write-set AFTER its
          // own trigger had fired: the documented supersession pattern
          // (`cancelOn: { run: "self" }`) silently lost the race it exists to
          // win. The call is cancellable until its writes are actually in.
          //
          // And SEAL the state view here, in the same breath: once this call
          // has settled, a write through `s` (or `s.$live`) can only come from
          // a callback that outlived the method, and it must refuse loudly
          // rather than commit — see `createBatcher().close`.
          .finally(() => {
            untrack();
            batcher.close();
          });
      };
      // serialize: chain behind the previous transactional call (runs on both
      // fulfil + reject so one failure doesn't wedge the queue). Else run now.
      // Tracked, not just started: shutdown has to know this call is still
      // writing. The dispatch loop cannot tell — a cell's `execute` returns
      // nothing — so its drain would sail past a streaming method and seal the
      // queue under it.
      if (transactional && serialize) {
        serializeTail = serializeTail.then(runOnce, runOnce);
        trackPending(serializeTail, prefix, appScope);
      } else if (decision.kind === "queue") {
        // `concurrency: "queue"` — one at a time, per METHOD. Reuses the same
        // chaining the transactional serialize mutex uses, because it is the
        // same operation and a second implementation could only drift from it.
        const next = decision.after.then(runOnce, runOnce);
        setQueueTail(prefix, _method, next, policyStore);
        trackPending(next, prefix, appScope);
      } else {
        trackPending(runOnce(), prefix, appScope);
      }
      return;
    }

    // Handle effects — explicit execute handlers only. User-config `execute:`
    // died in alpha27 (cell() throws via removals.ts), so `config.execute` can
    // never reach here; the sole source is the map a factory passes in.
    const executeHandlers = (explicitExecute ?? {}) as Record<
      string,
      (app: ScopedApp, payload: unknown) => void | Promise<void>
    >;
    if (Object.keys(executeHandlers).length > 0) {
      const effectTypeToKey = new Map<string, string>();
      for (const k of effectKeys) effectTypeToKey.set(`${prefix}:${k}`, k);
      const key = effectTypeToKey.get(effect.type) ?? effect.type;
      const h = executeHandlers[key];
      if (h) {
        const result = h(app, (effect as { payload: unknown }).payload);
        if (result && typeof result === "object" && "catch" in result) {
          (result as Promise<void>).catch((e) => {
            const _onError = (app as Record<string, unknown>)._onError as
              | ((err: import("../diagnostics/error.ts").AioError) => void)
              | undefined;
            if (_onError) {
              _onError(createAioError("EFFECT_ASYNC_ERROR", e, {
                cellName: name,
                actionType: `${prefix}:${key}`,
                effectType: effect.type as string,
              }));
            } else {
              log.error("cell", `${name} ${key}() execute threw: ${e}`);
            }
          });
        }
      }
    }
  };
}
