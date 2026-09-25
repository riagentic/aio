// h-spread.ts — `h()` for any number of children. Internal to the kit: not
// re-exported from `src/ui/mod.ts`.
//
// V8 caps a call's argument count (past ~120k it throws "Maximum call stack
// size exceeded"), and a kit parent's children are app data: 65 000
// soft-wrapped markdown lines are one <p> with 130 000 children, a query
// result is a <tbody> with one <tr> per row, a city list is a <select> with
// one <option> per city. Handing those on as spread arguments turned a big
// list into a crash out of the render. One helper for every such parent, so
// the cap is fixed in one place.

import { Fragment, h } from "../air/vdom.ts";
import type { VChild, VNode } from "../air/vdom.ts";

/** How many children one `h()` call is handed as spread arguments. Wider
 *  parents get their children in fragments of this size — fragments add no
 *  markup, so the page is the same. (Not an array child: a nested array marks
 *  its vnodes as "from an expression" and would draw the unkeyed-list dev
 *  warning at the kit's own markup.) */
export const SPREAD_MAX = 8192;

/** `h(tag, props, ...kids)` for any number of `kids`. */
export function el(
  tag: string | typeof Fragment,
  props: Record<string, unknown> | null,
  kids: VChild[],
): VNode {
  if (kids.length <= SPREAD_MAX) return h(tag, props, ...kids);
  const parts: VChild[] = [];
  for (let k = 0; k < kids.length; k += SPREAD_MAX) {
    parts.push(h(Fragment, null, ...kids.slice(k, k + SPREAD_MAX)));
  }
  return el(tag, props, parts);
}

/** `out.push(...items)` without the argument cap (see {@link SPREAD_MAX}). */
export function pushAll(out: VChild[], items: VChild[]): void {
  for (const x of items) out.push(x);
}
