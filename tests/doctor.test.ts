// Tests for `aio doctor` (src/server/doctor.ts) — the config sanity checker
// wired as `deno task doctor`. Exercises every check branch against temp
// deno.json fixtures.
import { assert, assertEquals } from "@std/assert";
import { runDoctor } from "../src/server/doctor.ts";

async function withConfig<T>(
  config: unknown,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    if (config !== undefined) {
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify(config, null, 2),
      );
    }
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const named = (checks: { name: string; ok: boolean }[], substr: string) =>
  checks.find((c) => c.name.includes(substr));

const GOOD = {
  compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
  imports: {
    "aio": "jsr:@riagentic/aio",
    "aio/air": "jsr:@riagentic/aio/air",
    "aio/jsx-runtime": "jsr:@riagentic/aio/jsx-runtime",
  },
  unstable: ["kv"],
};

Deno.test("doctor: a correct jsr-based config passes every check", async () => {
  await withConfig(GOOD, async (dir) => {
    const { checks, ok } = await runDoctor(dir);
    assert(
      ok,
      `expected ok; failures: ${
        checks.filter((c) => !c.ok).map((c) => c.name).join(", ")
      }`,
    );
    assert(checks.length >= 7);
  });
});

Deno.test("doctor: missing deno.json fails fast with a single readable check", async () => {
  await withConfig(undefined, async (dir) => {
    const { checks, ok } = await runDoctor(dir);
    assertEquals(ok, false);
    assertEquals(checks.length, 1);
    assertEquals(named(checks, "deno.json readable")!.ok, false);
  });
});

Deno.test("doctor: wrong/absent jsx config is caught", async () => {
  await withConfig({ ...GOOD, compilerOptions: {} }, async (dir) => {
    const { checks, ok } = await runDoctor(dir);
    assertEquals(ok, false);
    assertEquals(named(checks, "jsx ===")!.ok, false);
    assertEquals(named(checks, "jsxImportSource")!.ok, false);
  });
});

Deno.test("doctor: missing import-map keys are caught", async () => {
  await withConfig(
    { ...GOOD, imports: { "aio": "jsr:@riagentic/aio" } },
    async (
      dir,
    ) => {
      const { checks } = await runDoctor(dir);
      assertEquals(named(checks, 'has "aio/air"')!.ok, false);
      assertEquals(named(checks, 'has "aio/jsx-runtime"')!.ok, false);
    },
  );
});

Deno.test("doctor: missing unstable kv is caught", async () => {
  await withConfig({ ...GOOD, unstable: [] }, async (dir) => {
    const { checks } = await runDoctor(dir);
    assertEquals(named(checks, 'unstable includes "kv"')!.ok, false);
  });
});

Deno.test("doctor: electron import demands nodeModulesDir", async () => {
  const cfg = {
    ...GOOD,
    imports: { ...GOOD.imports, electron: "npm:electron" },
  };
  await withConfig(cfg, async (dir) => {
    const { checks } = await runDoctor(dir);
    assertEquals(named(checks, "nodeModulesDir set")!.ok, false);
  });
  await withConfig({ ...cfg, nodeModulesDir: "auto" }, async (dir) => {
    const { checks } = await runDoctor(dir);
    assertEquals(named(checks, "nodeModulesDir set")!.ok, true);
  });
});

Deno.test("doctor: vendored (relative) aio requires immer + @std/path", async () => {
  const cfg = {
    ...GOOD,
    imports: {
      "aio": "./dep/aio/mod.ts",
      "aio/air": "./dep/aio/src/air.ts",
      "aio/jsx-runtime": "./dep/aio/src/jsx-runtime.ts",
    },
  };
  await withConfig(cfg, async (dir) => {
    const { checks } = await runDoctor(dir);
    assertEquals(named(checks, '"immer" in import map')!.ok, false);
    assertEquals(named(checks, '"@std/path" in import map')!.ok, false);
  });
});
