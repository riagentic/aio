// `am create` ends with the commands that take a fresh app to "running, and
// seen" — in the human output AND the JSON an agent reads. The first run is
// the step agents postpone (a field report: 13.7 min to the first start).
import { assertEquals } from "@std/assert";
import { nextSteps } from "../src/am/am-cmd-create.ts";

Deno.test("nextSteps: start in the background, then look — surface with a UI, state without", () => {
  assertEquals(nextSteps("demo", true), [
    "cd demo",
    "deno task am start",
    "deno task am surface",
  ]);
  assertEquals(nextSteps("tool", false)[2], "deno task am state");
});
