// aio's OWN cells survive an explicit `cells:` list.
//
// `updates:` and `feedback:` make aio create a built-in cell for the feature.
// That cell registers itself — and an app that ALSO passes `cells: [...]`
// makes the registry unreadable, so the cell aio had just created was
// dropped. The boot report then announced the feature (`updates  prod ·
// manifest · every 6h · ask first`) and the first call into the unbound cell
// threw as an unhandled rejection, AFTER the success banner, leaving the app
// running with the feature dead.
//
// A field report (dm, a two-app repo whose client passes an explicit list)
// shipped a self-update that could never run for the app's entire life —
// green in every test and every `deno task dev`, because the config that
// reaches this branch exists only in a released build.
//
// The rule these pin: a feature the config asked for is BOUND, whether or not
// the app spells out its own cells.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const boundIds = (server: { state: () => unknown }): string[] =>
  Object.keys(server.state() as Record<string, unknown>);

Deno.test("updates: the built-in cell is bound beside an explicit cells list", async () => {
  const app = cell("builtin-explicit-app", {
    state: { n: 0 },
    methods: {
      go(s) {
        s.n++;
      },
    },
  });
  await using server = await testServer({
    cells: [app],
    updates: { source: "https://example.invalid/app", check: false },
  });
  const ids = boundIds(server);
  assert(
    ids.includes("updates"),
    `configuring \`updates\` must bind its cell even with an explicit ` +
      `cells: [...] — bound: ${JSON.stringify(ids)}`,
  );
  // …and the app's own cell is still there and still works.
  await app.go();
  assertEquals(
    (server.state() as { "builtin-explicit-app": { n: number } })[
      "builtin-explicit-app"
    ].n,
    1,
  );
});

Deno.test("updates: an app that lists the cell itself is not given a second one", async () => {
  // The app always wins, and dedupe is by id — composeCells refuses a genuine
  // clash, so a double-add would be a boot failure rather than a nuisance.
  const app = cell("builtin-dedupe-app", { state: { n: 0 }, methods: {} });
  await using server = await testServer({
    cells: [app],
    updates: { source: "https://example.invalid/app", check: false },
  });
  const ids = boundIds(server);
  assertEquals(
    ids.filter((i) => i === "updates").length,
    1,
    `the updates cell must appear exactly once: ${JSON.stringify(ids)}`,
  );
});

Deno.test("updates: an app that configures nothing gets no built-in cell", async () => {
  // The other half of the rule: aio must not add a cell to an app that never
  // asked for the feature.
  const app = cell("builtin-optout-app", { state: { n: 0 }, methods: {} });
  await using server = await testServer({ cells: [app] });
  const ids = boundIds(server);
  assertEquals(
    ids.includes("updates"),
    false,
    `an app with no \`updates\` config must not carry the cell: ${
      JSON.stringify(ids)
    }`,
  );
  assertEquals(ids.includes("feedback"), false);
});
