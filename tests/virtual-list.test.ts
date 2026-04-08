import { assertEquals } from "@std/assert";
import { signal } from "../src/signal.ts";
import { useVirtualList } from "../src/virtual-list.ts";

// ── Basic visible range calculation ────────────────────────────────

Deno.test("virtualList: calculates visible items for initial scroll position", () => {
  const items = Array.from({ length: 100 }, (_, i) => `item-${i}`);
  const vl = useVirtualList({
    items,
    itemHeight: 40,
    containerHeight: 200,
    overscan: 0,
  });

  // containerHeight=200, itemHeight=40 -> 5 visible items (ceil(200/40))
  // overscan=0, scrollTop=0 -> startIndex=0, endIndex=5
  const visible = vl.visible;
  assertEquals(visible.length, 5);
  assertEquals(visible[0]!.index, 0);
  assertEquals(visible[0]!.offset, 0);
  assertEquals(visible[4]!.index, 4);
  assertEquals(visible[4]!.offset, 160);
});

Deno.test("virtualList: correct total height", () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const vl = useVirtualList({
    items,
    itemHeight: 30,
    containerHeight: 150,
  });

  assertEquals(vl.totalHeight, 50 * 30); // 1500
});

Deno.test("virtualList: scrollTop starts at 0", () => {
  const vl = useVirtualList({
    items: [1, 2, 3],
    itemHeight: 50,
    containerHeight: 100,
  });
  assertEquals(vl.scrollTop, 0);
});

// ── Overscan behavior ──────────────────────────────────────────────

Deno.test("virtualList: default overscan is 3", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const vl = useVirtualList({
    items,
    itemHeight: 40,
    containerHeight: 200,
    // overscan not specified — default 3
  });

  // containerHeight=200, itemHeight=40 -> ceil(200/40) = 5 visible
  // overscan=3 -> visibleCount = 5 + 2*3 = 11
  // scrollTop=0 -> startIndex = max(0, floor(0/40) - 3) = 0
  // endIndex = min(100, 0 + 11) = 11
  const visible = vl.visible;
  assertEquals(visible.length, 11);
  assertEquals(visible[0]!.index, 0);
  assertEquals(visible[10]!.index, 10);
});

Deno.test("virtualList: overscan adds items before and after viewport", () => {
  const items = Array.from({ length: 100 }, (_, i) => `item-${i}`);
  const vl = useVirtualList({
    items,
    itemHeight: 40,
    containerHeight: 200,
    overscan: 2,
  });

  // scrollTop=0, visibleCount = ceil(200/40) + 2*2 = 5 + 4 = 9
  // startIndex = max(0, floor(0/40) - 2) = 0
  // endIndex = min(100, 0 + 9) = 9
  assertEquals(vl.visible.length, 9);
});

// ── scrollToIndex ──────────────────────────────────────────────────

Deno.test("virtualList: scrollToIndex updates visible range", () => {
  const items = Array.from({ length: 100 }, (_, i) => `item-${i}`);
  const vl = useVirtualList({
    items,
    itemHeight: 40,
    containerHeight: 200,
    overscan: 0,
  });

  vl.scrollToIndex(20);
  assertEquals(vl.scrollTop, 800); // 20 * 40

  // floor(800/40) = 20, startIndex = max(0, 20 - 0) = 20
  // visibleCount = ceil(200/40) + 0 = 5
  // endIndex = min(100, 20 + 5) = 25
  const visible = vl.visible;
  assertEquals(visible[0]!.index, 20);
  assertEquals(visible[0]!.offset, 800);
  assertEquals(visible.length, 5);
});

Deno.test("virtualList: scrollToIndex(0) goes back to start", () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const vl = useVirtualList({
    items,
    itemHeight: 40,
    containerHeight: 200,
    overscan: 0,
  });

  vl.scrollToIndex(10);
  assertEquals(vl.scrollTop, 400);

  vl.scrollToIndex(0);
  assertEquals(vl.scrollTop, 0);
  assertEquals(vl.visible[0]!.index, 0);
});

// ── Edge case: empty list ──────────────────────────────────────────

Deno.test("virtualList: empty list produces no visible items", () => {
  const vl = useVirtualList({
    items: [],
    itemHeight: 40,
    containerHeight: 200,
  });

  assertEquals(vl.visible.length, 0);
  assertEquals(vl.totalHeight, 0);
});

// ── Edge case: single item ─────────────────────────────────────────

Deno.test("virtualList: single item list", () => {
  const vl = useVirtualList({
    items: ["only"],
    itemHeight: 40,
    containerHeight: 200,
    overscan: 0,
  });

  // visibleCount = ceil(200/40) = 5, but only 1 item
  assertEquals(vl.visible.length, 1);
  assertEquals(vl.visible[0]!.item, "only");
  assertEquals(vl.visible[0]!.index, 0);
  assertEquals(vl.visible[0]!.offset, 0);
  assertEquals(vl.totalHeight, 40);
});

// ── Edge case: scroll to end ───────────────────────────────────────

