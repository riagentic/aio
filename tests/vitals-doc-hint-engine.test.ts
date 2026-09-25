// docs/debugging/vitals.md drew a CLIENT-side hint engine, client
// DiagReporter and client `onVitalAlert` — none of which exist: the browser
// never calls `evaluateHints` and has no reporter. The doc must say what runs,
// and this pins both halves of that claim together.
import { assert, assertEquals } from "@std/assert";

const DOC = new URL("../docs/debugging/vitals.md", import.meta.url);

Deno.test("vitals doc: the hint engine is documented as server-only, matching the code", async () => {
  // The code half: nothing the browser loads calls the hint engine.
  const callers: string[] = [];
  let scanned = 0;
  const dir = new URL("../src/browser/", import.meta.url);
  for (const e of Deno.readDirSync(dir)) {
    if (!e.isFile || !e.name.endsWith(".ts")) continue;
    scanned++;
    if (Deno.readTextFileSync(new URL(e.name, dir)).includes("evaluateHints")) {
      callers.push(e.name);
    }
  }
  assert(scanned > 10, `walked only ${scanned} browser files`);
  assertEquals(
    callers,
    [],
    "the browser now calls evaluateHints — update the doc",
  );

  // The doc half: no client-column hint engine, reporter or alert callback.
  const doc = await Deno.readTextFile(DOC);
  for (
    const lie of [
      "| HintEngine               |",
      "DiagReporter (client)",
      "| onVitalAlert callback    |",
      "VitalsSnapshot assembled",
      "with the hint engine's line",
    ]
  ) {
    assert(!doc.includes(lie), `doc still claims a client-side piece: ${lie}`);
  }
  assert(doc.includes("HintEngine (server only)"));
});
