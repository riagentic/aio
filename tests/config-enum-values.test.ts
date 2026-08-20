// The enumerated-VALUE allowlist and the TYPE must name the same values.
//
// `ui.theme: "full"` is documented, typed, tested at the shell — and exited(1)
// at boot from the day it shipped, because `ENUM_VALUES.theme` listed only
// `["auto", "none"]`. A key allowlist catches a misspelled KEY; this list is
// the only thing that catches a misspelled VALUE, and a missing member there
// is not leniency — it is a working feature refused at startup.
//
// So the two are compared rather than kept in step by hand: the union in
// `aio-types.ts` (erased at runtime — the source IS the only place to read it)
// against the runtime list the validator uses.
import { assertEquals } from "@std/assert";
import {
  ENUM_VALUES,
  VALID_UI_KEYS,
  validateConfig,
} from "../src/server/config.ts";

const SRC = new URL("../src/server/aio-types.ts", import.meta.url);

/** The string members of `export type <name> = "a" | "b" | …;`. */
function unionMembers(src: string, name: string): string[] {
  const m = src.match(
    new RegExp(`export type ${name} =([^;]+);`),
  );
  if (!m) throw new Error(`type ${name} not found — did it move or rename?`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** Inline unions on a UiConfig field: `<field>?: "a" | "b" | "c";`. */
function fieldMembers(src: string, field: string): string[] {
  const m = src.match(new RegExp(`\\n  ${field}\\?:([^;]+);`));
  if (!m) throw new Error(`UiConfig.${field} not found`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

Deno.test("ENUM_VALUES.theme names every UiTheme member", async () => {
  const src = await Deno.readTextFile(SRC);
  assertEquals(
    [...ENUM_VALUES.theme!].sort(),
    unionMembers(src, "UiTheme").sort(),
  );
});

Deno.test("ENUM_VALUES.chrome names every ui.chrome member", async () => {
  const src = await Deno.readTextFile(SRC);
  assertEquals(
    [...ENUM_VALUES.chrome!].sort(),
    fieldMembers(src, "chrome").sort(),
  );
});

Deno.test("every documented ui.theme value actually boots", async () => {
  const src = await Deno.readTextFile(SRC);
  const exit = ((c: number) => {
    throw new Error(`exit(${c})`);
  }) as (c: number) => never;
  for (const theme of unionMembers(src, "UiTheme")) {
    // Throws only through the exit stub — a refused value fails here loudly,
    // which is the whole point: `"full"` was refused for two releases.
    validateConfig({ theme }, VALID_UI_KEYS, "ui", exit);
  }
});
