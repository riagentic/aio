// env-pin.ts — a test that pins a process env var must hand it back.
//
// MEASURED. `tests/tls.test.ts` and `tests/tls-anchor-stability.test.ts` each
// set `AIO_APPS_DIR` to a temp sandbox at MODULE TOP LEVEL and never restored
// it. `deno test` runs every file in ONE process, so the pin outlived the file:
//
//   deno test tests/tls-anchor-stability.test.ts tests/probe.test.ts
//   → PROBE AIO_APPS_DIR=/tmp/aio-tls-sandbox-214af7ae5c8d2c09
//
// The same probe run with the files the other way round prints `<unset>`. So
// every file that sorted after `tls*` ran against a tls temp dir — one that is
// deleted before they get there.
//
// It cost a real failure. `tests/am-instance-isolation.test.ts` spawns `am`,
// and `Deno.Command` MERGES the parent env by default, so the child inherited
// the leaked `AIO_APPS_DIR`. `am --instance=<name>` yields to an explicit
// `AIO_APPS_DIR` on purpose (the more specific instruction wins), so the flag
// under test was correctly ignored and the test correctly failed — pointing at
// an innocent file, three hundred files away from the cause.
//
// The pin belongs to the TEST, not to the module.

/** The two shapes `Deno.test` takes. */
type TestFn = (t: Deno.TestContext) => void | Promise<void>;
type TestDef = Omit<Deno.TestDefinition, "fn"> & { fn: TestFn };

/** A `Deno.test` that pins `vars` for the duration of each test and restores
 *  the process env afterwards — including deleting a var that was unset.
 *
 *  ```ts
 *  const test = pinnedTest({ AIO_APPS_DIR: SANDBOX });
 *  test("…", async () => { … });          // both call shapes work
 *  test({ name: "…", ignore: !ok, fn });
 *  ```
 */
// aio-ok: a test-only seam — nothing in src/ pins an env var for the duration of a test, and nothing should.
export function pinnedTest(
  vars: Record<string, string>,
): {
  (name: string, fn: TestFn): void;
  (def: TestDef): void;
} {
  const around = (fn: TestFn): TestFn => async (t) => {
    const prev = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
      prev.set(k, Deno.env.get(k));
      Deno.env.set(k, v);
    }
    try {
      await fn(t);
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  };
  return ((a: string | TestDef, b?: TestFn) => {
    if (typeof a === "string") Deno.test(a, around(b!));
    else Deno.test({ ...a, fn: around(a.fn) });
  }) as {
    (name: string, fn: TestFn): void;
    (def: TestDef): void;
  };
}
