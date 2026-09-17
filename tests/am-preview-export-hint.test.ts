// `am preview src/App.tsx --export=App` on `export default function App` was
// refused with "components exported here: default" — a list that named the
// very thing the caller wanted under a spelling nobody guesses. The way in
// (`--export=default`, or no flag at all) is now part of the refusal.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { previewExportRefusal } from "../src/am/am-cmd-preview.ts";

const REFUSAL = `preview: /app/src/App.tsx exports no component named "App" ` +
  `— components exported here: default`;

Deno.test("am preview: a miss on a default-exported module names --export=default", () => {
  const msg = previewExportRefusal(REFUSAL);
  assertStringIncludes(msg, REFUSAL, "the renderer's own text stays");
  assertStringIncludes(msg, "--export=default");
  assertStringIncludes(msg, "am preview <file>", "…and the no-flag form");
});

Deno.test("am preview: a module with named exports gets the plain list", () => {
  const named = REFUSAL.replace("default", "Card, Row");
  assertEquals(previewExportRefusal(named), named);
  // `default` among named exports still earns the hint — it is there.
  assertStringIncludes(
    previewExportRefusal(REFUSAL.replace("default", "Card, default")),
    "--export=default",
  );
});

Deno.test("am preview: any other error passes through untouched", () => {
  const other = "surface: failed to import UI entry /x.tsx: SyntaxError";
  assertEquals(previewExportRefusal(other), other);
});
