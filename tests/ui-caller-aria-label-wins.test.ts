// kit.md: extra attributes (`aria-*`, `data-*`) pass through "as an escape
// hatch — they never fight your markup". Spinner, Avatar and Pagination spread
// the caller's props BEFORE their own defaults, so `<Spinner aria-label="Saving">`
// was still announced "Loading", and two pagers on one page could not be told
// apart. The caller's attribute now wins; the default stays the fallback.
import { assert } from "@std/assert";
import { h, renderToString } from "../src/air/vdom.ts";
import { Avatar, Pagination, Spinner } from "../src/ui/mod.ts";

const html = (c: unknown, p: Record<string, unknown>): string =>
  renderToString(h(c as never, p) as never);

Deno.test("kit: a caller's aria-label wins over Spinner/Avatar/Pagination defaults", () => {
  const cases: [unknown, Record<string, unknown>, string, string][] = [
    [Spinner, {}, "Saving", "Loading"],
    [Avatar, { name: "Ada Lovelace" }, "Ada Lovelace (online)", "Ada Lovelace"],
    [
      Pagination,
      { page: 1, pages: 3, onPage: () => {} },
      "Results pages",
      "Pagination",
    ],
  ];
  for (const [c, p, mine, dflt] of cases) {
    const own = html(c, { ...p, "aria-label": mine });
    assert(own.includes(`aria-label="${mine}"`), own);
    assert(!own.includes(`aria-label="${dflt}"`), own);
    assert(html(c, p).includes(`aria-label="${dflt}"`), "default kept");
  }
});
