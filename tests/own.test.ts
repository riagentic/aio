// AIO-382: keyed disposer slots — own.set/own.dispose effects with
// schedule-like replace semantics, disposed on cell disable + app shutdown.

import { assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { bootCells, testCell } from "../src/testing/cell-test.ts";
import {
  createOwnManager,
  isOwnEffect,
  own,
  type OwnEffect,
} from "../src/state/own.ts";

const noop = {
  info: (_: string) => {},
  warn: (_: string) => {},
  error: (_: string) => {},
  debug: (_: string) => {},
};

// ── Effect creators ─────────────────────────────────────────────────

Deno.test("own.set returns a plain, structuredClone-safe effect", () => {
  const eff = own.set("w:watcher", () => () => {});
  assertEquals(eff.type, "__own");
  assertEquals(eff.kind, "set");
  assertEquals(eff.id, "w:watcher");
  // Must survive the dispatch pipeline's structuredClone (no function inside).
  const cloned = structuredClone(eff);
  assertEquals(cloned, eff);
});

Deno.test("isOwnEffect guards correctly", () => {
  assertEquals(isOwnEffect(own.set("a", () => {})), true);
  assertEquals(isOwnEffect(own.dispose("a")), true);
  assertEquals(
    isOwnEffect({ type: "__schedule", kind: "cancel", id: "a" }),
    false,
  );
  assertEquals(isOwnEffect(null), false);
  assertEquals(isOwnEffect("__own"), false);
});

// ── Manager semantics ───────────────────────────────────────────────

Deno.test("own manager: set acquires, same id replaces (old disposer first)", () => {
  const mgr = createOwnManager(noop);
  const events: string[] = [];

  mgr.handle(own.set("c:res", () => {
    events.push("acquire-1");
    return () => events.push("dispose-1");
  }));
  assertEquals(events, ["acquire-1"]);
  assertEquals(mgr.active(), ["c:res"]);

  mgr.handle(own.set("c:res", () => {
    events.push("acquire-2");
    return () => events.push("dispose-2");
  }));
  // Replace semantics: previous disposer runs BEFORE the new factory.
  assertEquals(events, ["acquire-1", "dispose-1", "acquire-2"]);
  assertEquals(mgr.active(), ["c:res"]);
});

Deno.test("own manager: dispose effect frees the slot, empty slot is a no-op", () => {
  const mgr = createOwnManager(noop);
  const events: string[] = [];
  mgr.handle(own.set("c:res", () => () => events.push("disposed")));
  mgr.handle(own.dispose("c:res"));
  assertEquals(events, ["disposed"]);
  assertEquals(mgr.active(), []);
  mgr.handle(own.dispose("c:res")); // empty — no throw, no double dispose
  assertEquals(events, ["disposed"]);
});

Deno.test("own manager: disposeAll frees everything", () => {
  const mgr = createOwnManager(noop);
  const events: string[] = [];
  mgr.handle(own.set("a:1", () => () => events.push("a")));
  mgr.handle(own.set("b:2", () => () => events.push("b")));
  mgr.disposeAll();
  assertEquals(events.sort(), ["a", "b"]);
  assertEquals(mgr.active(), []);
});

Deno.test("own manager: disposeByPrefix matches the ':' delimiter (AIO-198 rule)", () => {
  const mgr = createOwnManager(noop);
  const events: string[] = [];
  mgr.handle(own.set("user:watcher", () => () => events.push("user")));
  mgr.handle(
    own.set("userProfile:watcher", () => () => events.push("userProfile")),
  );
  mgr.disposeByPrefix("user");
  assertEquals(events, ["user"]);
  assertEquals(mgr.active(), ["userProfile:watcher"]);
});

Deno.test("own manager: consumed/missing token is a no-op and keeps the live resource", () => {
  const mgr = createOwnManager(noop);
  const events: string[] = [];
  const eff = own.set("c:res", () => {
    events.push("acquire");
    return () => events.push("dispose");
  });
  mgr.handle(eff);
  mgr.handle(eff); // replay: token already consumed
  assertEquals(events, ["acquire"]);
  assertEquals(mgr.active(), ["c:res"]);
});

Deno.test("own manager: factory returning a closeable object", () => {
  const mgr = createOwnManager(noop);
  let closed = 0;
  mgr.handle(own.set("c:sock", () => ({ close: () => closed++ })));
  mgr.disposeAll();
  assertEquals(closed, 1);
});

Deno.test("own manager: throwing factory/disposer is contained", () => {
  const mgr = createOwnManager(noop);
  mgr.handle(own.set("c:bad", () => {
    throw new Error("acquire failed");
  }));
  assertEquals(mgr.active(), []); // nothing stored
  mgr.handle(own.set("c:res", () => () => {
    throw new Error("dispose failed");
  }));
  mgr.disposeAll(); // must not throw
  assertEquals(mgr.active(), []);
});

Deno.test("own manager: invalid id throws", () => {
  const mgr = createOwnManager(noop);
  assertThrows(() => mgr.handle(own.set("bad id!", () => {})));
});

// ── Cell integration: effects flow through reduce ───────────────────

/** Factory runs, recorded — the only way to see an ASYNC method's `$do`, which
 *  dispatches mid-method rather than riding the reduce's effects array. */
const holderLog: string[] = [];

const holder = cell("holder382", {
  state: { acquired: 0 },
  methods: {
    acquire(s) {
      s.acquired += 1;
      s.$do(own.set("holder382:res", () => {
        holderLog.push("acquire");
        return () => holderLog.push("dispose");
      }));
    },
    release(s) {
      s.$do(own.dispose("holder382:res"));
    },
    async acquireAsync(s) {
      await Promise.resolve();
      s.acquired += 1;
      s.$do(own.set("holder382:res", () => {
        holderLog.push("acquire:async");
        return () => holderLog.push("dispose:async");
      }));
    },
  },
});

testCell(holder, "sync method: $do(own.set) emits the effect", (t) => {
  t.init();
  t.send.acquire!();
  t.expect.state((s) => s.acquired === 1);
  const effects = t.getEffects();
  assertEquals(effects.length, 1);
  assertEquals(isOwnEffect(effects[0]), true);
  assertEquals((effects[0] as OwnEffect).id, "holder382:res");
});

testCell(holder, "sync method: $do(own.dispose) emits the effect", (t) => {
  t.init();
  t.send.release!();
  const effects = t.getEffects();
  assertEquals(effects.length, 1);
  assertEquals((effects[0] as OwnEffect).kind, "dispose");
});

Deno.test(
  "async method: $do(own.set) reaches the registry (AIO-381 path)",
  async () => {
    holderLog.length = 0;
    const h = await bootCells([holder]);
    try {
      // deno-lint-ignore no-explicit-any
      await (holder as any).acquireAsync();
      assertEquals(holderLog, ["acquire:async"], "the factory ran");
    } finally {
      h.dispose();
    }
    assertEquals(holderLog, ["acquire:async", "dispose:async"]);
  },
);
