import { assertEquals } from "@std/assert";
import {
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateConfig,
} from "../src/aio.ts";

// Test helper: inject fake exit that captures the code instead of killing the process
function fakeExit(): {
  result: { code: number | null };
  exit: (code: number) => never;
} {
  const result = { code: null as number | null };
  return {
    result,
    exit: ((code: number) => {
      result.code = code;
    }) as (code: number) => never,
  };
}

Deno.test("validateConfig: accepts all valid AioConfig keys", () => {
  const obj: Record<string, unknown> = {};
  for (const k of VALID_AIO_CONFIG_KEYS) obj[k] = "test";
  validateConfig(obj, VALID_AIO_CONFIG_KEYS, "AioConfig");
});

Deno.test("validateConfig: rejects unknown AioConfig key", () => {
  const f = fakeExit();
  validateConfig(
    { appId: "test", bogusField: 123 },
    VALID_AIO_CONFIG_KEYS,
    "AioConfig",
    f.exit,
  );
  assertEquals(f.result.code, 1);
});

Deno.test("validateConfig: accepts all valid CellsConfig keys", () => {
  const obj: Record<string, unknown> = {};
  for (const k of VALID_FEATURES_CONFIG_KEYS) obj[k] = "test";
  validateConfig(obj, VALID_FEATURES_CONFIG_KEYS, "CellsConfig");
});

Deno.test("validateConfig: rejects unknown CellsConfig key", () => {
  const f = fakeExit();
  validateConfig(
    { appId: "test", cells: [], syncRate: 50 },
    VALID_FEATURES_CONFIG_KEYS,
    "CellsConfig",
    f.exit,
  );
  assertEquals(f.result.code, 1);
});

Deno.test("validateConfig: accepts all valid UiConfig keys", () => {
  validateConfig(
    { title: "App", width: 800, height: 600, showStatus: true },
    VALID_UI_KEYS,
    "ui",
  );
});

Deno.test("validateConfig: rejects unknown ui key", () => {
  const f = fakeExit();
  validateConfig(
    { title: "App", syncIntervalMs: 250 },
    VALID_UI_KEYS,
    "ui",
    f.exit,
  );
  assertEquals(f.result.code, 1);
});

Deno.test("validateConfig: reports all unknown keys at once", () => {
  const f = fakeExit();
  validateConfig(
    { appId: "test", foo: 1, bar: 2 },
    VALID_AIO_CONFIG_KEYS,
    "AioConfig",
    f.exit,
  );
  assertEquals(f.result.code, 1);
});

Deno.test("validateConfig: empty object passes", () => {
  const f = fakeExit();
  validateConfig({}, VALID_AIO_CONFIG_KEYS, "AioConfig", f.exit);
  assertEquals(f.result.code, null);
});

Deno.test("validateConfig: valid config does not exit", () => {
  const f = fakeExit();
  validateConfig(
    { appId: "test", appVersion: "1.0" },
    VALID_AIO_CONFIG_KEYS,
    "AioConfig",
    f.exit,
  );
  assertEquals(f.result.code, null);
});
