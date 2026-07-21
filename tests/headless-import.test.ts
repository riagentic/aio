import { assertEquals, assertExists } from "@std/assert";

Deno.test("headless: base aio import provides server symbols", async () => {
  const base = await import("../mod.ts");
  assertExists(base.aio);
  assertExists(base.cell);
  assertExists(base.log);
  assertExists(base.schedule);
  assertExists(base.createDB);
  assertExists(base.call);
  assertExists(base.createSelector);
});

Deno.test("headless: periphery moved to aio/extras (B4c) — off core, on extras", async () => {
  const base = await import("../mod.ts");
  const extras = await import("../src/extras/mod.ts");
  for (
    const name of [
      "lint",
      "parseCli",
      "draft",
      "matchEffect",
      "deepFreeze",
      "markAsync",
      "instances",
      "connectCliUDS",
      "createSliceSelector",
      "DEFAULT_PRAGMAS",
    ]
  ) {
    assertEquals((base as any)[name], undefined, `${name} should be off core`);
    assertExists((extras as any)[name], `${name} should be on aio/extras`);
  }
});

Deno.test("headless: base aio import does NOT provide renderer symbols", async () => {
  const base = await import("../mod.ts");
  assertEquals((base as any).h, undefined, "h should not be in base");
  assertEquals((base as any).mount, undefined, "mount should not be in base");
  assertEquals((base as any).signal, undefined, "signal should not be in base");
  assertEquals((base as any).effect, undefined, "effect should not be in base");
  assertEquals(
    (base as any).onMount,
    undefined,
    "onMount should not be in base",
  );
  assertEquals(
    (base as any).useRef,
    undefined,
    "useRef should not be in base",
  );
  assertEquals(
    (base as any).useState,
    undefined,
    "useState should not be in base",
  );
  assertEquals(
    (base as any).useCell,
    undefined,
    "useCell should not be in base",
  );
  assertEquals(
    (base as any).useAio,
    undefined,
    "useAio should not be in base",
  );
  assertEquals(
    (base as any).Fragment,
    undefined,
    "Fragment should not be in base",
  );
  assertEquals(
    (base as any).useForm,
    undefined,
    "useForm should not be in base",
  );
});
