import { assertEquals } from "@std/assert";
import {
  _applyFullState,
  _getOrCreateCellSignal,
  _resetSignals,
  getCellSignal,
} from "../src/state/state-signals.ts";

// Tests for 4.4: in dev, cell signal values are deep-frozen so component
// mutations throw "Cannot assign to read only property". Skip slices
// >100KB. Prod unchanged.

function setupDev() {
  (globalThis as Record<string, unknown>).__aioDev = true;
  (globalThis as Record<string, unknown>).__aioFreezeSkipped = false;
  _resetSignals();
}

function teardownDev() {
  (globalThis as Record<string, unknown>).__aioDev = false;
  (globalThis as Record<string, unknown>).__aioFreezeSkipped = false;
  _resetSignals();
}

Deno.test("4.4: dev — mutating cell signal value throws", () => {
  setupDev();
  try {
    _applyFullState({
      counter: { count: 5, label: "x" },
    });
    const sig = getCellSignal("counter");
    let caught: Error | null = null;
    try {
      (sig.peek() as Record<string, unknown>).count = 99;
    } catch (e) {
      caught = e as Error;
    }
    assertEquals(caught instanceof TypeError, true);
    assertEquals(
      (caught as unknown as Error).message.includes("read only"),
      true,
    );
  } finally {
    teardownDev();
  }
});

Deno.test("4.4: dev — nested mutation also throws", () => {
  setupDev();
  try {
    _applyFullState({
      user: { profile: { name: "alice" } },
    });
    const sig = getCellSignal("user");
    let caught: Error | null = null;
    try {
      ((sig.peek() as Record<string, unknown>).profile as Record<
        string,
        unknown
      >)
        .name = "bob";
    } catch (e) {
      caught = e as Error;
    }
    assertEquals(caught instanceof TypeError, true);
  } finally {
    teardownDev();
  }
});

Deno.test("4.4: prod — same mutation does NOT throw", () => {
  // Prod is signaled by absence of __aioDev.
  teardownDev();
  try {
    _applyFullState({
      counter: { count: 5 },
    });
    const sig = getCellSignal("counter");
    let threw = false;
    try {
      (sig.peek() as Record<string, unknown>).count = 99;
    } catch {
      threw = true;
    }
    assertEquals(threw, false, "prod should NOT throw on mutation");
  } finally {
    _resetSignals();
  }
});

Deno.test("4.4: dev — slices > 100KB are skipped (no freeze)", () => {
  setupDev();
  try {
    // Build a slice that, when JSON.stringified, is > 100KB.
    const big = { items: new Array(5000).fill("x".repeat(50)) };
    const size = JSON.stringify(big).length;
    if (size <= 100_000) {
      // If we didn't get a big enough string, force it.
      big.items = new Array(20000).fill("y".repeat(50));
    }
    _applyFullState({ big });
    const sig = getCellSignal("big");
    let threw = false;
    try {
      (sig.peek() as Record<string, unknown>).items = [];
    } catch {
      threw = true;
    }
    assertEquals(
      threw,
      false,
      "oversized slice should NOT be frozen — dev boot stays snappy",
    );
  } finally {
    teardownDev();
  }
});

Deno.test("4.4: dev — small slice is frozen; oversized slice is not", () => {
  setupDev();
  try {
    _applyFullState({ small: { x: 1 }, big: { data: "y".repeat(200000) } });
    const smallSig = getCellSignal("small");
    const bigSig = getCellSignal("big");
    let smallThrew = false;
    let bigThrew = false;
    try {
      (smallSig.peek() as Record<string, unknown>).x = 99;
    } catch {
      smallThrew = true;
    }
    try {
      (bigSig.peek() as Record<string, unknown>).data = "z";
    } catch {
      bigThrew = true;
    }
    assertEquals(smallThrew, true, "small slice should be frozen");
    assertEquals(bigThrew, false, "oversized slice should be skipped");
  } finally {
    teardownDev();
  }
});
