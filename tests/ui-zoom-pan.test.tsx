// `ZoomPan` (aio/ui): wheel zoom at the cursor, drag to pan, ＋/－/fit, and a
// click that ends a drag never reaches the content. Asked for by a field
// report (a network map) that wrote ~70 lines of it plus the camera math.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { signal } from "aio/air";
import { fitView, zoomAt, ZoomPan, type ZoomView } from "aio/ui";
import { testUI } from "aio/testing";

Deno.test("zoomAt keeps the point under the cursor still, and clamps", () => {
  const v = zoomAt({ x: 10, y: 20, scale: 1 }, 2, 110, 120);
  // content point under (110,120) before: (100,100); after: same
  assertEquals(v.scale, 2);
  assertEquals([(110 - v.x) / v.scale, (120 - v.y) / v.scale], [100, 100]);
  assertEquals(zoomAt({ x: 0, y: 0, scale: 9 }, 4, 0, 0).scale, 10);
  assertEquals(zoomAt({ x: 0, y: 0, scale: 0.2 }, 0.1, 0, 0).scale, 0.1);
});

Deno.test("fitView centres the content whole, inside the padding", () => {
  const v = fitView({ width: 200, height: 100 }, { width: 432, height: 432 });
  assertEquals(v.scale, 2);
  assertEquals([v.x, v.y], [16, 116]);
  assertEquals(fitView({ width: 0, height: 0 }, { width: 10, height: 10 }), {
    x: 0,
    y: 0,
    scale: 1,
  });
});

const seen = signal<ZoomView[]>([]);
const clicks = signal(0);
function Diagram() {
  return (
    <ZoomPan
      style={{ width: "400px", height: "300px" }}
      onView={(v: ZoomView) => seen.set([...seen(), v])}
    >
      <button type="button" t="node" onClick={() => clicks.set(clicks() + 1)}>
        node
      </button>
    </ZoomPan>
  );
}

testUI(Diagram, "ZoomPan: the buttons zoom about the centre", async (ui) => {
  seen.set([]);
  ui.ZoomInButton.click();
  await ui.settle();
  assertAlmostEquals(seen().at(-1)!.scale, 1.25);
  ui.ZoomOutButton.click();
  await ui.settle();
  assertAlmostEquals(seen().at(-1)!.scale, 1);
  ui.FitButton.click();
  await ui.settle();
  assertEquals(seen().length, 3);
});

testUI(
  Diagram,
  "ZoomPan: a drag pans, and the click that ends it is not a click",
  async (ui) => {
    seen.set([]);
    clicks.set(0);
    const w = ui.window;
    const box = w.document.querySelector(".aio-zoompan")!;
    const node = w.document.querySelector("button")!;
    const pe = (type: string, x: number, y: number) =>
      new w.PointerEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        button: 0,
      });
    node.dispatchEvent(pe("pointerdown", 10, 10));
    node.dispatchEvent(pe("pointermove", 40, 30));
    node.dispatchEvent(pe("pointerup", 40, 30));
    node.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await ui.settle();
    assertEquals(clicks(), 0, "the drag's click reached the content");
    const v = seen().at(-1)!;
    assertEquals([v.x, v.y, v.scale], [30, 20, 1]);
    // A press that does not move is a click.
    node.dispatchEvent(pe("pointerdown", 50, 50));
    node.dispatchEvent(pe("pointerup", 51, 50));
    node.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await ui.settle();
    assertEquals(clicks(), 1);
    assert(box);
  },
);

testUI(
  Diagram,
  "ZoomPan: the wheel zooms, and does not scroll the page",
  async (ui) => {
    seen.set([]);
    const w = ui.window;
    const box = w.document.querySelector(".aio-zoompan")!;
    const e = new w.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -200,
      clientX: 0,
      clientY: 0,
    });
    box.dispatchEvent(e);
    await ui.settle();
    assert(e.defaultPrevented, "the page would scroll");
    assert(seen().at(-1)!.scale > 1, JSON.stringify(seen()));
  },
);
