// Small `@decider` functions, each held still at its own contract.
//
// A JSDoc `@decider` tag says a whole behaviour flows through ONE function, and
// `scripts/check-dead-wiring.ts` requires some test to import every tagged
// one. These six were proven only through their callers — every mention of
// them in tests/ was a comment — so a change to the rule itself would surface
// as a failure somewhere downstream, if at all. Each block pins the decision
// the function's doc comment claims to own.
import { assertEquals, assertThrows } from "@std/assert";
import { budgetKeyFor } from "../src/state/dispatch.ts";
import { resolveSelfAction, self } from "../src/state/self.ts";
import { classifyReturnedArray } from "../src/state/cell-methods-internals.ts";
import { schedule } from "../src/state/schedule.ts";
import { isRedactedAction, makeRedactor } from "../src/diagnostics/redact.ts";
import { pkColumn, type TableDef } from "../src/server/sql.ts";
import { resolveSigningKey } from "../src/build/ship.ts";

Deno.test("budgetKeyFor: async exec effect keys by payload method; sync action keys by its type; internals key nothing", () => {
  assertEquals(
    budgetKeyFor({ type: "jobs:__exec", payload: { _method: "build" } }),
    "jobs:build",
  );
  assertEquals(budgetKeyFor({ type: "app:effect" }, "jobs:poll"), "jobs:poll");
  assertEquals(budgetKeyFor({ type: "x" }, "jobs:__setFoo"), null);
  assertEquals(budgetKeyFor({ type: "x" }, "bare"), null);
  assertEquals(budgetKeyFor({ type: "x" }), null);
});

Deno.test("resolveSelfAction: self(m) becomes <cell>:m; a normal action passes through; an unknown method throws", () => {
  const has = (m: string) => m === "tick";
  const known = () => ["tick"];
  assertEquals(
    resolveSelfAction(
      self("tick", 1) as { type: string; payload?: unknown },
      "clock",
      has,
      known,
    ),
    { type: "clock:tick", payload: { args: [1] } },
  );
  const plain = { type: "other:x" };
  assertEquals(resolveSelfAction(plain, "clock", has, known), plain);
  assertThrows(
    () => resolveSelfAction(self("nope"), "clock", has, known),
    Error,
    "no method named 'nope'",
  );
});

Deno.test("classifyReturnedArray: all effects → effects; no effects → value; a mix throws", () => {
  const eff = schedule.after("pin.a", 10_000, { type: "c:noop" });
  assertEquals(classifyReturnedArray("c", "m", [eff]), "effects");
  assertEquals(classifyReturnedArray("c", "m", [1, 2]), "value");
  assertEquals(classifyReturnedArray("c", "m", []), "value");
  assertThrows(
    () => classifyReturnedArray("c", "m", [eff, 1]),
    Error,
    "mixing 1 effect(s) with 1 plain value(s)",
  );
});

Deno.test("isRedactedAction: the action type OR its origin method redacts — a __set write of a redacted method is covered", () => {
  const r = makeRedactor(["vault:unlock"]);
  assertEquals(isRedactedAction(r, "vault:unlock"), true);
  assertEquals(isRedactedAction(r, "vault:__setX", "vault:unlock"), true);
  assertEquals(isRedactedAction(r, "vault:__setX"), false);
  assertEquals(isRedactedAction(r, "other:x", "other:y"), false);
});

Deno.test("pkColumn: the column marked pk, wherever it sits, else null", () => {
  const def = (cols: Record<string, { pk?: boolean }>) =>
    ({ columns: cols }) as unknown as TableDef;
  assertEquals(pkColumn(def({ name: {}, slug: { pk: true } })), "slug");
  assertEquals(pkColumn(def({ name: {} })), null);
});

Deno.test("resolveSigningKey: --key wins; no flag and no default key file → none", async () => {
  assertEquals(await resolveSigningKey("/k.json", "any"), {
    path: "/k.json",
    source: "flag",
  });
  assertEquals(
    await resolveSigningKey(
      undefined,
      `pin-no-such-app-${crypto.randomUUID()}`,
    ),
    { path: undefined, source: "none" },
  );
});