Deno.test("virtualList: scroll to end shows last items", () => {
  const items = Array.from({ length: 100 }, (_, i) => `item-${i}`);
  const vl = useVirtualList({
    items,
    itemHeight: 40,
    containerHeight: 200,
    overscan: 0,
  });

  // Scroll to the very end
  vl.scrollToIndex(95);
  // scrollTop = 95 * 40 = 3800
  // startIndex = floor(3800/40) - 0 = 95
  // visibleCount = ceil(200/40) = 5
  // endIndex = min(100, 95 + 5) = 100
  const visible = vl.visible;
  assertEquals(visible[visible.length - 1]!.index, 99);
  assertEquals(visible[visible.length - 1]!.item, "item-99");
});

Deno.test("virtualList: scroll past end clamps to available items", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const vl = useVirtualList({
    items,
    itemHeight: 40,
    containerHeight: 200,
    overscan: 0,
  });

  vl.scrollToIndex(100); // Way past end
  const visible = vl.visible;
  // All items should still be bounded by array length
  for (const v of visible) {
    assertEquals(v.index < 10, true);
  }
});

// ── Signal-based items ─────────────────────────────────────────────

Deno.test("virtualList: works with signal-based items", () => {
  const itemsSig = signal(["a", "b", "c", "d", "e"]);
  const vl = useVirtualList({
    items: itemsSig,
    itemHeight: 40,
    containerHeight: 200,
    overscan: 0,
  });

  assertEquals(vl.visible.length, 5);
  assertEquals(vl.totalHeight, 200);

  // Update the signal
  itemsSig.set(["a", "b", "c"]);
  assertEquals(vl.visible.length, 3);
  assertEquals(vl.totalHeight, 120);
});

Deno.test("virtualList: signal items going empty", () => {
  const itemsSig = signal([1, 2, 3]);
  const vl = useVirtualList({
    items: itemsSig,
    itemHeight: 50,
    containerHeight: 200,
    overscan: 0,
  });

  assertEquals(vl.visible.length, 3);

  itemsSig.set([]);
  assertEquals(vl.visible.length, 0);
  assertEquals(vl.totalHeight, 0);
});

// ── Item offsets ───────────────────────────────────────────────────

Deno.test("virtualList: item offsets are correct multiples of itemHeight", () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const vl = useVirtualList({
    items,
    itemHeight: 35,
    containerHeight: 200,
    overscan: 0,
  });

  for (const v of vl.visible) {
    assertEquals(v.offset, v.index * 35);
  }
});

// ── Container and inner styles ─────────────────────────────────────

Deno.test("virtualList: containerStyle has correct properties", () => {
  const vl = useVirtualList({
    items: [1, 2, 3],
    itemHeight: 40,
    containerHeight: 300,
  });

  const style = vl.containerStyle;
  assertEquals(style.overflow, "auto");
  assertEquals(style.position, "relative");
  assertEquals(style.height, "300px");
});

Deno.test("virtualList: innerStyle height matches totalHeight", () => {
  const items = Array.from({ length: 25 }, (_, i) => i);
  const vl = useVirtualList({
    items,
    itemHeight: 40,
    containerHeight: 200,
  });

  const style = vl.innerStyle;
  assertEquals(style.height, `${25 * 40}px`);
  assertEquals(style.position, "relative");
});

// ── Edge case: itemHeight guard ────────────────────────────────────

Deno.test("virtualList: itemHeight=0 is clamped to 1 (no divide by zero)", () => {
  const items = Array.from({ length: 5 }, (_, i) => i);
  // safeItemHeight = Math.max(1, 0) = 1
  const vl = useVirtualList({
    items,
    itemHeight: 0,
    containerHeight: 200,
    overscan: 0,
  });

  // Should not crash or produce Infinity
  assertEquals(vl.visible.length > 0, true);
  assertEquals(Number.isFinite(vl.totalHeight), true);
});

Deno.test("virtualList: negative itemHeight is clamped to 1", () => {
  const items = [1, 2, 3];
  const vl = useVirtualList({
    items,
    itemHeight: -10,
    containerHeight: 100,
    overscan: 0,
  });

  // safeItemHeight = Math.max(1, -10) = 1
  assertEquals(vl.visible.length > 0, true);
});

// ── Scroll with overscan near boundaries ───────────────────────────

Deno.test("virtualList: overscan does not go below index 0", () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const vl = useVirtualList({
    items,
    itemHeight: 40,
    containerHeight: 200,
    overscan: 5,
  });

  // scrollTop=0: startIndex = max(0, floor(0/40) - 5) = 0
  assertEquals(vl.visible[0]!.index, 0);
});

Deno.test("virtualList: overscan does not go beyond items.length", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const vl = useVirtualList({
    items,
    itemHeight: 40,
    containerHeight: 200,
    overscan: 5,
  });

  // visibleCount = ceil(200/40) + 2*5 = 5 + 10 = 15
  // endIndex = min(10, 0 + 15) = 10
  const lastVisible = vl.visible[vl.visible.length - 1]!;
  assertEquals(lastVisible.index, 9);
  assertEquals(vl.visible.length, 10);
});
