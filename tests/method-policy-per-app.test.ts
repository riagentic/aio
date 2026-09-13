// `ttl` and `concurrency` belong to the cell that declared them — never to
// another app's cell that happens to share its name.
//
// The bookkeeping was three process-wide maps keyed `cell:method`. Two apps
// in one process (library mode, `testApps`, a service and its rich client),
// each with a `cell("users", …)`, measured:
//
//   B.fetchUser(1) → "A-user-1"   (ttl hit from app A; B's method never ran)
//   scan B        → "A-scan-/x"   (adopted A's running `first` call)
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testApps } from "../src/cell-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const makeUsers = (tag: string) =>
  cell("users", {
    state: { who: tag, runs: 0 },
    concurrency: { scan: "first", step: "queue" },
    ttl: { fetchUser: 60_000 },
    methods: {
      async fetchUser(s: Any, id: number) {
        s.runs++;
        await new Promise((r) => setTimeout(r, 5));
        return `${s.who}-user-${id}`;
      },
      async scan(s: Any, p: string) {
        await new Promise((r) => setTimeout(r, 50));
        return `${s.who}-scan-${p}`;
      },
      async step(s: Any, ms: number) {
        await new Promise((r) => setTimeout(r, ms));
        return s.who;
      },
    },
  } as Any) as Any;

Deno.test("ttl / first / queue: two apps with a same-named cell never answer each other", async () => {
  const a = makeUsers("A");
  const b = makeUsers("B");
  await using world = await testApps({
    one: { cells: [a] },
    two: { cells: [b] },
  });

  assertEquals(await a.fetchUser(1), "A-user-1");
  assertEquals(await b.fetchUser(1), "B-user-1");
  assertEquals(
    [
      world.get<Any>("one").state().users.runs,
      world.get<Any>("two").state().users.runs,
    ],
    [1, 1],
  );

  const [sa, sb] = await Promise.all([a.scan("/x"), b.scan("/x")]);
  assertEquals([sa, sb], ["A-scan-/x", "B-scan-/x"]);

  // `queue` is one-at-a-time per cell: B's short step must not wait behind
  // A's long one.
  const t0 = Date.now();
  const long = a.step(400);
  assertEquals(await b.step(1), "B");
  const waited = Date.now() - t0;
  assertEquals(await long, "A");
  assertEquals(waited < 300, true, `B queued behind A for ${waited}ms`);
});
