// The Electron main process reconnects to the backend UDS socket on the SAME
// curve as every other transport in the framework.
//
// It cannot import `backoffDelay` at runtime — the generated `main.cjs` is a
// standalone CJS file in the packaged app — so something has to cross into it.
// What crossed for a long time was a hand-retyped formula sitting next to
// correctly-imported constants, and it had already drifted: the copy dropped
// the ±20% jitter term, leaving Electron the one client reconnecting on a bare
// exponential. The generator now emits the authority's own source, so the copy
// cannot drift; these tests hold that shape in place.
import { assert, assertEquals } from "@std/assert";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffDelay,
} from "../src/protocol/transport-shared.ts";

const script = electronMainScriptUDS("http://localhost:3000", "/tmp/t.sock", {
  title: "backoff",
});

Deno.test("electron: the emitted reconnect curve IS the shared function", () => {
  // Textual identity with the authority. Any edit to `backoffDelay` — a new
  // jitter policy, a cap change, decorrelated backoff — reaches the generated
  // script by construction, and this assertion is what makes "by construction"
  // true rather than aspirational.
  assert(
    script.includes(backoffDelay.toString()),
    `the generated Electron script must embed backoffDelay's own source, not ` +
      `a retyped copy. Expected to find:\n${backoffDelay.toString()}`,
  );
  // The constants it closes over must be emitted too, or the embedded source
  // references identifiers that do not exist in the generated script.
  assert(
    script.includes(`BACKOFF_BASE_MS = ${BACKOFF_BASE_MS}`),
    "emitted source needs BACKOFF_BASE_MS in scope",
  );
  assert(
    script.includes(`BACKOFF_MAX_MS = ${BACKOFF_MAX_MS}`),
    "emitted source needs BACKOFF_MAX_MS in scope",
  );
});

Deno.test("electron: the emitted curve BEHAVES like the shared one (jitter included)", () => {
  // Textual identity is the mechanism; this is the property it exists to
  // protect. Evaluate what the generated script would actually run and compare
  // its range against the authority's.
  const emitted = new Function(
    `const BACKOFF_BASE_MS = ${BACKOFF_BASE_MS}, BACKOFF_MAX_MS = ${BACKOFF_MAX_MS};` +
      `return (${backoffDelay.toString()});`,
  )() as (retry: number, jitter?: number) => number;

  for (const retry of [0, 1, 2, 3, 5, 8, 20]) {
    const base = Math.min(BACKOFF_BASE_MS * Math.pow(2, retry), BACKOFF_MAX_MS);
    let sawBelow = false;
    let sawAbove = false;
    for (let i = 0; i < 400; i++) {
      const d = emitted(retry);
      assert(
        d >= base * 0.8 - 1e-9 && d <= base * 1.2 + 1e-9,
        `retry ${retry}: ${d} outside base ${base} ±20%`,
      );
      if (d < base) sawBelow = true;
      if (d > base) sawAbove = true;
    }
    // The jitter is the part the old copy dropped, so prove it is THERE:
    // a bare exponential returns exactly `base` every time and would fail both.
    assert(
      sawBelow && sawAbove,
      `retry ${retry}: no jitter observed — the emitted curve is a bare ` +
        `exponential, which is exactly the drift this test exists to catch`,
    );
  }
});

Deno.test("electron: the script calls the shared curve, not an inline formula", () => {
  assert(
    script.includes("const delay = backoffDelay(retry)"),
    "the reconnect path must call the emitted function",
  );
  // The retyped formula must be gone — leaving it would mean two curves again,
  // with only luck deciding which one the reconnect path reaches.
  assertEquals(
    script.includes("Math.pow(2, retry), " + BACKOFF_MAX_MS),
    false,
    "the hand-retyped backoff formula must not survive anywhere in the script",
  );
});
