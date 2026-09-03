// The harness must not be more permissive than production.
//
// `testUI` boots on the standalone runtime, which has no network, so the
// server's declarative `access` gate was simply not in the path: a `customer`
// clicking an admin-only Delete DELETED the product under the harness, while
// the identical click over a real socket answered `ACCESS_DENIED`.
//
// That is the project's own doctrine inverted — "tests are the STRICTEST
// environment, never the most permissive" — with authorization as the subject
// it was lenient about. `access` is a rule about network callers, and a
// `testUI` click stands in for exactly one.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

const admin = cell("shop-admin", {
  state: { products: ["hat", "scarf"] },
  visible: "all",
  access: "admin", // only an admin may call these
  methods: {
    remove(s: { products: string[] }, name: string) {
      s.products = s.products.filter((p) => p !== name);
    },
  },
});

function App() {
  return (
    <div>
      <div class="button" onClick={() => admin.remove("hat")}>Delete</div>
      <span class="count">{admin.products.length}</span>
    </div>
  );
}

Deno.test("testUI: a customer's click on an admin-only method is DENIED", async () => {
  await using ui = await testUI(App, {
    cells: [admin],
    user: { id: "u1", role: "customer" },
  });
  ui.DeleteButton.click();
  await ui.settle();
  // The click must change nothing — exactly as over a real socket.
  assertEquals(admin.products.length, 2, "the gated method must not have run");
});

Deno.test("testUI: an admin's click on the same method RUNS", async () => {
  // The instrument check: the gate must not simply refuse everything, or the
  // assertion above would pass against a broken implementation.
  await using ui = await testUI(App, {
    cells: [admin],
    user: { id: "u2", role: "admin" },
  });
  ui.DeleteButton.click();
  await ui.settle();
  assertEquals(admin.products.length, 1);
});

Deno.test("testUI: an anonymous UI is denied a rule that needs a user", async () => {
  await using ui = await testUI(App, { cells: [admin], user: null });
  ui.DeleteButton.click();
  await ui.settle();
  assertEquals(admin.products.length, 2);
});

Deno.test("testUI: enforceAccess:false drives a gated method deliberately", async () => {
  // Seeding a fixture, or testing the method rather than the button.
  await using ui = await testUI(App, {
    cells: [admin],
    user: { id: "u3", role: "customer" },
    enforceAccess: false,
  });
  ui.DeleteButton.click();
  await ui.settle();
  assertEquals(admin.products.length, 1);
});

Deno.test("testUI: a cell with NO access rule is untouched", async () => {
  const open = cell("shop-open", {
    state: { n: 0 },
    visible: "all",
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  function Plain() {
    return <div class="button" onClick={() => open.bump()}>Bump</div>;
  }
  await using ui = await testUI(Plain, { cells: [open], user: null });
  ui.BumpButton.click();
  await ui.settle();
  assertEquals(open.n, 1);
  assert(true);
});
