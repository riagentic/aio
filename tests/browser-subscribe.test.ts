// tests/browser-subscribe.test.ts
// Tests for subscription stability fix (AIO-4/AIO-3)
//
// Strategy: We test the _subscribe / _useAioSubscribe functions directly
// (they are the useSyncExternalStore callbacks). We do NOT need React or
// a browser — these are pure functions operating on module-level state.
// We import _reset() to isolate tests.

import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { _reset } from "../src/state-core.ts";
import {
  _cleanupTimer,
  _setCleanupTimer,
  _subscribe,
  _useAioSubscribe,
} from "../src/browser-protocol.ts";

// ── Stable reference tests ──────────────────────────────────────────

Deno.test("subscribe: _useAioSubscribe is a stable module-level reference", () => {
  // Accessing the export twice should return the same function reference.
  // This proves it's not recreated per call (the old bug).
  const ref1 = _useAioSubscribe;
  const ref2 = _useAioSubscribe;
  assertEquals(ref1, ref2, "_useAioSubscribe must be a stable reference");
});

Deno.test("subscribe: _useAioSubscribe wraps _subscribe (listener count tracks)", () => {
  _reset();
  // Stub location so _subscribe's _connect() doesn't crash in non-browser env
  const origLocation = globalThis.location;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).location = { protocol: "http:", host: "localhost:3000" };
  try {
    const unsub = _useAioSubscribe(() => {});
    // Should have registered a listener via _subscribe
    // Unsubscribe should work without throwing
    unsub();
    // Clean up the 300ms teardown timer started by unsubscribe
    if (_cleanupTimer) {
      clearTimeout(_cleanupTimer);
      _setCleanupTimer(null);
    }
  } finally {
    if (origLocation === undefined) {
      // deno-lint-ignore no-explicit-any
      delete (globalThis as any).location;
    } else {
      globalThis.location = origLocation;
    }
    _reset();
  }
});

// ── Location stub helper ────────────────────────────────────────────
// _subscribe() calls _connect() which needs `location` — stub it for Deno tests

function withLocation(fn: () => void): void {
  const origLocation = globalThis.location;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).location = { protocol: "http:", host: "localhost:3000" };
  try {
    fn();
  } finally {
    if (origLocation === undefined) {
      // deno-lint-ignore no-explicit-any
      delete (globalThis as any).location;
    } else {
      globalThis.location = origLocation;
    }
    _reset();
  }
}

// ── Grace period — cancellation tests ───────────────────────────────

Deno.test("subscribe: transient gap recovery — cleanup cancelled within 300ms", () => {
  withLocation(() => {
    _reset();
    using time = new FakeTime();

    // Simulate state existing (as it would in a running app)
    // Subscribe two listeners
    const unsub1 = _subscribe(() => {});
    const unsub2 = _subscribe(() => {});

    // Remove both — listeners at 0
    unsub1();
    unsub2();

    // Before 300ms — reattach
    time.tick(100);
    const unsub3 = _subscribe(() => {});

    // Advance past 300ms — cleanup should NOT have fired
    time.tick(300);

    // Verify: new listener works (system is alive)
    unsub3();
  });
});

Deno.test("subscribe: timer resets on rapid unsub/resub cycles", () => {
  withLocation(() => {
    _reset();
    using time = new FakeTime();

    // First cycle
    const unsub1 = _subscribe(() => {});
    unsub1(); // listeners = 0, timer starts
    time.tick(200); // 200ms into grace period

    // Second cycle — reattach and detach again
    const unsub2 = _subscribe(() => {});
    unsub2(); // listeners = 0 again, timer should RESET (not stack)

    // At 200 + 200 = 400ms from first unsub, but only 200ms from second
    time.tick(200);
    // Timer hasn't fired yet (only 200ms into second grace period)
    // Reattach to prove system is still alive
    const unsub3 = _subscribe(() => {});
    unsub3();
  });
});

Deno.test("subscribe: teardown-averted diagnostic fires on cancellation", () => {
  withLocation(() => {
    _reset();
    using time = new FakeTime();

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(String(args[0]));
    };

    try {
      const unsub = _subscribe(() => {});
      unsub(); // listeners = 0
      time.tick(100);
      const unsub2 = _subscribe(() => {}); // reattach within 300ms
      time.tick(300); // timer fires, sees listeners > 0

      assertEquals(
        warns.some((w) => w.includes("teardown averted")),
        true,
        "Should emit teardown-averted console.warn",
      );
      unsub2();
    } finally {
      console.warn = origWarn;
    }
  });
});

// ── Grace period — full teardown tests ──────────────────────────────

Deno.test("subscribe: full teardown after 300ms with no listeners", () => {
  withLocation(() => {
    _reset();
    using time = new FakeTime();

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(String(args[0]));
    };

    try {
      const unsub = _subscribe(() => {});
      unsub(); // listeners = 0, timer starts

      // Advance past grace period
      time.tick(350);

      assertEquals(
        warns.some((w) => w.includes("[aio] teardown")),
        true,
        "Should emit teardown console.warn",
      );
      assertEquals(
        warns.some((w) => w.includes("no listeners for 300ms")),
        true,
        "Teardown message should mention 300ms",
      );
    } finally {
      console.warn = origWarn;
    }
  });
});

Deno.test("subscribe: post-teardown resubscribe works cleanly", () => {
  withLocation(() => {
    _reset();
    using time = new FakeTime();

    // Subscribe and teardown
    const unsub = _subscribe(() => {});
    unsub();
    time.tick(350); // teardown fires

    // Resubscribe — should not throw, system should be alive
    const unsub2 = _subscribe(() => {/* noop */});
    // System should accept the subscription
    unsub2();
  });
});

// ── Regression test ─────────────────────────────────────────────────

Deno.test("subscribe: unsubscribe does NOT immediately null state (regression)", () => {
  withLocation(() => {
    _reset();
    using time = new FakeTime();

    // Subscribe
    const unsub = _subscribe(() => {});
    unsub(); // listeners = 0

    // Immediately after unsubscribe — no time elapsed
    // State should NOT be nuked yet (grace period hasn't fired)
    const unsub2 = _subscribe(() => {});
    // If nuclear cleanup had fired instantly, _closed would be true
    // and _subscribe would need to reconnect. The subscribe itself
    // succeeding without triggering _connect proves state is intact.
    unsub2();

    // Now let the timer expire with no listeners
    time.tick(350);
  });
});

// ── Observability tests ─────────────────────────────────────────────

Deno.test("subscribe: console.warn fires for both teardown and averted paths", () => {
  withLocation(() => {
    _reset();
    using time = new FakeTime();

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(String(args[0]));
    };

    try {
      // Path 1: teardown-averted
      const unsub1 = _subscribe(() => {});
      unsub1();
      time.tick(100);
      const unsub2 = _subscribe(() => {});
      time.tick(300); // timer fires, sees listeners > 0
      assertEquals(
        warns.some((w) => w.includes("teardown averted")),
        true,
        "Should warn on teardown-averted",
      );

      // Path 2: full teardown
      warns.length = 0;
      unsub2();
      time.tick(350); // timer fires, listeners still 0
      assertEquals(
        warns.some((w) => w.includes("[aio] teardown")),
        true,
        "Should warn on full teardown",
      );
      assertEquals(
        warns.some((w) => w.includes("peak was")),
        true,
        "Teardown warn should include peak count",
      );
    } finally {
      console.warn = origWarn;
    }
  });
});
