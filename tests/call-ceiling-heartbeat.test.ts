// alpha70, a wallet app's field ask: a chain query that takes 20s of a 30s
// ceiling is SLOW, and until the ceiling fires nothing distinguishes it from
// DEAD — a spinner and a silent log. One info line at the half-way mark,
// naming cell:method and elapsed/deadline, so slow is never mistaken for dead.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  _resetCallTimeouts,
  _setCallTimeouts,
  CEILING_HEARTBEAT_FRACTION,
  pauseCallDeadlines,
  registerCall,
  resolveCall,
} from "../src/state/cell-impl.ts";

/** Capture the framework's INFO lines (logger-format routes `info` to
 *  `console.info`, so a test can watch the level the line claims). */
function captureInfo(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.info;
  console.info = (...a: unknown[]) => lines.push(a.join(" "));
  return { lines, restore: () => (console.info = orig) };
}

Deno.test("call ceiling: a call past half its ceiling logs 'still running (slow)' once, at info", async () => {
  using time = new FakeTime();
  _resetCallTimeouts();
  _setCallTimeouts(1000);
  const cap = captureInfo();
  try {
    const p = registerCall("hb-1", "wallet:refresh");
    const mine = () => cap.lines.filter((l) => l.includes("wallet:refresh"));
    await time.tickAsync(400); // 40% — nothing yet
    assertEquals(mine().length, 0, "before the half-way mark: silence");
    await time.tickAsync(101); // past 50%
    assertEquals(mine().length, 1, `one heartbeat: ${cap.lines}`);
    assertStringIncludes(mine()[0]!, "still running (slow)");
    assertStringIncludes(mine()[0]!, "wallet:refresh");
    assertStringIncludes(mine()[0]!, "of its 1000ms ceiling");
    assertStringIncludes(mine()[0]!, "ms"); // elapsed
    await time.tickAsync(400); // 90% — still once
    assertEquals(mine().length, 1, "the heartbeat is ONE line, not a stream");
    resolveCall("hb-1", "ok");
    assertEquals(await p, "ok", "the caller is still awaited");
    assertEquals(CEILING_HEARTBEAT_FRACTION, 0.5);
  } finally {
    cap.restore();
    _resetCallTimeouts();
  }
});

Deno.test("call ceiling: a call that settles before half its ceiling never heartbeats (and leaks no timer)", async () => {
  using time = new FakeTime();
  _resetCallTimeouts();
  _setCallTimeouts(1000);
  const cap = captureInfo();
  try {
    const p = registerCall("hb-2", "wallet:balance");
    await time.tickAsync(100);
    resolveCall("hb-2", 42);
    assertEquals(await p, 42);
    await time.tickAsync(2000); // well past the half-way mark AND the ceiling
    assertEquals(
      cap.lines.filter((l) => l.includes("wallet:balance")).length,
      0,
      "a fast call is not 'slow'",
    );
  } finally {
    cap.restore();
    _resetCallTimeouts();
  }
});

Deno.test("call ceiling: the heartbeat pauses with the deadline while a human is waited on", async () => {
  using time = new FakeTime();
  _resetCallTimeouts();
  _setCallTimeouts(1000);
  const cap = captureInfo();
  try {
    const p = registerCall("hb-3", "files:pick");
    const mine = () => cap.lines.filter((l) => l.includes("files:pick"));
    await time.tickAsync(300);
    const resume = pauseCallDeadlines(); // a native picker is open
    await time.tickAsync(5000); // the person takes their time
    assertEquals(mine().length, 0, "a person at a dialog is not a slow method");
    resume(); // fresh full window: heartbeat at +500
    await time.tickAsync(499);
    assertEquals(mine().length, 0);
    await time.tickAsync(2);
    assertEquals(mine().length, 1, "re-armed with the deadline");
    resolveCall("hb-3", "picked");
    assertEquals(await p, "picked");
  } finally {
    cap.restore();
    _resetCallTimeouts();
  }
});

Deno.test("call ceiling: an unbounded (long) call has no ceiling to be half-way to", async () => {
  using time = new FakeTime();
  _resetCallTimeouts();
  _setCallTimeouts(0);
  const cap = captureInfo();
  try {
    const p = registerCall("hb-4", "builds:compile");
    await time.tickAsync(60_000);
    assertEquals(
      cap.lines.filter((l) => l.includes("builds:compile")).length,
      0,
    );
    resolveCall("hb-4", "built");
    assertEquals(await p, "built");
  } finally {
    cap.restore();
    _resetCallTimeouts();
  }
});
