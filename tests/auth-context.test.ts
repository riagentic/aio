// AUTH-1 — ambient caller identity, serverFn access rules, failed-auth budget.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runWithUser, serverUser } from "../src/server/auth-context.ts";
import {
  _resetServerFns,
  invokeServerFn,
  serverFnAllowed,
  serverFns,
} from "../src/server/server-fns.ts";
import {
  _resetAuthFails,
  authFailBudgetExceeded,
  recordAuthFail,
} from "../src/server/server-auth.ts";

const alice = { id: "alice", role: "admin" };

Deno.test("serverUser: undefined outside, set inside runWithUser", () => {
  assertEquals(serverUser(), undefined);
  runWithUser(alice, () => assertEquals(serverUser(), alice));
  assertEquals(serverUser(), undefined);
});

Deno.test("serverUser: survives await (async continuation keeps caller)", async () => {
  await runWithUser(alice, async () => {
    await new Promise((r) => setTimeout(r, 1));
    assertEquals(serverUser()?.id, "alice");
  });
});

Deno.test("serverUser: concurrent callers never bleed into each other", async () => {
  const bob = { id: "bob", role: "viewer" };
  const seen: string[] = [];
  await Promise.all([
    runWithUser(alice, async () => {
      await new Promise((r) => setTimeout(r, 2));
      seen.push(serverUser()!.id);
    }),
    runWithUser(bob, async () => {
      await new Promise((r) => setTimeout(r, 1));
      seen.push(serverUser()!.id);
    }),
  ]);
  assertEquals(seen.sort(), ["alice", "bob"]);
});

Deno.test("serverFnAllowed: rule matrix", () => {
  _resetServerFns();
  serverFns("open", { f: () => 1 }); // no rule
  serverFns("authed", { f: () => 1 }, { access: true });
  serverFns("admins", { f: () => 1 }, { access: "admin" });
  serverFns("pred", { f: () => 1 }, {
    access: (u) => u?.id === "alice",
  });
  serverFns("never", { f: () => 1 }, { access: false });
  assert(serverFnAllowed("open", undefined));
  assert(!serverFnAllowed("authed", undefined));
  assert(serverFnAllowed("authed", { id: "x", role: "viewer" }));
  assert(!serverFnAllowed("admins", { id: "x", role: "viewer" }));
  assert(serverFnAllowed("admins", alice));
  assert(serverFnAllowed("pred", alice));
  assert(!serverFnAllowed("pred", { id: "bob", role: "admin" }));
  assert(!serverFnAllowed("never", alice));
  _resetServerFns();
});

Deno.test("invokeServerFn: denies by rule, allows and exposes serverUser()", async () => {
  _resetServerFns();
  serverFns("api", {
    whoami: () => serverUser()?.id ?? "anon",
  }, { access: true });

  // Anonymous network caller → denied before the fn runs.
  const denied = await invokeServerFn("api", "whoami", [], undefined);
  assert(!denied.ok);
  assertStringIncludes((denied as { error: string }).error, "access denied");

  // Authenticated caller, wrapped the way server-ws wraps it.
  const ok = await runWithUser(
    alice,
    () => invokeServerFn("api", "whoami", [], alice),
  );
  assert(ok.ok);
  assertEquals((ok as { value: unknown }).value, "alice");
  _resetServerFns();
});

Deno.test("invokeServerFn: no rule keeps legacy behavior (anonymous allowed)", async () => {
  _resetServerFns();
  serverFns("legacy", { ping: () => "pong" });
  const r = await invokeServerFn("legacy", "ping", [], undefined);
  assert(r.ok);
  assertEquals((r as { value: unknown }).value, "pong");
  _resetServerFns();
});

Deno.test("auth fail budget: 10 strikes inside the window, then 429-worthy", () => {
  _resetAuthFails();
  const t0 = 1_000_000;
  for (let i = 0; i < 9; i++) recordAuthFail("1.2.3.4", "test", t0 + i);
  assert(!authFailBudgetExceeded("1.2.3.4", t0 + 100));
  recordAuthFail("1.2.3.4", "test", t0 + 9);
  assert(authFailBudgetExceeded("1.2.3.4", t0 + 100));
  // Another key is unaffected (per-key philosophy — attacker locks only self).
  assert(!authFailBudgetExceeded("5.6.7.8", t0 + 100));
  // Window slides: 5 minutes later the key is clean again.
  assert(!authFailBudgetExceeded("1.2.3.4", t0 + 5 * 60_000 + 10));
  _resetAuthFails();
});
