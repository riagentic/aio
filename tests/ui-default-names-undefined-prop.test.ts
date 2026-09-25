// A caller's `aria-label`/`title`/`role` of `undefined` keeps the kit's
// default name, as it did on 1.0.11.
//
// Letting the caller's attribute win (ui-caller-aria-label-wins.test.ts) spread
// it AFTER the defaults — so the ordinary wrapper `<Spinner
// aria-label={props.label} />` with no label passed `undefined` over "Loading"
// and the status (or the avatar, the pager landmark) lost its name entirely.
import { assert } from "@std/assert";
import { h, renderToString } from "../src/air/vdom.ts";
import { Avatar, Pagination, Spinner } from "../src/ui/mod.ts";

const html = (c: unknown, p: Record<string, unknown>): string =>
  renderToString(h(c as never, p) as never);

Deno.test("kit: an undefined aria-label keeps the Spinner/Avatar/Pagination default", () => {
  const cases: [unknown, Record<string, unknown>, string[]][] = [
    [Spinner, { role: undefined }, [
      `aria-label="Loading"`,
      `role="status"`,
    ]],
    [Avatar, { name: "Ada", title: undefined, role: undefined }, [
      `aria-label="Ada"`,
      `title="Ada"`,
      `role="img"`,
    ]],
    [Pagination, { page: 1, pages: 3, onPage: () => {} }, [
      `aria-label="Pagination"`,
    ]],
  ];
  assert(cases.length === 3);
  for (const [c, p, want] of cases) {
    const out = html(c, { ...p, "aria-label": undefined });
    assert(want.length > 0);
    for (const w of want) assert(out.includes(w), `${w} missing: ${out}`);
  }
});
