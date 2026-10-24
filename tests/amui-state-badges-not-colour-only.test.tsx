// amui State tab: the disk/ui badges told on from off by colour alone, so a
// screen reader and `am surface` read both as present. An off badge is now
// named "no disk"/"no ui" and struck through.
import { assert, assertEquals } from "@std/assert";
import { renderToString } from "../src/air.ts";
import { StateOverview } from "../amui/src/ui/state-view.tsx";

Deno.test("amui state badges: an off flag is named, not only coloured", () => {
  const html = renderToString(
    <StateOverview
      state={{ todo: { items: [], draft: "" } }}
      fields={{ todo: { draft: { persisted: false, ui: false } } }}
    />,
  );
  const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
  // legend (2 on) + items (2 on) + draft (2 off)
  assertEquals(labels.filter((l) => l === "no disk").length, 1);
  assertEquals(labels.filter((l) => l === "no ui").length, 1);
  assertEquals(labels.filter((l) => l === "disk").length, 2);
  assert(html.includes("line-through"));
});
