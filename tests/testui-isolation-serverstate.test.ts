// testUI hardening (field reports):
//  • tbd#1 — the in-memory localStorage shim is now installed FRESH per mount
//    and torn down, so writes don't bleed test→test (it used to be a
//    never-reset process global).
//  • tbd#3 — ui.serverState()/ui.fullState() expose the UNFILTERED server
//    state, so a test can read a `ui.exclude`d field a server route legitimately
//    reads (the client proxy hides it).
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { cell } from "../src/state/cell-create.ts";
import { testUI } from "../src/testing/ui-test.ts";

const Empty: ComponentFn = () => h("div", null, "x");

Deno.test("testUI: localStorage does not bleed across mounts (tbd#1)", async () => {
  {
    await using ui = await testUI(Empty);
    assertEquals(
      (globalThis as { localStorage: Storage }).localStorage.getItem("k"),
      null,
      "first mount starts with an empty localStorage",
    );
    (globalThis as { localStorage: Storage }).localStorage.setItem("k", "v1");
    assertEquals(
      (globalThis as { localStorage: Storage }).localStorage.getItem("k"),
      "v1",
    );
    void ui;
  }
  {
    await using ui = await testUI(Empty);
    assertEquals(
      (globalThis as { localStorage: Storage }).localStorage.getItem("k"),
      null,
      "second mount must NOT see the first mount's write",
    );
    void ui;
  }
});

Deno.test("testUI: the shim supports clear()/key()/length", async () => {
  await using ui = await testUI(Empty);
  const ls = (globalThis as { localStorage: Storage }).localStorage;
  ls.setItem("a", "1");
  ls.setItem("b", "2");
  assertEquals(ls.length, 2);
  assertEquals(ls.key(0), "a");
  ls.clear();
  assertEquals(ls.length, 0);
  assertEquals(ls.getItem("a"), null);
  void ui;
});

Deno.test("testUI: serverState()/fullState() expose ui.exclude'd fields (tbd#3)", async () => {
  const acct = cell("acct", {
    state: { name: "ada", secret: "hunter2" },
    ui: { exclude: ["secret"] }, // hidden from the client view
    methods: {
      rename(s: { name: string }, n: string) {
        s.name = n;
      },
    },
  });
  const App: ComponentFn = () => h("div", null, acct.name);

  await using ui = await testUI(App, { cells: [acct] });
  await ui.settle();

  // The unfiltered server state has the excluded field…
  const full = ui.fullState(acct) as { name: string; secret: string };
  assertEquals(full.secret, "hunter2", "server sees the excluded field");
  assertEquals(full.name, "ada");
  // …and serverState() returns the whole store.
  const whole = ui.serverState() as { acct: { secret: string } };
  assertEquals(whole.acct.secret, "hunter2");
  // The client-facing cell proxy still hides it — and under the test harness
  // (dev-strict) it THROWS rather than handing back `undefined`, so a component
  // reading a hidden field fails the test instead of quietly branching on
  // nothing (risoto 2026-07-28 #3).
  let threw = "";
  try {
    void (acct as unknown as { secret?: string }).secret;
  } catch (e) {
    threw = String(e);
  }
  assert(
    threw.includes("acct.secret"),
    `client read of a hidden field must fail loudly, got: ${
      threw || "no throw"
    }`,
  );
});
