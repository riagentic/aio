// A hook that calls a cell method while that cell's `__init` is dispatched
// gets an error that tells the truth.
//
// Hooks see `x:__init` at boot, and every cell's `__init` runs BEFORE its
// methods are bound (docs/basics/plugins.md). That order stays. What was wrong
// was the error such a call got: "called before the cell's runtime is booted —
// add this cell to aio.run({ cells: [...] })", measured on an app whose cell
// WAS in that list. The remedy it named was one the app had already applied, so
// the one line that could have explained the problem sent the reader away from
// it. A cell that really is in no app keeps the original advice.
import { assert, assertStringIncludes, assertThrows } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";

type Reported = { code: string; message: string; cause?: unknown };

const text = (e: Reported): string =>
  `${e.message} ${e.cause instanceof Error ? e.cause.message : ""}`;

Deno.test("boot: a hook calling a LISTED cell's method during __init is told to defer it, not to list the cell", async () => {
  const { aio, cell } = await import("../mod.ts");
  const stats = cell("stats", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  const reported: Reported[] = [];
  const app = await aio.run(
    {
      cells: [stats],
      appId: "test-boot-hook-method-call",
      client: "server-only",
      persist: false,
      libraryMode: true,
      port: freePort(),
      baseDir: await Deno.makeTempDir(),
      onError: (e: Reported) => void reported.push(e),
      onAction: (a: { type: string }) => {
        // deno-lint-ignore no-explicit-any
        if (a.type === "stats:__init") (stats as any).bump();
      },
    } as Parameters<typeof aio.run>[0],
  );
  try {
    const hookErrors = reported.filter((e) => e.code === "HOOK_ERROR");
    assert(hookErrors.length === 1, "the __init call is reported once");
    const said = text(hookErrors[0]!);
    assertStringIncludes(said, "__init");
    assertStringIncludes(said, "onStart");
    assert(
      !said.includes("add this cell to aio.run"),
      `the cell IS listed — the advice must not say to list it. Got: ${said}`,
    );
  } finally {
    await app.close();
  }
  // The window is boot only: once bound, the method runs.
  // deno-lint-ignore no-explicit-any
  assert(typeof (stats as any).bump === "function");
});

Deno.test("boot: a cell in no app keeps the 'add it to aio.run' advice", async () => {
  const { cell } = await import("../mod.ts");
  const orphan = cell("orphanForBootMessage", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  const e = assertThrows(
    // deno-lint-ignore no-explicit-any
    () => (orphan as any).bump(),
    Error,
  );
  assertStringIncludes(e.message, "add this cell to aio.run");
});
