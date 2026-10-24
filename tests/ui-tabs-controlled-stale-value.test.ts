// A controlled <Tabs value> that names no tab still leaves ONE tab in the
// page's tab order.
//
// Uncontrolled, a remembered id that outlived its tab falls back to the first
// enabled one. Controlled, `value` was used as-is: every tab got tabIndex -1,
// so a keyboard user's Tab skipped the whole list and could never reach it.
import { assertEquals } from "@std/assert";
import { h, renderToString } from "../src/air/vdom.ts";
import { Tabs } from "../src/ui/mod.ts";

const stops = (html: string) =>
  [...html.matchAll(/<button[^>]*tabindex="(-?\d)"[^>]*>([^<]*)</gi)]
    .filter((m) => m[1] === "0").map((m) => m[2]);

const tabs = [
  { id: "a", label: "A", disabled: true },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
];

Deno.test("Tabs: a controlled value naming no tab keeps the first enabled tab reachable", () => {
  assertEquals(stops(renderToString(h(Tabs, { tabs, value: "gone" }))), ["B"]);
});

Deno.test("Tabs: a controlled value naming a tab is the one tab stop", () => {
  assertEquals(stops(renderToString(h(Tabs, { tabs, value: "c" }))), ["C"]);
});
