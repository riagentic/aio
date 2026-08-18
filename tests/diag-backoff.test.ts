// Repeating diagnostics back off — one line stays one line.
//
// A flat 5s dedup against a PERSISTENT condition is a line every five seconds
// forever: one field report's client.log carried thousands of identical
// `state-shape-drift` lines over hours (RIS-7a), burying the very signal the
// log exists to carry. The window now doubles per repeat (cap: 1h) and the
// suppressed count rides on the next line, so persistence stays visible
// without owning the log.
import { assert, assertEquals } from "@std/assert";

Deno.test("diag backoff: window doubles, count is reported", async () => {
  // `_w` is captured at MODULE LOAD, so the fake window must exist before the
  // module does — hence the dynamic import.
  const lines: string[] = [];
  // deno-lint-ignore no-explicit-any
  (globalThis as any).window = {
    _aioDiag: (ev: { message?: string }) => lines.push(ev.message ?? ""),
  };
  const { _deliverDiag, _diagLastEmit } = await import(
    "../src/protocol/protocol-diagnostics.ts"
  );
  _diagLastEmit.clear();
  try {
    const t0 = Date.now();
    const emit = (at: number) =>
      _deliverDiag({ type: "bk-test", message: "key missing", ts: t0 + at });
    // The dedup uses Date.now() internally — drive it via the map directly
    // instead: emit, then rewind `last` to simulate elapsed time.
    emit(0);
    assertEquals(lines.length, 1, "first occurrence prints");

    // Hammer inside the window: suppressed, counted.
    for (let i = 0; i < 719; i++) emit(0);
    assertEquals(lines.length, 1, "the storm is one line so far");
    const st = _diagLastEmit.get("bk-test")!;
    assertEquals(st.suppressed, 719);

    // Rewind to just past the window (still "consecutive"): prints WITH count,
    // and the window doubles.
    st.last = Date.now() - st.window - 1;
    emit(0);
    assertEquals(lines.length, 2);
    assert(
      lines[1]!.includes("repeated 719×"),
      `the count survives: ${lines[1]}`,
    );
    assertEquals(_diagLastEmit.get("bk-test")!.window, 10_000);

    // A type that went QUIET (two full windows) resets to the base window.
    const st2 = _diagLastEmit.get("bk-test")!;
    st2.last = Date.now() - st2.window * 2 - 1;
    emit(0);
    assertEquals(_diagLastEmit.get("bk-test")!.window, 5000, "quiet → reset");
  } finally {
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).window;
    _diagLastEmit.clear();
  }
});
