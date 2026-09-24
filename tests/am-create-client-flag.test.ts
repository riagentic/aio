// `am create --client=` is the spelling (field report (a desktop agent app) §4).
//
// alpha70 renamed deno.json's `target` to `client`, and `deno task dev
// --client=X` and `am fix`'s notes say `client` — but `am create ref
// --client=electron` answered "unknown flag --client". `--target=` stays, as
// the old spelling. Driven through `parseGlobalFlags` first, because that is
// the path a typed flag takes (the `--force` lesson: a parser-only test stayed
// green while the global parser swallowed the flag).
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseCreateArgs } from "../src/am/am-cmd-create.ts";
import { parseGlobalFlags } from "../src/am/am-utils.ts";
import { CREATE_FLAGS, HELP_TEXT } from "../src/am/am-help-text.ts";

const viaCli = (...argv: string[]) =>
  parseCreateArgs(parseGlobalFlags(["create", ...argv]).args);

Deno.test("am create: --client= picks the target, --target= stays an alias", () => {
  assertEquals(viaCli("ref", "--client=electron").target, "electron");
  assertEquals(viaCli("ref", "--target=electron").target, "electron");
  // both, agreeing: fine; a cli template's own default does not override it
  assertEquals(
    viaCli("ref", "--client=server", "--target=server").target,
    "server",
  );
  assertEquals(
    viaCli("ref", "--template=cli", "--client=browser").target,
    "browser",
  );
  const e = assertThrows(() => viaCli("ref", "--client=nope")) as Error;
  assertStringIncludes(e.message, "unknown --client=nope");
});

Deno.test("am create: --client= and --target= that disagree refuse, naming both", () => {
  const e = assertThrows(() =>
    viaCli("ref", "--target=android", "--client=electron")
  ) as Error;
  assertStringIncludes(e.message, "--target=android");
  assertStringIncludes(e.message, "--client=electron");
});

Deno.test("am create: help and refusal document --client= as the spelling", () => {
  assertEquals(CREATE_FLAGS.some((f) => f.startsWith("--client=<")), true);
  assertStringIncludes(HELP_TEXT, "--client picks what");
});
