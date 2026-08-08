/**
 * The effect-budget violation must name its own escape hatch (field report
 * #12e).
 *
 * The 5ms budget catches real freezes (a 1400ms Argon2id hash on the dispatch
 * path) and that signal is worth keeping. But a legitimate one-off — generating
 * a keypair, 14ms, once — read as "your app is defective", and the only visible
 * move was raising `perfBudget.effect` globally, which blinds every tight
 * reducer at once ("lost the signal everywhere to silence one poller"). The
 * per-method budget already existed; the message never mentioned it.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createDispatch, type DispatchDeps } from "../src/state/dispatch.ts";
import { type AioError, generateTip } from "../src/diagnostics/error.ts";

type S = { n: number };
// deno-lint-ignore no-explicit-any
type A = any;
// deno-lint-ignore no-explicit-any
type E = any;

const noop = { debug: () => {}, warn: () => {}, error: () => {} };
const burn = (ms: number) => {
  const t = performance.now();
  while (performance.now() - t < ms) {
    /* block the loop, as a real one would */
  }
};

/** Dispatch `action`, whose reduce emits `effects`, each taking ~`ms`. */
function run(
  action: A,
  effects: E[],
  ms: number,
  perfBudget?: DispatchDeps<S, A, E>["perfBudget"],
): AioError[] {
  const errors: AioError[] = [];
  const deps: DispatchDeps<S, A, E> = {
    reduce: () => ({ state: { n: 1 }, effects }),
    execute: () => burn(ms),
    getState: () => ({ n: 0 }),
    setState: () => {},
    onDone: () => {},
    log: noop,
    debug: false,
    perfCheck: "on",
    ...(perfBudget ? { perfBudget } : {}),
    reportOpts: { onError: (e) => errors.push(e) },
  };
  createDispatch(deps)(action);
  return errors;
}

const EXEC = (cell: string, method: string) => ({
  type: `${cell}:__exec`,
  payload: { _method: method, _args: [] },
});

Deno.test("perf: an async method's violation names perfBudget.methods for ITSELF", () => {
  const errors = run(
    { type: "auth:genKeypair" },
    [EXEC("auth", "genKeypair")],
    14,
  );
  assertEquals(errors.length, 1);
  const err = errors[0]!;
  assertEquals(err.code, "BUDGET_EFFECT");
  // the substance that caught the real 1400ms freeze is untouched — but each
  // half is now pinned where it is DECIDED. The dispatcher states the facts
  // (including which part of an async method was measured); the remedy lives
  // once in generateTip, because two half-overlapping pieces of advice on one
  // violation read as two different problems.
  assertStringIncludes(err.message, "exceeded budget");
  assertStringIncludes(
    err.message,
    "only the SYNC prefix before the first await",
  );
  const tip = generateTip(err) ?? "";
  assertStringIncludes(tip, "return immediately");
  assertStringIncludes(tip, "schedule.blocking");
  // …and the self-service fix is spelled out, keyed to THIS method
  assertStringIncludes(
    err.message,
    `perfBudget: { methods: { "auth:genKeypair": { effect: `,
  );
  assertStringIncludes(err.message, "every other effect stays strict");
  // the number suggested must actually clear the observed duration, or the
  // reader copies it in and the violation fires again
  const m = err.message.match(/"auth:genKeypair": \{ effect: (\d+) \}/);
  assert(m, `no concrete budget in: ${err.message}`);
  assert(
    Number(m[1]) >= err.context.duration!,
    `suggested ${m[1]}ms for a ${err.context.duration}ms effect`,
  );
});

Deno.test("perf: a SYNC method's effect gets the same hatch (keyed by its action)", () => {
  // A sync method's effects carry no method name — only the action does. Before
  // the fallback this violation had no addressable key at all, so the only
  // visible fix was the global budget.
  const errors = run({ type: "hw:poll" }, [{ type: "hw:read" }], 14);
  assertEquals(errors.length, 1);
  assertStringIncludes(
    errors[0]!.message,
    `perfBudget: { methods: { "hw:poll": { effect: `,
  );
});

Deno.test("perf: the hatch it names actually works — for sync AND async methods", () => {
  // The message would be a lie if the key it prints governed nothing.
  assertEquals(
    run({ type: "hw:poll" }, [{ type: "hw:read" }], 14, {
      effect: 5, // everything else stays strict
      methods: { "hw:poll": { effect: 100 } },
    }),
    [],
    "sync method: per-method budget applies to its effects",
  );
  assertEquals(
    run({ type: "auth:genKeypair" }, [EXEC("auth", "genKeypair")], 14, {
      effect: 5,
      methods: { "auth:genKeypair": { effect: 100 } },
    }),
    [],
    "async method: unchanged",
  );
  // …and the strictness is not lost for everything else
  assertEquals(
    run({ type: "other:tick" }, [{ type: "other:work" }], 14, {
      effect: 5,
      methods: { "hw:poll": { effect: 100 } },
    }).length,
    1,
    "another method stays on the global budget",
  );
});

Deno.test("perf: an effect with no method key gets no hatch (and no invented one)", () => {
  // A plain action (not `cell:method`) has no per-method budget to point at —
  // naming a key that governs nothing would be worse than saying nothing.
  const errors = run({ type: "Inc" }, [{ type: "Log" }], 14);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!.message, "exceeded budget");
  assert(
    !errors[0]!.message.includes("perfBudget"),
    `no hatch expected, got: ${errors[0]!.message}`,
  );
  // internal framework actions are not methods either
  const internal = run({ type: "cart:__destroy" }, [{ type: "cart:x" }], 14);
  assert(!internal[0]!.message.includes("perfBudget"));
});

Deno.test("perf: the violation is still LABELLED by the effect, not the method", () => {
  // Regression guard for the report itself: the label (perf.log's dedup key)
  // stays the effect's own type where it has one — only the opaque `__exec`
  // wrapper falls back to the method key.
  const sync = run({ type: "hw:poll" }, [{ type: "hw:read" }], 14);
  assertEquals(sync[0]!.context.actionType, "hw:read");
  const async_ = run(
    { type: "auth:genKeypair" },
    [EXEC("auth", "genKeypair")],
    14,
  );
  assertEquals(async_[0]!.context.actionType, "auth:genKeypair");
});
