// Every `aio/ui` component must be NAMED on the page that promises "all
// exports".
//
// THE FINDING this exists for, and it is the round's root cause in miniature.
// A field report hand-rolled `Switch`, `Progress`, `EmptyState`, `Card`,
// `Row`/`Stack`, `Select`, `Field` and `Button` — plus ~889 lines of CSS — with
// every one of them one import away the whole time. Their own words:
//
//   "This is the highest-leverage item in the whole report and it is
//    documentation only — no code, no compatibility risk."
//
// And how they missed it, in the order they read things: quickstart (no
// mention), concepts (no mention), api-reference — "all exports" — where the
// Focused-imports block listed `aio/server`, `aio/testing` and `aio/air`, and
// not the kit. Two reports independently concluded the same thing about aio:
// "its features are consistently better than its discoverability."
//
// A doc line fixes it once. This test is what keeps it fixed: a component added
// to the kit and not to the page is a component the next author hand-rolls.
import { assertEquals } from "@std/assert";
import * as kit from "../src/ui/mod.ts";

const PAGE = new URL("../docs/basics/api-reference.md", import.meta.url);

/** The kit's public COMPONENT and helper names — what an app would import.
 *
 *  Types are excluded (a `*Props` interface is not something anyone goes
 *  looking for), and so are `_`-prefixed test seams. `Fragment` is re-exported
 *  for grouping and is documented on the JSX page, not here. */
function kitExports(): string[] {
  return Object.keys(kit)
    .filter((n) => !n.startsWith("_") && n !== "Fragment")
    .sort();
}

Deno.test("kit: every aio/ui export is named in api-reference.md", async () => {
  const page = await Deno.readTextFile(PAGE);
  const missing = kitExports().filter((n) =>
    !new RegExp(`\\b${n}\\b`).test(page)
  );
  assertEquals(
    missing,
    [],
    `these ship from \`aio/ui\` and the page that promises "all exports" does ` +
      `not name them — which is exactly how one app came to hand-roll eight ` +
      `components that were already in its import map. Add them to the kit ` +
      `table in docs/basics/api-reference.md.`,
  );
});

Deno.test("kit: the page points at the kit's own guide and at styling", async () => {
  const page = await Deno.readTextFile(PAGE);
  // Naming the components is half of it; a reader who wants one needs the two
  // pages that answer "how do I style this" — the fork the reporting app was
  // standing at when it chose to write 889 lines of CSS instead.
  for (const ref of ["ui/kit.md", "ui/theme.md", "ui/css-toolchain.md"]) {
    assertEquals(
      page.includes(ref),
      true,
      `api-reference.md must link ${ref} from the kit section`,
    );
  }
});
