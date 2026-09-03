// Three public option types that could never be narrowed or widened again
// after beta1, and one rule they all serve: the TYPE and the RUNTIME must
// accept the same values.
//
//   • `AioApp.mode?: string` had exactly one value ever, `"standalone"`
//     (src/standalone-air.ts is the only writer). `string` froze would have
//     frozen with the surface — no autocomplete for a CLOSED set, and
//     `app.mode === "standlone"` silently false forever.
//   • `perfCheck?: "on" | "off"` was the ONE string-boolean among ~14 boolean
//     switches, and internally already a boolean
//     (`composeCells([cell], { perfCheck: false })`). Widening to
//     `boolean | "on" | "off"` is additive — but ONLY if the boot validator
//     accepts the new spelling too, or the type would accept what the app
//     refuses.
//   • `CellStatus.status: string | undefined` forced every builder of a
//     status row to write `status: undefined` out loud.
//
// (audit a16/14)
import { assertEquals, assertThrows } from "@std/assert";
import {
  BOOLEAN_ALSO,
  ENUM_VALUES,
  VALID_AIO_CONFIG_KEYS,
  validateConfig,
} from "../src/server/config.ts";
import { perfCheckOn } from "../src/state/dispatch.ts";
import type { PerfCheck } from "../src/state/dispatch.ts";
import type { CellStatus } from "../src/state/cell-compose-types.ts";
import { fromFileUrl } from "@std/path";

/** `validateConfig` calls `exit` on refusal; make that observable. */
const exit = ((c: number) => {
  throw new Error(`exit(${c})`);
}) as (c: number) => never;

Deno.test("perfCheck: every spelling the type accepts is a spelling boot accepts", () => {
  const accepted: PerfCheck[] = ["on", "off", true, false];
  for (const v of accepted) {
    // Throws only through the exit stub — so a refusal fails here loudly.
    validateConfig({ perfCheck: v }, VALID_AIO_CONFIG_KEYS, "config", exit);
  }
  // …and a value NEITHER spelling names is still refused. Widening a type must
  // not turn a validator off.
  assertThrows(
    () =>
      validateConfig(
        { perfCheck: "yes" },
        VALID_AIO_CONFIG_KEYS,
        "config",
        exit,
      ),
    Error,
    "exit(1)",
  );
  assertThrows(
    () =>
      validateConfig({ perfCheck: 1 }, VALID_AIO_CONFIG_KEYS, "config", exit),
    Error,
    "exit(1)",
  );
});

Deno.test("perfCheck: ONE reader decides, and false means off", () => {
  // The bug this function exists to make impossible: `false !== "off"` is
  // true, so every hand-written `perfCheck !== "off"` site read a widened
  // boolean as ON — silently, and only in the build that adopted the new
  // spelling.
  assertEquals(perfCheckOn(undefined), true, "absent = on (the default)");
  assertEquals(perfCheckOn("on"), true);
  assertEquals(perfCheckOn(true), true);
  assertEquals(perfCheckOn("off"), false);
  assertEquals(perfCheckOn(false), false);
});

Deno.test('perfCheck: no `!== "off"` test survives outside the one reader', async () => {
  // The structural half. A new site that spells the check by hand is exactly
  // the regression above, so it fails here rather than at a user's app.
  const root = fromFileUrl(new URL("../src/", import.meta.url));
  const offenders: string[] = [];
  async function* ts(dir: string): AsyncGenerator<string> {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) yield* ts(p);
      else if (e.name.endsWith(".ts")) yield p;
    }
  }
  for await (const path of ts(root)) {
    if (path.endsWith("/state/dispatch.ts")) continue; // the reader's home
    const text = await Deno.readTextFile(path);
    for (const line of text.split("\n")) {
      if (/^\s*(\/\/|\*)/.test(line)) continue; // a comment may quote it
      if (/perfCheck\s*!==\s*"off"|perfCheck\s*===\s*"on"/.test(line)) {
        offenders.push(`${path.slice(root.length)}: ${line.trim()}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "perfCheck has more than one decider. Use `perfCheckOn(v)` from " +
      'state/dispatch.ts — a hand-written `!== "off"` reads `false` as ON.',
  );
});

Deno.test("BOOLEAN_ALSO names only keys that are also in ENUM_VALUES", () => {
  // A key listed as "also a boolean" but absent from the enum table would be
  // an exemption from a check that never ran — a rule about nothing.
  //
  // …and so would an EMPTY set: the loop below would run zero times and this
  // test would report success about nothing. So the membership is pinned by
  // name. The widening is meant to land in exactly one place (config.ts's
  // comment says so), so a second entry here is a deliberate act that updates
  // this line and states which key gained a boolean spelling.
  assertEquals(
    [...BOOLEAN_ALSO],
    ["perfCheck"],
    "BOOLEAN_ALSO changed — `perfCheck` is the one key that also accepts a " +
      "boolean; add the new key here and say why it needs the widening",
  );
  for (const key of BOOLEAN_ALSO) {
    assertEquals(
      Object.hasOwn(ENUM_VALUES, key),
      true,
      `BOOLEAN_ALSO names "${key}", which ENUM_VALUES does not validate at all`,
    );
  }
});

Deno.test("AioApp.mode is the closed union, not bare string", async () => {
  const src = await Deno.readTextFile(
    fromFileUrl(new URL("../src/server/aio-types.ts", import.meta.url)),
  );
  // The declaration, read from the source: `string` here is the regression.
  const m = /\n  mode\?:\s*([^;]+);/.exec(src);
  assertEquals(m?.[1]?.trim(), '"standalone"');
  // And the only writer still writes exactly that word.
  const standalone = await Deno.readTextFile(
    fromFileUrl(new URL("../src/standalone-air.ts", import.meta.url)),
  );
  assertEquals(standalone.includes('mode: "standalone"'), true);
});

Deno.test("CellStatus builds without spelling `status: undefined`", () => {
  // The whole widening, as the line that used to be a type error.
  const row: CellStatus = { name: "todos", enabled: true, errors: 0 };
  assertEquals(row.status, undefined);
  // …and the old spelling still compiles, because widening takes nothing away.
  const explicit: CellStatus = {
    name: "todos",
    status: undefined,
    enabled: true,
    errors: 0,
  };
  assertEquals(explicit.status, undefined);
});
