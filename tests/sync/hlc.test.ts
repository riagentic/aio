import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { compareHLC, createHLC, type HLClock } from "../../src/sync/hlc.ts";

describe("HLC", () => {
  describe("createHLC", () => {
    it("creates clock with nodeId", () => {
      const clock = createHLC("c1");
      const hlc = clock.now();
      assertEquals(hlc[2], "c1");
    });
  });

  describe("tick", () => {
    it("advances physical time", () => {
      const clock = createHLC("c1");
      const a = clock.tick();
      const b = clock.tick();
      assertEquals(a[0] <= b[0], true);
      assertEquals(compareHLC(a, b) < 0, true);
    });

    it("increments counter for same-ms ticks", () => {
      const clock = createHLC("c1", () => 1000);
      const a = clock.tick();
      const b = clock.tick();
      assertEquals(a[0], 1000);
      assertEquals(b[0], 1000);
      assertEquals(b[1], a[1] + 1);
    });
  });

  describe("receive", () => {
    it("merges remote clock with higher physical", () => {
      const clock = createHLC("c1", () => 1000);
      clock.tick();
      clock.receive([2000, 0, "c2"]);
      const next = clock.tick();
      assertEquals(next[0] >= 2000, true);
    });

    it("merges remote clock with same physical — takes max counter + 1", () => {
      const clock = createHLC("c1", () => 1000);
      clock.tick(); // [1000, 0, c1]
      clock.receive([1000, 5, "c2"]);
      const next = clock.tick();
      assertEquals(next[0], 1000);
      assertEquals(next[1] > 5, true);
    });
  });

  describe("compareHLC", () => {
    it("orders by physical first", () => {
      assertEquals(compareHLC([100, 0, "a"], [200, 0, "b"]) < 0, true);
    });

    it("orders by counter second", () => {
      assertEquals(compareHLC([100, 1, "a"], [100, 2, "b"]) < 0, true);
    });

    it("orders by nodeId third", () => {
      assertEquals(compareHLC([100, 0, "a"], [100, 0, "b"]) < 0, true);
    });

    it("returns 0 for equal", () => {
      assertEquals(compareHLC([100, 0, "a"], [100, 0, "a"]), 0);
    });
  });

  describe("drift detection", () => {
    it("detects clock drift exceeding maxDrift", () => {
      const clock = createHLC("s", () => 1000);
      assertEquals(clock.isDriftExceeded([121_000, 0, "c1"]), true);
    });

    it("allows drift within maxDrift", () => {
      const clock = createHLC("s", () => 1000);
      assertEquals(clock.isDriftExceeded([50_000, 0, "c1"]), false);
    });
  });

  describe("serialization", () => {
    it("serializes and deserializes", () => {
      const clock = createHLC("c1");
      const hlc = clock.tick();
      const json = JSON.stringify(hlc);
      const parsed = JSON.parse(json) as [number, number, string];
      assertEquals(compareHLC(hlc, parsed), 0);
    });
  });
});
