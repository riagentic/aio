// Shape drift is detected at EVERY depth the restore prunes at.
//
// The drift walk stopped at nesting depth 8 while `deepMerge` prunes
// undeclared keys down to its own 32-level stack guard. A stored field 9
// levels down that the current build no longer declares was therefore dropped
// by the restore (and gone from disk after the first write) with NO drift
// line: dev booted instead of refusing, prod did not warn. One cap now: the
// walk goes exactly as deep as the merge prunes, and below that the merge
// keeps the subtree verbatim (and says so), so nothing is dropped unseen.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetParsedCli } from "../src/server/aio-cli.ts";
import { detectShapeDrift } from "../src/server/aio-boot.ts";
import { MAX_DEPTH } from "../src/state/deep-merge.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** `{a:{a:…{leaf}}}` — `leaf` sits `n` levels below the cell. */
const nest = (n: number, leaf: Record<string, unknown>) => {
  let v: Record<string, unknown> = leaf;
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
};

Deno.test("detectShapeDrift: a removed field 9 levels deep is drift, like one at depth 1", () => {
  assertEquals(
    detectShapeDrift(
      { c: nest(9, { keep: 1 }) },
      { c: nest(9, { keep: 1, gone: 2 }) },
    ).map((d) => d.path),
    [`${"a.".repeat(9)}gone`],
  );
});

Deno.test("detectShapeDrift: reaches exactly as deep as deepMerge prunes, no deeper", () => {
  // The cell slice is ONE level below the state deepMerge starts at, so the
  // last level it merges key-by-key is MAX_DEPTH - 2 inside the cell…
  const last = MAX_DEPTH - 2;
  assertEquals(
    detectShapeDrift(
      { c: nest(last, { keep: 1 }) },
      { c: nest(last, { keep: 1, gone: 2 }) },
    ).length,
    1,
  );
  // …and one level further the merge keeps the subtree VERBATIM (and warns),
  // so an undeclared key there is not dropped — and not drift.
  assertEquals(
    detectShapeDrift(
      { c: nest(last + 1, { keep: 1 }) },
      { c: nest(last + 1, { keep: 1, gone: 2 }) },
    ),
    [],
  );
});

const _argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;
function setMode(mode: "dev" | "prod"): void {
  Object.defineProperty(Deno, "args", {
    value: mode === "prod" ? ["--prod"] : [],
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
}

Deno.test("shape drift 9 levels deep: DEV refuses, PROD warns — exactly like depth 1", async () => {
  const dir = await tempDir("shape-drift-deep-");
  const dbPath = join(dir, "data.db");
  const boot = (declared: Record<string, unknown>) => {
    const c = cell("deepdrift", {
      state: { deep: declared },
      methods: {
        put(s: { deep: Record<string, unknown> }, v: Record<string, unknown>) {
          s.deep = v;
        },
      },
    });
    return {
      c,
      app: aio.run({
        cells: [c],
        appId: "shape-drift-deep",
        client: "server-only",
        libraryMode: true,
        port: freePort(),
        dbPath,
        baseDir: dir,
        persistDebounceMs: 10,
      }),
    };
  };
  try {
    setMode("dev");
    {
      const { c, app } = boot(nest(8, { keep: 0, gone: 0 }));
      const a = await app;
      await (c as unknown as {
        put: (v: unknown) => Promise<void>;
      }).put(nest(8, { keep: 1, gone: 2 }));
      await new Promise((r) => setTimeout(r, 300));
      await a.close();
    }
    const err = await assertRejects(
      () => boot(nest(8, { keep: 0 })).app,
      Error,
    );
    assert(
      (err as Error).message.includes(`${"a.".repeat(8)}gone`),
      (err as Error).message,
    );

    setMode("prod");
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
    let app: Awaited<ReturnType<typeof aio.run>> | null = null;
    try {
      app = await boot(nest(8, { keep: 0 })).app;
    } finally {
      console.warn = origWarn;
      await app?.close();
    }
    const w = warned.join("\n");
    assert(
      w.includes("shape drift") && w.includes(`deep.${"a.".repeat(8)}gone`),
      w,
    );
  } finally {
    Object.defineProperty(Deno, "args", _argsDesc);
    _resetParsedCli();
    await dropTempDir(dir);
  }
});
