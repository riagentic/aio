// A committed write that changes a persisted field's declared TYPE is refused
// in dev and said in prod — at the write, not one restart later.
//
// `am dispatch counter:increment by=2` sent `{ by: 2 }` to `(s, by) =>
// s.count += by`: ok:true, `count` became "0[object Object]", it was
// persisted, and the next boot restored the declared default over it with only
// a boot-log line. The boot restore's own rule (`detectShapeDrift`
// "type-changed" — a `null`/`undefined` on either side carries no type) is now
// applied to the write: dev throws (the commit is refused, the caller sees
// the error), prod warns naming the field (dev stricter than prod).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetParsedCli } from "../src/server/aio-cli.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type St = {
  count: number;
  user: { name: string } | null;
  maybe?: string;
  cache: number;
  tags: string[];
  map: Record<string, number>;
};

type Calls = {
  increment: (by: unknown) => Promise<unknown>;
  loose: () => Promise<unknown>;
  asyncSet: (v: unknown) => Promise<unknown>;
};

const _argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;

async function withApp(
  mode: "dev" | "prod",
  fn: (m: Calls, state: () => St) => Promise<void>,
): Promise<string[]> {
  const dir = await tempDir("aio-type-guard-");
  Object.defineProperty(Deno, "args", {
    value: mode === "prod" ? ["--prod"] : [],
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
  _resetAioRuntime();
  const c = cell("typeguard", {
    state: {
      count: 0,
      user: null,
      maybe: undefined,
      cache: 0,
      tags: [],
      map: {},
    } as St,
    persist: { exclude: ["cache"] },
    methods: {
      increment(s: St, by: unknown) {
        // deno-lint-ignore no-explicit-any
        (s as any).count += by;
      },
      loose(s: St) {
        s.user = { name: "ada" };
        s.maybe = "set";
        // deno-lint-ignore no-explicit-any
        (s as any).cache = "not persisted";
        // deno-lint-ignore no-explicit-any
        (s.tags as any).push(1);
        // deno-lint-ignore no-explicit-any
        (s.map as any).k = "v";
      },
      async asyncSet(s: St, v: unknown) {
        await Promise.resolve();
        // deno-lint-ignore no-explicit-any
        (s as any).count = v;
      },
    },
  });
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
  try {
    const app = await aio.run({
      cells: [c],
      appId: `type-guard-${mode}`,
      client: "server-only",
      libraryMode: true,
      port: freePort(),
      dbPath: join(dir, "state.db"),
      baseDir: dir,
      persistDebounceMs: 10,
    });
    try {
      await fn(
        c as unknown as Calls,
        () => (app.getState() as { typeguard: St }).typeguard,
      );
    } finally {
      await app.close();
    }
  } finally {
    console.warn = orig;
    Object.defineProperty(Deno, "args", _argsDesc);
    _resetParsedCli();
    _resetAioRuntime();
    await dropTempDir(dir);
  }
  return warned.filter((l) => l.includes("typeguard.count"));
}

Deno.test("dev: a write that changes a declared field's type is refused", async () => {
  await withApp("dev", async (m, state) => {
    await assertRejects(
      () => m.increment({ by: 2 }),
      Error,
      "typeguard.count",
    );
    assertEquals(state().count, 0);
    await m.increment(2);
    assertEquals(state().count, 2);
    await assertRejects(() => m.asyncSet("x"), Error, "typeguard.count");
    assertEquals(state().count, 2);
  });
});

Deno.test("prod: the same write commits and is said by name", async () => {
  const w = await withApp("prod", async (m, state) => {
    await m.increment({ by: 2 });
    assertEquals(state().count as unknown, "0[object Object]");
  });
  assert(
    w.some((l) => l.includes("string") && l.includes("number")),
    w.join("\n"),
  );
});

for (const mode of ["dev", "prod"] as const) {
  Deno.test(`${mode}: null/undefined declarations, excluded fields and open shapes are not type changes`, async () => {
    const w = await withApp(mode, async (m, state) => {
      await m.loose();
      assertEquals(state().user, { name: "ada" });
      assertEquals(state().maybe, "set");
    });
    assertEquals(w, []);
  });
}
