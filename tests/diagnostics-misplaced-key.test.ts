// A diagnostics switch written where nothing reads it is said out loud.
//
// `diagnostics` is `boolean | { dev?, prod?, onDiagnostic? }` — the switches
// live one level down, per mode. `diagnostics: { checkpoint: false }` booted,
// was read by nothing, and the app kept writing the checkpoint it had just
// turned off (the full state, to disk, in dev). Three tests in this repo had
// written it that way and passed on the defaults. It WARNS rather than refuses
// (config.ts `diagnosticsConfigProblems`): the spelling has always booted, and
// the surface is frozen.
//
// Asserted through a REAL `aio.run` — the config bridge renames `diagnostics`
// to `_diagnostics` on the way in, and a check that only works on the unit
// function is the trap `tests/config-bridge-completeness.test.ts` exists for.
import { assert, assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { log } from "../src/diagnostics/logger.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { diagnosticsConfigProblems } from "../src/server/config.ts";
import { DEV_DEFAULTS } from "../src/diagnostics/types.ts";

async function bootWarnings(diagnostics: unknown): Promise<string[]> {
  const { cell, aio } = await import("../mod.ts");
  const said: string[] = [];
  // deno-lint-ignore no-explicit-any
  const L = log as any;
  const orig = L.warn;
  L.warn = (...a: unknown[]) => void said.push(a.map(String).join(" "));
  try {
    const c = cell(`dmk${crypto.randomUUID().slice(0, 6)}`, {
      state: { n: 0 },
      methods: {},
    });
    const app = await aio.run({
      cells: [c],
      appId: `dmk-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port: freePort(),
      baseDir: await tempDir("dmk-"),
      diagnostics,
    } as never);
    await (app as { close(): Promise<void> }).close();
  } finally {
    L.warn = orig;
  }
  return said.filter((l) => l.includes("diagnostics."));
}

Deno.test("diagnostics: a switch at the top level is named, with where it goes", async () => {
  const said = await bootWarnings({ checkpoint: false, actionLog: false });
  const all = said.join("\n");
  assert(
    all.includes('did you mean "diagnostics.dev.checkpoint"?'),
    `a misplaced diagnostics.checkpoint booted in silence:\n${all}`,
  );
  assert(all.includes('"diagnostics.dev.actionLog"'), all);
});

Deno.test("diagnostics: a typo inside a mode is named too", async () => {
  const all = (await bootWarnings({ dev: { chekpoint: false } })).join("\n");
  assert(
    all.includes('did you mean "diagnostics.dev.checkpoint"?'),
    `diagnostics.dev.chekpoint booted in silence:\n${all}`,
  );
});

Deno.test("diagnostics: every valid spelling boots with nothing to say", async () => {
  for (
    const ok of [
      true,
      false,
      undefined,
      { dev: { checkpoint: false }, prod: { actionLog: true } },
      { onDiagnostic: () => {} },
    ]
  ) {
    assertEquals(await bootWarnings(ok), [], `warned about ${String(ok)}`);
  }
});

Deno.test("diagnostics: the check knows every option the defaults declare", () => {
  // One list: the validator reads DEV_DEFAULTS' keys, so a new option can
  // never be reported as misplaced-and-unknown.
  const keys = Object.keys(DEV_DEFAULTS);
  assert(keys.length > 5, "DEV_DEFAULTS lists the options");
  for (const k of keys) {
    assertEquals(
      diagnosticsConfigProblems(
        { dev: { [k]: true } },
        Object.keys(DEV_DEFAULTS),
      ),
      [],
      k,
    );
  }
});
