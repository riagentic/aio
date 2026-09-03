// Every flag a CLI parser ACCEPTS is a flag a doc TEACHES.
//
// The three parsers are tables (`AIO_RUNTIME_FLAG_SPECS` in runtime-flags.ts, the *_FLAGS arrays in
// build-flags.ts) and the help text of `am` is one string — so "which flags
// exist" is a fact the source states, and the docs must not answer it with a
// shorter list. An undocumented flag is one nobody can ask for; the audit that
// wrote this gate found 14 runtime flags and 6 build flags in that state, and
// 16 `am` verbs. This makes the class unshippable, not the instances.
import { assertEquals } from "@std/assert";
import {
  BUILD_BOOL_FLAGS,
  BUILD_VALUE_FLAGS,
  FLEET_BOOL_FLAGS,
  FLEET_VALUE_FLAGS,
  SHIP_BOOL_FLAGS,
  SHIP_VALUE_FLAGS,
} from "../src/build/build-flags.ts";
import { HELP_TEXT } from "../src/am/am-help-text.ts";
// ONE parser for "what is an `am` verb", shared with the surface lock in
// scripts/api-snapshot.ts — a second copy here would let the docs gate and the
// compat gate disagree about which verbs exist.
import { helpEntryVerbs } from "../scripts/api-snapshot.ts";
import { AIO_RUNTIME_FLAG_SPECS } from "../src/diagnostics/runtime-flags.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const read = (rel: string) => Deno.readTextFile(`${ROOT}${rel}`);

/** The runtime flags, read from the ONE table aio-cli.ts itself parses
 *  (`AIO_RUNTIME_FLAG_SPECS` in src/diagnostics/runtime-flags.ts) — not from
 *  a copy of it here (a copy would be the second decider this gate exists to
 *  forbid). Internal flags (`--__aio-…`) are the runtime's, never a user's. */
export function runtimeFlags(): string[] {
  return [
    ...new Set(AIO_RUNTIME_FLAG_SPECS.map((spec) => spec.replace(/=$/, ""))),
  ].filter((f) => !f.startsWith("--__"));
}

/** `--flag` mentioned as a flag — followed by `=`, `[`, a backtick, a space,
 *  or end — so `--no-tls` does not satisfy `--no-tls-please`. */
const documented = (doc: string, flag: string) =>
  new RegExp(`${flag.replace(/-/g, "\\-")}(?![a-z-])`).test(doc);

Deno.test("docs: every runtime flag aio-cli.ts accepts is in dev-mode.md", async () => {
  const flags = runtimeFlags();
  if (flags.length < 30) throw new Error(`parse too small: ${flags.length}`);
  const doc = await read("docs/build/dev-mode.md");
  assertEquals(flags.filter((f) => !documented(doc, f)), []);
});

Deno.test("docs: every build/fleet/ship flag is in targets.md", async () => {
  const doc = await read("docs/build/targets.md");
  const flags = [
    ...BUILD_BOOL_FLAGS,
    ...BUILD_VALUE_FLAGS,
    ...FLEET_BOOL_FLAGS,
    ...FLEET_VALUE_FLAGS,
    ...SHIP_BOOL_FLAGS,
    ...SHIP_VALUE_FLAGS,
  ];
  assertEquals([...new Set(flags)].filter((f) => !documented(doc, f)), []);
});

Deno.test("docs: every `am` verb in HELP_TEXT is in app-manager.md", async () => {
  const verbs = helpEntryVerbs(HELP_TEXT);
  if (verbs.length < 40) throw new Error(`parse too small: ${verbs.length}`);
  const doc = await read("docs/clients/app-manager.md");
  const missing = verbs.filter((v) => !new RegExp(`\\bam ${v}\\b`).test(doc));
  assertEquals(missing, []);
});
