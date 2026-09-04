// A config key's VALUE has a third question after "is this a key" and "is
// this one of the words": is this a number the reader can act on.
//
// Nobody asked it. `maxConnections: 0` booted a server that closed every
// client the instant it connected; `fullStateThreshold: "half"` compared a
// string against a ratio on every broadcast, forever; `effectTimeoutMs: "abc"`
// made every effect ceiling NaN; `persistDebounceMs: -5` went to a timer.
// Four apps that boot clean and behave impossibly — the exact silence
// `ENUM_VALUES` exists to end for words.
//
// So `NUMERIC_VALUES` is that list for numbers, and this file holds it to the
// TYPES: a `key?: number` on a config object `validateConfig` runs over, with
// no entry here, is a red test — not a value nobody checks.
import { assert, assertEquals } from "@std/assert";
import {
  NESTED_CONFIGS,
  NUMERIC_VALUES,
  numericRefusal,
  VALID_UI_KEYS,
  validateConfig,
} from "../src/server/config.ts";
import { VALID_AIO_CONFIG_KEYS } from "../src/server/aio.ts";

const SRC = new URL("../src/server/aio-types.ts", import.meta.url);

/** The `key?: number;` fields declared DIRECTLY on one config type. */
function numericFields(src: string, decl: string): string[] {
  const i = src.indexOf(decl);
  if (i === -1) throw new Error(`${decl} not found — did it move or rename?`);
  const body = src.slice(i, src.indexOf("\n};", i));
  return [...body.matchAll(/\n {2}(\w+)\?: number;/g)].map((m) => m[1]!);
}

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

/** Refuse `value` for `key`, and return the exit code (null = accepted). */
function check(key: string, value: unknown): number | null {
  const f = fakeExit();
  const keys = VALID_UI_KEYS.has(key) && !VALID_AIO_CONFIG_KEYS.has(key)
    ? VALID_UI_KEYS
    : VALID_AIO_CONFIG_KEYS;
  validateConfig({ [key]: value }, keys, "AioConfig", f.exit);
  return f.result.code;
}

/** Same, for a key that lives inside a nested config object. */
function checkNested(
  parent: string,
  key: string,
  value: unknown,
): number | null {
  const f = fakeExit();
  validateConfig(
    { [parent]: { [key]: value } },
    VALID_AIO_CONFIG_KEYS,
    "AioConfig",
    f.exit,
  );
  return f.result.code;
}

// ── The completeness gate ─────────────────────────────────────────────

Deno.test("NUMERIC_VALUES covers every numeric key validateConfig sees", async () => {
  const src = await Deno.readTextFile(SRC);
  const declared = new Set([
    ...numericFields(src, "export type UiConfig = {"),
    ...numericFields(src, "export type AioConfig<S, A, E> = {"),
    ...numericFields(src, "export type CellsConfig = {"),
    // Nested config objects are configs too — `validateConfig` recurses into
    // every key of `NESTED_CONFIGS`, so their numeric fields need a range for
    // the same reason. `wsLimits`' three keys had none and were unreachable:
    // `maxMessageBytes: NaN` (what `Number(Deno.env.get(…))` produces when the
    // env is unset, and fully type-legal) makes `len > NaN` false, so the
    // frame cap, the message-rate cap and the byte-rate cap were all simply
    // off, with not one log line.
    ...numericFields(src, "export type WsLimits = {"),
  ]);
  const missing = [...declared].filter((k) => !(k in NUMERIC_VALUES));
  assertEquals(
    missing,
    [],
    `numeric config key(s) with no range: add them to NUMERIC_VALUES`,
  );
  // …and nothing in the table that is not a real key: a typo'd entry checks
  // a key nobody can write, which is the same silence one step over.
  const stale = Object.keys(NUMERIC_VALUES).filter((k) => !declared.has(k));
  assertEquals(stale, [], "NUMERIC_VALUES names a key no config type has");
});

Deno.test("NUMERIC_VALUES: every spec says what to write instead", () => {
  // The four keys whose silence this table exists to end — named one by one,
  // so an emptied table is a red test rather than a loop that runs zero times.
  assert("maxConnections" in NUMERIC_VALUES, "maxConnections lost its range");
  assert(
    "fullStateThreshold" in NUMERIC_VALUES,
    "fullStateThreshold lost its range",
  );
  assert("effectTimeoutMs" in NUMERIC_VALUES, "effectTimeoutMs lost its range");
  assert(
    "persistDebounceMs" in NUMERIC_VALUES,
    "persistDebounceMs lost its range",
  );
  const entries = Object.entries(NUMERIC_VALUES);
  assert(
    entries.length >= 4,
    "the table is empty — every numeric key would boot unchecked",
  );
  for (const [k, spec] of entries) {
    assert(spec.what.length > 0, `${k}: no fix half`);
    assert(
      spec.max === undefined || spec.max >= spec.min,
      `${k}: empty range`,
    );
  }
});

// ── The predicate ─────────────────────────────────────────────────────

