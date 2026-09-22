// ARIA toggle / disclosure state must be readable on the testUI surface.
//
// Same class as the aria-checked field report: a toggle built as
//
//   <button aria-pressed="false">Mute</button>
//   <button aria-expanded="false">Menu</button>
//
// left `ui.Mute.pressed` / `ui.Menu.expanded` as the handle proxy's lazy
// callable — the natural assertion for "off" was unwritable. `aria-pressed`
// and `aria-expanded` are the documented meaningful-false attributes
// (docs/ui/air-components.md); promoting them keeps `.attr("aria-…")` for
// everything else.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { getSerializedSurfaces } from "../src/air/ui-remote.ts";
import type { UIElementInfo, UISurfaceNode } from "../src/air/ui-surface.ts";

const ui = cell("surface-aria-pressed", {
  state: { muted: false, open: false },
  methods: {
    toggleMute(s: { muted: boolean }) {
      s.muted = !s.muted;
    },
    toggleMenu(s: { open: boolean }) {
      s.open = !s.open;
    },
  },
});

function App() {
  return (
    <div>
      <button
        t="Mute"
        type="button"
        aria-pressed={ui.muted}
        onClick={() => ui.toggleMute()}
      >
        Mute
      </button>
      <button
        t="Menu"
        type="button"
        aria-expanded={ui.open}
        onClick={() => ui.toggleMenu()}
      >
        Menu
      </button>
      <button t="Go" type="button" onClick={() => {}}>Go</button>
    </div>
  );
}

function findEl(node: UISurfaceNode, name: string): UIElementInfo | undefined {
  const hit = node.elements.find((e) => e.name === name);
  if (hit) return hit;
  for (const c of node.children) {
    const deep = findEl(c, name);
    if (deep) return deep;
  }
  return undefined;
}

Deno.test("aria-pressed / aria-expanded assert as booleans (not a callable)", async () => {
  await using page = await testUI(App as never);
  await page.settle();

  // The natural assertions — writable, and false included.
  assertEquals(page.Mute.pressed, false);
  assertEquals(page.Menu.expanded, false);
  // A plain button is not a toggle / not expandable: getters still answer
  // boolean false (never a callable), and the surface omits the fields.
  assertEquals(page.Go.pressed, false);
  assertEquals(page.Go.expanded, false);
  assertEquals(page.Go.info.pressed, undefined);
  assertEquals(page.Go.info.expanded, undefined);

  await page.Mute.click();
  assertEquals(page.Mute.pressed, true);
  assertEquals(ui.muted, true);
  assertEquals(page.Mute.attr("aria-pressed"), "true");

  await page.Menu.click();
  assertEquals(page.Menu.expanded, true);
  assertEquals(ui.open, true);
  assertEquals(page.Menu.attr("aria-expanded"), "true");
});

Deno.test("aria-pressed / aria-expanded reach am surface the same way", async () => {
  await using page = await testUI(App as never);
  await page.settle();
  await page.Mute.click();

  const tree = getSerializedSurfaces()[0];
  assert(tree, "a surface was published");
  const mute = findEl(tree!, "Mute");
  const menu = findEl(tree!, "Menu");
  const go = findEl(tree!, "Go");
  assert(mute && menu && go);
  assertEquals(mute!.pressed, true);
  assertEquals(menu!.expanded, false);
  assertEquals("pressed" in go!, false);
  assertEquals("expanded" in go!, false);
});
