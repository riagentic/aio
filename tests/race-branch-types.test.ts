// `race()` names its branches, and then threw the names away at the return.
//
// It resolved `{ winner: keyof T & string; value: unknown }`, so narrowing on
// `winner` narrowed nothing: every use of the winner's value needed a cast, and
// `deno check` reported TS18046 ("'value' is of type 'unknown'") on the exact
// shape `mod.ts`'s own module example teaches. `race` is one of five async
// helpers on the CORE entry — after beta1 its return type can never change, so
// the discriminated union had to land now or never. (audit a16/3)
//
// These assertions are ANNOTATIONS as much as expectations: each `const x: T =`
// is a compile-time claim, and `deno test` type-checks the file, so a return
// type that regresses to `unknown` fails here before any assertion runs.
import { assertEquals } from "@std/assert";
import { race, sleep, until } from "../src/state/async-helpers.ts";

Deno.test("race: narrowing on winner narrows value with it", async () => {
  const r = await race({
    n: Promise.resolve(41 + 1),
    s: Promise.resolve("hi"),
    timeout: 10_000,
  });
  if (r.winner === "n") {
    const v: number = r.value; // was `unknown` — TS18046 right here
    assertEquals(v, 42);
    return;
  }
  if (r.winner === "s") {
    const v: string = r.value;
    assertEquals(v.length, 2);
    return;
  }
  const v: undefined = r.value; // a sleep branch carries no value
  assertEquals(v, undefined);
});

Deno.test("race: the number-as-sleep branch wins with an undefined value", async () => {
  const r = await race({ slow: sleep(5_000), timeout: 20 });
  if (r.winner !== "timeout") throw new Error(`slow branch won: ${r.winner}`);
  const v: undefined = r.value;
  assertEquals(v, undefined);
});

Deno.test("race: the module example from mod.ts type-checks as written", async () => {
  // Copied from `mod.ts`'s @module docblock — the first `race` anyone reads.
  const s = { paid: false, status: "idle" };
  setTimeout(() => (s.paid = true), 10);
  const r = await race({
    paid: until(() => s.paid, { timeoutMs: 60_000 }),
    timeout: 30_000,
  });
  if (r.winner === "timeout") {
    const v: undefined = r.value;
    assertEquals(v, undefined);
    return;
  }
  // `until` resolves void — the branch's value type, not `unknown`.
  const v: void = r.value;
  assertEquals(v, undefined);
  assertEquals(r.winner, "paid");
});

Deno.test("race: a loosely-typed branch record keeps the old unknown", async () => {
  // The one shape a naive `T[K] extends Promise<infer V> ? V : undefined`
  // would have made WORSE than before: with the record annotated, `T[K]` is
  // `Promise<unknown> | number`, which is neither — and answering `undefined`
  // there would be a wrong answer where `unknown` was merely an unhelpful one.
  const branches: Record<string, Promise<unknown> | number> = {
    a: Promise.resolve(7),
  };
  const r = await race(branches);
  const w: string = r.winner;
  const v: unknown = r.value;
  assertEquals(w, "a");
  assertEquals(v, 7);
});

Deno.test("race: the result is still assignable to the pre-alpha76 shape", async () => {
  // Additive means additive: code that wrote the old return type by hand must
  // keep compiling. The union is assignable to it (each `winner` is a string,
  // each `value` is an `unknown`).
  const r: { winner: string; value: unknown } = await race({
    a: Promise.resolve(1),
    timeout: 5,
  });
  assertEquals(typeof r.winner, "string");
});
