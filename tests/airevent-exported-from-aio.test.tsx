// `AirEvent` — the type every JSX handler error names — is importable from
// `"aio"`, beside `JSX` (report 9b §6).
//
// A handler annotated by hand fails with `… is not assignable to type
// '(e: AirEvent<HTMLInputElement, Event>) => void'`, and
// `import type { AirEvent } from "aio"` was TS2305: it lived only on
// `aio/jsx-runtime`, which no doc names. The run that hit it went back to an
// untyped `(e)`. This file does not type-check without the export.
import { assertEquals } from "@std/assert";
import type { AirEvent, JSX } from "../mod.ts";
import type { AirEvent as RuntimeAirEvent } from "../src/jsx-runtime.ts";
import { testUI } from "../src/testing/ui-test.ts";

/** Exact type identity — not mere assignability. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
const same: Equal<
  AirEvent<HTMLInputElement, Event>,
  RuntimeAirEvent<HTMLInputElement, Event>
> = true;

const seen: boolean[] = [];

// The report's shape: a checkbox handler, annotated with the name the error
// printed.
function Toggle(): JSX.Element {
  return (
    <label>
      Done
      <input
        type="checkbox"
        aria-label="Done"
        onChange={(e: AirEvent<HTMLInputElement, Event>) =>
          seen.push(e.currentTarget.checked)}
      />
    </label>
  );
}

testUI(Toggle, "an AirEvent handler imported from aio runs", async (ui) => {
  assertEquals(same, true);
  ui.DoneCheckbox.click();
  await ui.settle();
  assertEquals(seen, [true]);
});
