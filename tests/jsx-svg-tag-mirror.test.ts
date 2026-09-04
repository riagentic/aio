// SVG_TAG_LIST (the RUNTIME namespace switch) and the `AioSVGAttributes` block
// in jsx-runtime.ts (the TYPES) are one fact with two homes. Both files say
// "keep the two in sync" / "must mirror" — and nothing checked it, so a tag
// added to one and not the other fails SILENTLY in whichever direction:
//
//   missing from the type block  → falls through to the HTML catch-all and
//                                  rejects every SVG attribute at compile time
//   missing from SVG_TAG_LIST    → createElement (HTML namespace) instead of
//                                  createElementNS, so the element has no SVG
//                                  box and renders nothing
//
// This is the gate. Add a tag to both, or to neither.
import { assertEquals } from "@std/assert";
import { SVG_TAG_LIST } from "../src/air/vdom-types.ts";

const SRC = new URL("../src/jsx-runtime.ts", import.meta.url);

Deno.test("SVG_TAG_LIST and jsx-runtime's SVG type block name the same tags", async () => {
  const src = await Deno.readTextFile(SRC);
  const start = src.indexOf("// SVG — must mirror SVG_TAG_LIST");
  assertEquals(
    start >= 0,
    true,
    "the SVG block's marker comment moved — update this gate with it",
  );
  const block = src.slice(start, src.indexOf("\n}", start));
  const typed = new Set(
    [...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*): AioSVGAttributes;/gm)]
      .map((m) => m[1]!),
  );
  const runtime = new Set<string>(SVG_TAG_LIST);
  const missingType = [...runtime].filter((t) => !typed.has(t)).sort();
  const missingRuntime = [...typed].filter((t) => !runtime.has(t)).sort();
  assertEquals(
    missingType,
    [],
    "in SVG_TAG_LIST but not typed as SVG in jsx-runtime.ts",
  );
  assertEquals(
    missingRuntime,
    [],
    "typed as SVG in jsx-runtime.ts but not in SVG_TAG_LIST",
  );
  assertEquals(typed.size > 40, true, `only ${typed.size} tags parsed`);
});
