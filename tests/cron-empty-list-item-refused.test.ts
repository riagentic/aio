// Bug hunt r2 (effects & lifecycle): an EMPTY list element in a cron field
// ("5," / "1,,15") is parsed as the value 0, because `Number("") === 0`.
// A trailing-comma typo in the minute field silently adds :00 fires, in the
// hour field a midnight fire — where every other malformed field ("5-",
// "*/0", "abc") is refused loudly with the field named ("fail loud").
import { assertEquals, assertThrows } from "@std/assert";
import { parseCron, schedule } from "../src/state/schedule.ts";

Deno.test("r2 hunt: cron minute field '5,' is refused, not read as 0 and 5", () => {
  let minute: number[] | undefined;
  try {
    minute = parseCron("5, 9 * * *").minute;
  } catch {
    return; // refused loudly — the correct outcome
  }
  // If it parses, it must at least not invent minute 0.
  assertEquals(minute, [5], `"5," parsed as minutes ${JSON.stringify(minute)}`);
});

Deno.test("r2 hunt: cron hour field '9,,17' does not add a midnight fire", () => {
  assertThrows(
    () => parseCron("0 9,,17 * * *"),
    Error,
    "hour",
  );
});

Deno.test("r2 hunt: schedule.cron refuses a trailing-comma pattern at the call site", () => {
  assertThrows(() => schedule.cron("r2:daily", "30, 8 * * *", { type: "x:y" }));
});
