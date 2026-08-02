// `am surface` cut element text at 80 characters with NO marker,
// so a generated command line read as a complete (wrong) string — the reporter
// had to recompute it in a scratch script. A truncation you cannot see is the
// silent-failure pattern this framework exists to avoid.
//
// Now: every cut is marked with "…", and `am surface --full` lifts the cap.
import { assert, assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";

const LONG =
  "cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF " +
  "-DGGML_CUDA_FORCE_MMQ=ON -DCMAKE_CUDA_ARCHITECTURES=86 --parallel 16";

function App() {
  return <div class="cmd">{LONG}</div>;
}

Deno.test("surface: a truncated value is marked, never silently cut", async () => {
  await using ui = await testUI(App);
  const s = JSON.stringify(ui.surface());
  assert(
    s.includes("…"),
    "a cut must be visible in the surface — otherwise a partial command line " +
      `reads as the whole thing:\n${s.slice(0, 300)}`,
  );
  assert(!s.includes(LONG), "the default surface stays scannable");
});

// every surface-text assertion used to carry `?? ""` noise, because
// a component with no text reported UNKNOWN text. Empty is not unknown.
function Empty() {
  return (
    <div>
      <button type="button" onClick={() => {}}></button>
    </div>
  );
}

Deno.test("surface: text is always a string — empty, never undefined", async () => {
  await using ui = await testUI(Empty);
  const s = ui.surface();
  assertEquals(s.text, "", "a component that renders no text has empty text");
  assertEquals(
    s.elements[0]?.text,
    "",
    "and so does an element with no content",
  );
  // The wire copy carries the same guarantee — `am surface --json` consumers
  // read one shape, not two.
  const { getSerializedSurfaces } = await import("../src/air/ui-remote.ts");
  for (const node of getSerializedSurfaces()) {
    assertEquals(typeof node.text, "string");
    for (const el of node.elements) assertEquals(typeof el.text, "string");
  }
});

Deno.test("surface: --full returns the whole string", async () => {
  // The exact path `am surface --full` takes: trojan `?full=1` →
  // getSerializedSurfaces(true) → buildUISurface({ maxText: lifted }).
  const { getSerializedSurfaces } = await import("../src/air/ui-remote.ts");
  await using ui = await testUI(App);
  const capped = JSON.stringify(getSerializedSurfaces());
  const full = JSON.stringify(getSerializedSurfaces(true));
  assert(!capped.includes(LONG), "the default stays scannable");
  assert(capped.includes("…"), "and says it cut something");
  assert(
    full.includes(LONG),
    `--full must return the whole string:\n${full.slice(0, 240)}`,
  );
  void ui;
});
