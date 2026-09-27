// AIO6: every bound method returns a Promise. A scope:"client" cell's method
// that threw escaped SYNCHRONOUSLY — `c.m().catch(…)` never saw it — while a
// server cell's call rejects. Same contract on both.
import { assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import {
  _resetCellRegistry,
  bindCellReactive,
} from "../src/state/cell-reactive.ts";
import { _resetSignals } from "../src/state/state-signals.ts";
import { _resetSubs } from "../src/state/state-subs.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("client cell: a method that throws returns a rejected promise", async () => {
  _resetCellRegistry();
  _resetSignals();
  const c = cell(`clirej${crypto.randomUUID().slice(0, 6)}`, {
    scope: "client" as const,
    state: { n: 0 },
    methods: {
      boom(_s: { n: number }) {
        throw new Error("nope");
      },
      inc(s: { n: number }) {
        s.n++;
      },
    },
  }) as Any;
  bindCellReactive(c);
  let p: Promise<unknown> | undefined;
  p = c.boom(); // must not throw here
  await assertRejects(() => p!, Error, "nope");
  await c.inc();
  assertEquals(c.n, 1, "a failed call committed nothing; later calls work");
  _resetSubs(); // the reactive read armed the subscription sync
});
