// Bug hunt r2: surface name derivation.
import { assertEquals, assertNotEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";

// (1) Combining marks are part of a word (\p{M} is ID_Continue in JS
// identifiers), but `pascal()` treats them as separators and DROPS them. So a
// Thai "ปิด" (Close) button is named "ปดButton", and two different Devanagari
// labels that differ only in a vowel sign collapse onto one name.
function Thai() {
  return (
    <div>
      <button type="button" onClick={() => {}}>ปิด</button>
    </div>
  );
}

Deno.test("names: a Thai label keeps its vowel marks", async () => {
  await using ui = await testUI(Thai);
  const names = ui.surface().elements.map((e) => e.name);
  assertEquals(names, ["ปิดButton"]);
});

function Hindi() {
  return (
    <div>
      <button type="button" onClick={() => {}}>काम</button>
      <button type="button" onClick={() => {}}>कम</button>
    </div>
  );
}

Deno.test("names: two Devanagari labels differing by a vowel sign stay distinct", async () => {
  await using ui = await testUI(Hindi);
  const [a, b] = ui.surface().elements.map((e) => e.name);
  assertEquals(a, "कामButton");
  assertNotEquals(a, "कमButton");
  assertEquals(b, "कमButton");
});

// (2) An EMPTY aria-label is no accessible name (accname: an empty
// aria-label is skipped and computation falls through to content). The walk
// uses `??`, so `aria-label=""` blocks the visible text AND the placeholder:
// `<button aria-label="">Save</button>` comes out as the bare "Button".
function EmptyAria() {
  return (
    <div>
      <button type="button" aria-label="" onClick={() => {}}>Save</button>
      <input aria-label="" placeholder="Title" />
    </div>
  );
}

Deno.test("names: an empty aria-label falls through to text / placeholder", async () => {
  await using ui = await testUI(EmptyAria);
  const names = ui.surface().elements.map((e) => e.name);
  assertEquals(names, ["SaveButton", "TitleInput"]);
});
