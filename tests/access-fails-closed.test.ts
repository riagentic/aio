// An access rule that cannot answer is a refusal, never permission.
//
// `cellAccessAllowed` returned the predicate's value straight into
// `if (!cellAccessAllowed(...))`, so ANY truthy non-boolean granted access —
// and the one an app reaches for by accident is a promise:
//
//     access: async (user) => await checkEntitlement(user)
//
// A pending promise is truthy, so that rule said YES to everybody, including
// anonymous callers. It fails OPEN, which is the one direction an authorization
// gate must never fail. The `Access` type says `=> boolean` and TypeScript
// catches the direct spelling, but not one returned through an `any` or an
// untyped helper — and this gate is the last place the mistake can be caught.
//
// The codebase already had the right answer elsewhere: the update applier's
// `canApply` treats a hook that throws as a refusal, "because a guard that
// cannot answer is not a yes". This makes the two agree.
import { assert, assertEquals } from "@std/assert";
import { cellAccessAllowed } from "../src/server/server-auth.ts";
import { serverFnAllowed, serverFns } from "../src/server/server-fns.ts";
import type { Access } from "../src/state/cell-types.ts";

const USER = { id: "u1", role: "admin" };

/** Silence the deliberate error lines these cases produce, and count them —
 *  a silent denial would be its own bug: the app author has to learn that
 *  their rule is broken, not merely that their users are locked out. */
function capture<T>(fn: () => T): { value: T; said: string[] } {
  const said: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => said.push(a.map(String).join(" "));
  try {
    return { value: fn(), said };
  } finally {
    console.error = orig;
  }
}

Deno.test("a predicate returning a PROMISE is denied, not granted", () => {
  // The accident this exists for.
  const rule = (() => Promise.resolve(true)) as unknown as Access;
  const { value, said } = capture(() =>
    cellAccessAllowed(rule, undefined, "transfer")
  );
  assertEquals(value, false, "an async rule must not grant access");
  assert(
    said.join(" ").includes("PROMISE"),
    `the author must be told WHY: ${JSON.stringify(said)}`,
  );
  // …and it names the fix rather than just the fault.
  assert(said.join(" ").includes("true or false"), said.join(" "));
});

Deno.test("a predicate returning any other non-boolean is denied", () => {
  for (const bad of ["yes", 1, {}, [], "false"]) {
    const rule = (() => bad) as unknown as Access;
    const { value } = capture(() => cellAccessAllowed(rule, USER, "m"));
    assertEquals(value, false, `${JSON.stringify(bad)} is not permission`);
  }
});

Deno.test("a predicate that THROWS is denied, and says so", () => {
  const rule = (() => {
    throw new Error("entitlement lookup failed");
  }) as unknown as Access;
  const { value, said } = capture(() => cellAccessAllowed(rule, USER, "m"));
  assertEquals(value, false);
  assert(said.join(" ").includes("threw"), said.join(" "));
});

Deno.test("the ordinary rules are untouched", () => {
  // The fix must not narrow what already worked.
  assertEquals(cellAccessAllowed(true, USER, "m"), true);
  assertEquals(cellAccessAllowed(true, undefined, "m"), false);
  assertEquals(cellAccessAllowed(false, USER, "m"), false);
  assertEquals(cellAccessAllowed("admin", USER, "m"), true);
  assertEquals(cellAccessAllowed("editor", USER, "m"), false);
  assertEquals(cellAccessAllowed(() => true, undefined, "m"), true);
  assertEquals(cellAccessAllowed(() => false, USER, "m"), false);
  // …including the row-level form, which sees the method and its args.
  assertEquals(
    cellAccessAllowed(
      (u, name, ...args) => u?.id === "u1" && name === "edit" && args[0] === 7,
      USER,
      "edit",
      [7],
    ),
    true,
  );
});

// The same rule vocabulary is read by serverFns, and it had spelled the four
// branches for itself — so it was a second reader of a rule the docs call
// unified, and it inherited the same fail-OPEN. A promise-returning predicate
// granted access to a whole namespace.
Deno.test("serverFns reads the SAME rule, and fails closed too", () => {
  serverFns("billing", { charge: () => "ok" }, {
    access: (() => Promise.resolve(true)) as unknown as Access,
  });
  const { value, said } = capture(() =>
    serverFnAllowed("billing", undefined, "charge")
  );
  assertEquals(value, false, "an async rule must not open a namespace");
  assert(said.join(" ").includes("PROMISE"), said.join(" "));
});

Deno.test("serverFns: no rule still means connection auth only", () => {
  // The one branch that is genuinely serverFns-specific, and must survive the
  // consolidation: a namespace with no `access` is gated by the connection,
  // not by this function.
  serverFns("public", { ping: () => "pong" });
  assertEquals(serverFnAllowed("public", undefined, "ping"), true);
});

Deno.test("serverFns: the ordinary rules still work", () => {
  serverFns("adminOnly", { wipe: () => "ok" }, { access: "admin" });
  assertEquals(serverFnAllowed("adminOnly", USER, "wipe"), true);
  assertEquals(
    serverFnAllowed("adminOnly", { id: "u2", role: "guest" }, "wipe"),
    false,
  );
  assertEquals(serverFnAllowed("adminOnly", undefined, "wipe"), false);
});
