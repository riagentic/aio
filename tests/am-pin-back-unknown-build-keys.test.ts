// `am pin <older>` on an app a newer `am create` scaffolded: deno.json carries
// `build.electronRuntime`, which the older version's aiol reports as an
// unknown `build.*` key — an ERROR, so `deno task lint` failed with no word
// about the pin. `am pin` now reads the TARGET checkout's own key list and
// says which keys it does not know (never removes them: they are the user's).
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildKeysOf, unknownBuildKeysNote } from "../src/am/am-cmd-pin.ts";
import { VALID_BUILD_KEYS } from "../src/server/config.ts";

const CONFIG = fromFileUrl(new URL("../src/server/config.ts", import.meta.url));

Deno.test("buildKeysOf reads this checkout's VALID_BUILD_KEYS exactly", async () => {
  // The parser reads SOURCE; if config.ts changes shape, this goes red
  // before `am pin` silently stops warning.
  const keys = buildKeysOf(await Deno.readTextFile(CONFIG));
  assertEquals([...keys!].sort(), [...VALID_BUILD_KEYS].sort());
  assertEquals(buildKeysOf("export const nothing = 1;"), null);
});

Deno.test("unknownBuildKeysNote names the keys an older version lacks", () => {
  const older = buildKeysOf(`export const VALID_BUILD_KEYS = new Set<string>([
  "targets", // a comment with "quoted" text
  "platforms",
  "out",
]);`)!;
  assert(!older.has("quoted"), "a string inside a comment is not a key");
  const note = unknownBuildKeysNote("v1.0.20-beta", {
    targets: ["electron"],
    electronRuntime: "online",
  }, older);
  assert(note?.includes("build.electronRuntime"), String(note));
  assert(note?.includes("deno task lint"), String(note));
  assertEquals(
    unknownBuildKeysNote("v1", { targets: [] }, older),
    null,
    "all known",
  );
  assertEquals(unknownBuildKeysNote("v1", { x: 1 }, null), null, "unreadable");
});
