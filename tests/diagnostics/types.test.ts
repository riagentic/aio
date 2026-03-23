import { assertEquals } from "@std/assert";
import {
  DEV_DEFAULTS,
  PROD_DEFAULTS,
  resolveOptions,
} from "../../src/diagnostics/types.ts";

Deno.test("resolveOptions: false kills everything", () => {
  assertEquals(resolveOptions(false, false), false);
  assertEquals(resolveOptions(false, true), false);
});

Deno.test("resolveOptions: empty config returns dev defaults", () => {
  const result = resolveOptions({}, false);
  assertEquals(result, { ...DEV_DEFAULTS });
});

Deno.test("resolveOptions: empty config returns prod defaults", () => {
  const result = resolveOptions({}, true);
  assertEquals(result, { ...PROD_DEFAULTS });
});

Deno.test("resolveOptions: dev overrides merge with dev defaults", () => {
  const result = resolveOptions({
    dev: { stateDiffs: false, actionLog: { max: 5000 } },
  }, false);
  assertEquals((result as Record<string, unknown>).stateDiffs, false);
  assertEquals((result as Record<string, unknown>).actionLog, { max: 5000 });
  assertEquals((result as Record<string, unknown>).crashHandler, true);
});

Deno.test("resolveOptions: prod overrides merge with prod defaults", () => {
  const result = resolveOptions({ prod: { timeTravel: true } }, true);
  assertEquals((result as Record<string, unknown>).timeTravel, true);
  assertEquals((result as Record<string, unknown>).stateDiffs, false);
});

Deno.test("resolveOptions: dev overrides ignored in prod mode", () => {
  const result = resolveOptions({ dev: { stateDiffs: false } }, true);
  assertEquals((result as Record<string, unknown>).stateDiffs, false);
});
