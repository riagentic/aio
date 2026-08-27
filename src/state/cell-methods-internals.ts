// cell-methods-internals.ts — machine, reducer, and executor builders for methods-based cells

import { isScheduleEffect, type ScheduleEffect } from "./schedule.ts";
import { trackCall, trackPending } from "./method-cancel.ts";
import { isOwnEffect, type OwnEffect } from "./own.ts";
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
import { materializeValue, withDraftDo } from "./cell-impl.ts";
import { current, type Draft, isDraft } from "immer";
import { type AioError, createAioError } from "../diagnostics/error.ts";
import { log } from "../diagnostics/logger-api.ts";

// ── The effect channel: s.$do (alpha52) ────────────────────────────────

type Effect = ScheduleEffect | OwnEffect;

/** One-time-per-method deprecation hints for the old return-effects channel. */
const _returnHinted = new Set<string>();
/** @internal test seam — re-arm the one-time hints. */
export function _resetReturnEffectHints(): void {
  _returnHinted.clear();
}

function hintReturnedEffects(cellName: string, methodKey: string): void {
  const k = `${cellName}:${methodKey}`;
  if (_returnHinted.has(k)) return;
  _returnHinted.add(k);
  log.warn(
    "cell",
    `[${cellName}] method '${methodKey}' returned effect(s) — return-ed ` +
      `effects are deprecated: call s.$do(effect) inside the method and use ` +
      `\`return\` for values only. aiol --safe-fix rewrites this. ` +
      `(hinted once per method)`,
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
  if (!isScheduleEffect(v) && !isOwnEffect(v)) {
    throw new Error(
      `[${cellName}] ${methodKey}(): s.$do(...) only takes effects ` +
        `(schedule.* / own.*) — got ${describeNonEffect(v)}. To run another ` +
        `method, call it directly (or schedule it: ` +
        `s.$do(schedule.next("id", self("method")))); to hand a value to the ` +
        `caller, just \`return\` it.`,
    );
  }
  // Resolve self("m") at the capture site — the only place the owning cell is
  // known — so an unknown method throws HERE, in the method's own stack.
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
 *  caller; async: the catch rejects the caller — loud either way). */
export function classifyReturnedArray(
  cellName: string,
  methodKey: string,
  value: readonly unknown[],
): "effects" | "value" {
  let effects = 0;
  for (const v of value) {
    if (isScheduleEffect(v) || isOwnEffect(v)) effects++;
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
    if (isScheduleEffect(result) || isOwnEffect(result)) {
      hintReturnedEffects(prefix, key);
      return [
        ...captured,
        detachDrafts(
          toDoneEffect(prefix, key, result, hasMethod, knownMethods),
        ) as Effect,
      ];
    }
    if (
      Array.isArray(result) && result.length > 0 &&
      classifyReturnedArray(prefix, key, result) === "effects"
    ) {
      hintReturnedEffects(prefix, key);
      return [
        ...captured,
        ...result.map((e) =>
          detachDrafts(toDoneEffect(prefix, key, e, hasMethod, knownMethods))
        ),
      ] as (Msg | ScheduleEffect | OwnEffect)[];
    }
    return markReturn(result, captured.length > 0 ? captured : undefined);
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
          detachDrafts(
            toDoneEffect(prefix, key, e, hasMethod, knownMethods),
          ) as Effect,
        );
      }
    };
    // A missing slice (a raw `composed.reduce` on a state that never booted
    // the cell) hands a non-object draft through — a Proxy target must be an
    // object, and the method's own error (not a proxy TypeError) is the
    // informative one.
    const wrapped = s !== null && typeof s === "object"
      ? withDraftDo(s, doFn)
      : s;
    let result: unknown = fn(
      wrapped as Parameters<SyncMethod<Record<string, unknown>>>[0],
      ...args,
    );
    // `return s` must hand back the real draft, not the wrapper (snapshotReturn
    // relies on isDraft).
    if (result === wrapped) result = s;
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
      if (syncMethods.has(ownKey)) {
        const args =
          ((action.payload as Record<string, unknown>)?.args as unknown[]) ??
            [];
        return runSync(
          ownKey,
          method as SyncMethod<Record<string, unknown>>,
          s as Record<string, unknown>,
          args,
        );
      }
      if (asyncMethods.has(ownKey)) {
        const p = (action.payload ?? {}) as Record<string, unknown>;
        const args = (p.args as unknown[]) ?? [];
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

  return (app: ScopedApp, effect: Msg): void => {
    // Handle async method execution
    if (effect.type === `${prefix}:__exec`) {
      const { _method, _args, _callId } = effect.payload as {
        _method: string;
        _args: unknown[];
        _callId?: string;
      };
      const method = methods[_method];
      if (!method || !asyncMethods.has(_method)) return;

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
      const untrack = trackCall(prefix, _method, controller);
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
        // `if (++ticks % 8 === 0) s.$commit!()` in a filesystem walk and
        // `if (pct - published >= 0.01) s.$commit!()` in a hasher — which is
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
        // `s.$do(effect, ...)` — the effect channel (alpha52). Dispatched
        // IMMEDIATELY (not buffered to method return): the effect rides the
        // cell's `__effects` bridge in the same tick, so an `own.set` factory
        // is consumed while its token is fresh — the parked-factory registry
        // only carries the deprecated return path now. Validation and self()
        // resolution are the same gate the sync collector uses.
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
            materializeValue(toDoneEffect(
              name,
              _method,
              e,
              (m) => typeof methods[m] === "function",
              () => Object.keys(methods),
            ))
          );
          app.dispatch({
            type: `${prefix}:__effects`,
            payload: { effects: resolved },
            _source: "Effect",
          } as Msg);
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
        );
        return (method as AsyncMethod<Record<string, unknown>>)(
          proxy as Parameters<AsyncMethod<Record<string, unknown>>>[0],
          ..._args,
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
              await batcher.settled(); // same reason as the branch above
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
            // AIO-381/382: async methods can return schedule + own effects,
            // same as sync methods. Detection is conservative — only
            // `__schedule`/`__own`-typed values count, so data returns to
            // direct callers are never eaten. Arrays go through the SAME
            // classifier as the sync path (classifyReturnedArray): all
            // effects → effects, none → value, mixed → throws into the
            // .catch below, which rejects the caller.
            const retEffects = isScheduleEffect(value) || isOwnEffect(value)
              ? [value as ScheduleEffect | OwnEffect]
              : Array.isArray(value) && value.length > 0 &&
                  classifyReturnedArray(name, _method, value) === "effects"
              ? value as (ScheduleEffect | OwnEffect)[]
              : [];
            if (retEffects.length > 0) {
              // Deprecated channel (alpha52): still works through beta, with a
              // one-time hint — `s.$do(...)` is the way. self() descriptors in
              // it resolve here (same gate as $do), so they stay loud.
              hintReturnedEffects(name, _method);
              const resolved = retEffects.map((e) =>
                materializeValue(toDoneEffect(
                  name,
                  _method,
                  e,
                  (m) => typeof methods[m] === "function",
                  () => Object.keys(methods),
                ))
              );
              app.dispatch({
                type: `${prefix}:__effects`,
                payload: { effects: resolved },
                _source: "Effect",
              } as Msg);
            }
            if (
              (app as Record<string, unknown>)._isDisabled &&
              ((app as Record<string, unknown>)._isDisabled as () => boolean)()
            ) {
              resolveCall(
                _callId,
                undefined,
                new Error(
                  `[${name}] cell disabled while ${_method}() was running`,
                ),
              );
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
              resolveCall(
                _callId,
                retEffects.length > 0 ? undefined : materializeValue(value),
              );
            }
          })
          .catch((e: Error) => {
            // Transactional abort: a throw/cancel discards the whole
            // buffered write-set — no partial commit.
            if (transactional) batcher.discard();
            resolveCall(_callId, undefined, e);
            const _onError = (app as Record<string, unknown>)._onError as
              | ((err: AioError) => void)
              | undefined;
            if (_onError) {
              _onError(createAioError("EFFECT_ASYNC_ERROR", e, {
                cellName: name,
                actionType: `${prefix}:${_method}`,
              }));
            } else {
              log.error("cell", `${name} ${_method}() threw: ${e}`);
            }
            app.dispatch({
              type: `${prefix}:__error`,
              payload: { _method, error: String(e) },
              _source: "Effect",
            } as Msg);
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
          .finally(() => untrack());
      };
      // serialize: chain behind the previous transactional call (runs on both
      // fulfil + reject so one failure doesn't wedge the queue). Else run now.
      // Tracked, not just started: shutdown has to know this call is still
      // writing. The dispatch loop cannot tell — a cell's `execute` returns
      // nothing — so its drain would sail past a streaming method and seal the
      // queue under it.
      if (transactional && serialize) {
        serializeTail = serializeTail.then(runOnce, runOnce);
        trackPending(serializeTail, prefix);
      } else {
        trackPending(runOnce(), prefix);
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