Deno.test("numericRefusal: type, wholeness, then range", () => {
  const spec = { min: 1, max: 10, integer: true, what: "1-10" };
  assertEquals(numericRefusal(5, spec), null);
  assertEquals(numericRefusal(1, spec), null, "min is inclusive");
  assertEquals(numericRefusal(10, spec), null, "max is inclusive");
  assertEquals(numericRefusal("5", spec), "not a number");
  assertEquals(numericRefusal(null, spec), "not a number");
  assertEquals(numericRefusal(NaN, spec), "not a number");
  assertEquals(numericRefusal(Infinity, spec), "not a number");
  assertEquals(numericRefusal(1.5, spec), "not a whole number");
  assertEquals(numericRefusal(0, spec), "below the minimum 1");
  assertEquals(numericRefusal(11, spec), "above the maximum 10");
  // No `integer`: a ratio is a number like any other.
  assertEquals(numericRefusal(0.5, { min: 0, max: 1, what: "a ratio" }), null);
});

// ── The four that booted ──────────────────────────────────────────────

Deno.test("validateConfig: maxConnections: 0 is refused, not a server that closes every client", () => {
  assertEquals(check("maxConnections", 0), 1);
  assertEquals(check("maxConnections", -1), 1);
  assertEquals(check("maxConnections", 2.5), 1);
  assertEquals(check("maxConnections", 1), null);
  assertEquals(check("maxConnections", 100), null);
});

Deno.test('validateConfig: fullStateThreshold: "half" is refused, not compared against a ratio forever', () => {
  assertEquals(check("fullStateThreshold", "half"), 1);
  assertEquals(check("fullStateThreshold", 1.5), 1);
  assertEquals(check("fullStateThreshold", -0.1), 1);
  assertEquals(check("fullStateThreshold", 0.5), null);
  assertEquals(check("fullStateThreshold", 0), null);
  assertEquals(check("fullStateThreshold", 1), null);
});

Deno.test('validateConfig: effectTimeoutMs: "abc" is refused, not a NaN ceiling', () => {
  assertEquals(check("effectTimeoutMs", "abc"), 1);
  assertEquals(check("effectTimeoutMs", -1), 1);
  assertEquals(check("effectTimeoutMs", 0), null, "0 = wait forever");
  assertEquals(check("effectTimeoutMs", 5000), null);
});

Deno.test("validateConfig: persistDebounceMs: -5 is refused, not handed to a timer", () => {
  assertEquals(check("persistDebounceMs", -5), 1);
  assertEquals(check("persistDebounceMs", 0), null);
  assertEquals(check("persistDebounceMs", 100), null);
});

Deno.test("validateConfig: port and window size get the same question", () => {
  assertEquals(check("port", 70000), 1);
  assertEquals(check("port", "8080"), 1);
  assertEquals(check("port", 8080), null);
  assertEquals(check("port", 0), null, "0 = let the runtime pick");
  assertEquals(check("width", 0), 1);
  assertEquals(check("height", "600"), 1);
  assertEquals(check("width", 900), null);
  assertEquals(check("height", 600), null);
});

Deno.test("validateConfig: an absent numeric key is not a refusal", () => {
  const f = fakeExit();
  validateConfig({ appId: "x" }, VALID_AIO_CONFIG_KEYS, "AioConfig", f.exit);
  assertEquals(f.result.code, null);
});

// ── Nested config objects ─────────────────────────────────────────────
//
// `validateConfig` used to check only the TOP level, and `ui` was recursed
// into by each CALLER. `wsLimits` — three numeric guards, every one of which a
// bad value turns OFF rather than tightens — was validated by nobody.

Deno.test("NESTED_CONFIGS: every nested object is validated by validateConfig itself", () => {
  assert("wsLimits" in NESTED_CONFIGS, "wsLimits lost its nested validation");
  assert("ui" in NESTED_CONFIGS, "ui lost its nested validation");
  const nested = Object.entries(NESTED_CONFIGS);
  assert(
    nested.length >= 2,
    "NESTED_CONFIGS emptied — the loop below would " +
      "prove nothing",
  );
  for (const [key, keysOf] of nested) {
    assert(
      VALID_AIO_CONFIG_KEYS.has(key),
      `${key} is not a config key at all`,
    );
    assert(keysOf().size > 0, `${key} has an empty key allowlist`);
  }
});

Deno.test("wsLimits: a value that DISABLES the guard is refused at boot", () => {
  for (const key of ["maxMessageBytes", "messagesPerSec", "bytesPerSec"]) {
    // The one an env var produces when it is unset.
    assertEquals(checkNested("wsLimits", key, NaN), 1, `${key}: NaN accepted`);
    assertEquals(checkNested("wsLimits", key, 0), 1, `${key}: 0 accepted`);
    assertEquals(checkNested("wsLimits", key, -1), 1, `${key}: -1 accepted`);
    assertEquals(
      checkNested("wsLimits", key, "1000"),
      1,
      `${key}: a string accepted`,
    );
    assertEquals(checkNested("wsLimits", key, 1000), null, `${key}: refused`);
  }
});

Deno.test("wsLimits: an unknown key inside it is named, not ignored", () => {
  assertEquals(checkNested("wsLimits", "maxMessageBytez", 1000), 1);
  assertEquals(checkNested("wsLimits", "messagesPerSec", 50), null);
});
