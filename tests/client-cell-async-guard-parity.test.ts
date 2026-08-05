// "Is this method async?" must be ONE question with ONE answer, on the server
// and in the browser.
//
// A client-scoped cell supports sync methods only — there is no server round
// trip to carry an async result — and both runtimes enforce that. But they used
// different rules: the browser cell stub asked `isAsyncFunction` (which knows
// about BOTH a native `AsyncFunction` and the `markAsync` mark that a
// transpiled async body carries), while `cell()` itself only tested
// `constructor.name === "AsyncFunction"`.
//
// So a `markAsync`-marked method on a client cell was ACCEPTED by the server
// and THREW IN THE BROWSER at module load. The server booted, the app served,
// and the page was blank — the worst possible split for a rule whose entire
// purpose is to refuse the configuration early and loudly.
import { assert, assertThrows } from "@std/assert";
import { isAsyncFunction, markAsync } from "../src/state/cell-impl.ts";

const uid = () => crypto.randomUUID().slice(0, 8);

Deno.test("client cell: a natively async method is refused", async () => {
  const { cell } = await import("../mod.ts");
  assertThrows(
    () =>
      cell(`cli-native-${uid()}`, {
        scope: "client",
        state: { n: 0 },
        methods: {
          async go(s: { n: number }) {
            await Promise.resolve();
            s.n++;
          },
        },
        // deno-lint-ignore no-explicit-any
      } as any),
    Error,
    "sync methods only",
  );
});

Deno.test("client cell: a markAsync method is refused TOO (browser parity)", async () => {
  const { cell } = await import("../mod.ts");
  // What a transpiled async body looks like: a plain Function carrying the
  // mark. `constructor.name` is "Function" here, so the old inline check saw
  // nothing — while the browser's `isAsyncFunction` saw an async method and
  // threw as the module loaded.
  const transpiled = markAsync(function go(s: { n: number }) {
    return Promise.resolve().then(() => {
      s.n++;
    });
    // deno-lint-ignore no-explicit-any
  } as any);
  assert(
    (transpiled as { constructor: { name: string } }).constructor.name !==
      "AsyncFunction",
    "the fixture must NOT be a native async function, or it proves nothing",
  );
  assert(
    isAsyncFunction(transpiled as (...a: unknown[]) => unknown),
    "the fixture must read as async to the shared decider",
  );

  assertThrows(
    () =>
      cell(`cli-marked-${uid()}`, {
        scope: "client",
        state: { n: 0 },
        methods: { go: transpiled },
        // deno-lint-ignore no-explicit-any
      } as any),
    Error,
    "sync methods only",
    "a markAsync method on a client cell must be refused by cell() itself — " +
      "the browser refuses it at module load, so accepting it here ships a " +
      "blank page instead of an error",
  );
});

Deno.test("client cell: an ordinary sync method is still accepted", async () => {
  const { cell } = await import("../mod.ts");
  // The guard must not have become a blanket refusal.
  const c = cell(`cli-sync-${uid()}`, {
    scope: "client",
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  assert(c, "a sync client cell must still be created");
});
