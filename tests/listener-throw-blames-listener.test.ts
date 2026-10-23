// A `listensTo` handler that throws is the LISTENER's bug, not the source's.
//
// The throw rolls the whole action back (one action, one reduce) — kept. But
// it was charged to the action's prefix: the circuit breaker counted the
// errors against the SOURCE cell and disabled it, leaving the buggy listener
// enabled, so the innocent cell stayed dead while the broken one kept
// running. And the report named the source and logged the listener's crash at
// info level as the source's deliberate refusal ("the method threw it").
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import type { AioError } from "../src/diagnostics/error.ts";

// deno-lint-ignore no-explicit-any
type D = any;

const source: D = cell("lbsrc", {
  state: { n: 0 },
  methods: {
    ok(s: { n: number }) {
      s.n += 1;
    },
  },
} as D);
const listener: D = cell("lblis", {
  state: { heard: 0 },
  listensTo: { onOk: source.ok },
  methods: {
    onOk(s: { heard: number }) {
      s.heard += 1;
      throw new Error("analytics bug");
    },
  },
} as D);

Deno.test("listensTo throw: the breaker and the report name the listener", async () => {
  const errors: AioError[] = [];
  await using srv = await testServer({
    cells: [source, listener],
    circuitBreaker: { maxErrors: 2 },
    onError: (e: AioError) => errors.push(e),
  } as D);
  for (let i = 0; i < 2; i++) {
    await source.ok().then(
      () => assert(false, "the listener's throw still fails the action"),
      () => {},
    );
  }
  const health = (srv.app as D).cells.health() as D[];
  const row = (n: string) => health.find((h) => h.name === n);
  assertEquals(row("lblis")?.errors, 2, "the listener's errors are its own");
  assertEquals(row("lbsrc")?.errors, 0, "the source did nothing wrong");
  assertEquals(row("lbsrc")?.enabled, true, "the source must not be tripped");
  assertEquals(row("lblis")?.enabled, false, "the buggy listener is tripped");

  // With the listener off, the source works again.
  await source.ok();
  assertEquals((srv.app.getState() as D).lbsrc.n, 1);

  const reduceErrs = errors.filter((e) => e.code === "REDUCE_ERROR");
  assertEquals(reduceErrs.length, 2, "both throws are reported");
  for (const e of reduceErrs) {
    assertEquals(e.context?.cellName, "lblis", "named for the listener");
    assertEquals(
      (e.context as D)?.rejected,
      undefined,
      "a listener's crash is not the source's deliberate refusal",
    );
  }
});
