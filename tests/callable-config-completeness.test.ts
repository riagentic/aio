// Every function-valued config key must be one the runtime CHECKS is a function.
//
// `validateCallableConfig` (src/server/config.ts) and the `cell()` twin each
// police a hand-written list of keys. A hand-written list is a list that
// drifts: add `onPause?: () => void` to AioConfig tomorrow and the guard
// silently does not cover it, so a typo'd import lands back where it started —
// a hook that never runs and never says so.
//
// The keys come from the compiler's own view of the types (`deno doc --json`,
// via tests/typed-keys-helper.ts), not from reading the source text. The first
// version of this test used a regex and reported `long?: (keyof M & string)[]`
// as a function, because `key?: (` does not mean "function" — which is the
// whole reason the extraction now lives in one place with the sibling gate.
import { assertEquals } from "@std/assert";
import { typedProps } from "./typed-keys-helper.ts";

const TYPES = "src/server/aio-types.ts";
const CELL_TYPES = "src/state/cell-config-types.ts";

/** Public, optional, function-valued keys — what an app writes as a hook. */
async function callableKeys(file: string, type: string): Promise<string[]> {
  return (await typedProps(file, type))
    .filter((p) => p.isFn && p.optional && !p.name.startsWith("_"))
    .map((p) => p.name);
}

Deno.test("every callable AioConfig key is on the runtime's checked list", async () => {
  const { _CALLABLE_CONFIG_KEYS } = await import("../src/server/config.ts");
  const declared = new Set([
    ...await callableKeys(TYPES, "AioConfig"),
    ...await callableKeys(TYPES, "CellsConfig"),
  ]);
  const unchecked = [...declared].filter((k) =>
    !(_CALLABLE_CONFIG_KEYS as readonly string[]).includes(k)
  );
  assertEquals(
    unchecked,
    [],
    `these config keys hold a function but validateCallableConfig does not ` +
      `check them, so a typo'd import stays silent: ${unchecked.join(", ")}. ` +
      `Add them to _CALLABLE_CONFIG_KEYS in src/server/config.ts.`,
  );
});

Deno.test("every callable cell() key is on the runtime's checked list", async () => {
  const { _CALLABLE_CELL_KEYS } = await import("../src/state/cell-create.ts");
  const declared = await callableKeys(CELL_TYPES, "MethodsCellConfig");
  const unchecked = declared.filter((k) =>
    !(_CALLABLE_CELL_KEYS as readonly string[]).includes(k)
  );
  assertEquals(
    unchecked,
    [],
    `these cell() keys hold a function but cell() does not check them: ` +
      `${unchecked.join(", ")}. Add them to _CALLABLE_CELL_KEYS.`,
  );
});

Deno.test("validateSchedules knows every key ScheduleDef declares", async () => {
  // The mirror image of the checks above, and the more dangerous direction: a
  // key added to `ScheduleDef` but not to SCHEDULE_KEYS is refused as unknown,
  // so a legitimate config becomes a boot failure with a did-you-mean pointing
  // at nothing. That is the class tests/config-allowlist.test.ts was written
  // for; `schedules:` validation arrived later and brought its own list.
  const { SCHEDULE_KEYS } = await import("../src/state/schedule.ts");
  const declared = (await typedProps("src/state/schedule.ts", "ScheduleDef"))
    .map((p) => p.name);
  const unknown = declared.filter((k) => !SCHEDULE_KEYS.has(k));
  assertEquals(
    unknown,
    [],
    `ScheduleDef declares ${unknown.join(", ")}, which validateSchedules ` +
      `would refuse as an unknown key. Add them to SCHEDULE_KEYS.`,
  );
});
