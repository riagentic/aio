// The CORE offline queue must lose nothing — the same contract its browser
// twin already keeps.
//
// `browser/browser-air-transport.ts`'s `_flushPending` was fixed once with the
// words "it used to drain first and send second, so a throw mid-flush lost
// every action after it AND left their callers pending forever — both lost and
// unanswered, the one outcome the queue contract forbids". The isomorphic
// core's `flushOfflineQueue` still did exactly that, and it is the queue behind
// `useCell().send` / `useAio().send` on every non-browser client (CLI, service,
// Electron main) — the browser only escapes it because `_takePending` empties
// this queue before installing the transport.
//
// Two facts, both silent before this file existed:
//
//  1. A transport that refuses ONE write (a socket that reports OPEN and
//     throws — the case the browser twin exists for) lost that action and
//     every action queued behind it. `setTransport()` is where the flush runs,
//     so the throw also escaped the reconnect path.
//  2. An action JSON cannot carry (a BigInt, a cycle) was ACCEPTED into the
//     queue — `send()` only encodes when a transport is attached — and became
//     a poison pill: the flush threw on it and discarded the rest of the queue
//     with it. Online the same call throws at the call site, so the two halves
//     of one door disagreed about the same value.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { _resetActionWarnings } from "../src/state/action-encode.ts";
import { _resetTransport, send } from "../src/state/state-transport.ts";
// The REAL reconnect door: `state-core`'s wrapper is what passes the
// onConnected callback that flushes the queue. `state-transport.setTransport`
// alone installs a transport and flushes nothing, so a test that used it would
// prove the flush works by never running it.
import { setTransport } from "../src/state-core.ts";

/** A transport that throws on the nth send (0-based), recording the rest. */
function flakyTransport(throwOn: number) {
  const sent: string[] = [];
  let n = 0;
  return {
    sent,
    transport: {
      send(d: string) {
        if (n++ === throwOn) throw new Error("socket refused the write");
        sent.push(d);
      },
      close() {},
    },
  };
}

const typesOf = (sent: string[]) =>
  sent.map((s) => (JSON.parse(s) as { d: { type: string } }).d.type);

Deno.test("core offline flush: a refused write loses neither that action nor the ones behind it", () => {
  _resetTransport();
  try {
    for (const t of ["q:a", "q:b", "q:c"]) send({ type: t });
    const { sent, transport } = flakyTransport(1); // b is refused
    // The flush runs inside setTransport's onConnected — a throw there escapes
    // the reconnect path itself, which is the second half of the same defect.
    setTransport(transport);
    assertEquals(typesOf(sent), ["q:a"], "the flush stops at the refusal");

    // b and c must still be queued, in order, for the next open.
    const { sent: sent2, transport: ok } = flakyTransport(-1);
    setTransport(null);
    setTransport(ok);
    assertEquals(
      typesOf(sent2),
      ["q:b", "q:c"],
      "the remainder replays on the next connection, in the order the user acted",
    );
  } finally {
    _resetTransport();
  }
});

Deno.test("core offline send: a value JSON cannot carry is refused at the call, not queued", () => {
  _resetTransport();
  try {
    send({ type: "q:before" });
    assertThrows(
      () => send({ type: "q:poison", payload: { args: [{ n: 10n }] } }),
      Error,
      "q:poison",
      "the caller must hear it now — the action can never be delivered",
    );
    const cyclic: Record<string, unknown> = { self: null };
    cyclic.self = cyclic;
    assertThrows(
      () => send({ type: "q:cycle", payload: { args: [cyclic] } }),
      Error,
      "q:cycle",
    );
    send({ type: "q:after" });

    const { sent, transport } = flakyTransport(-1);
    setTransport(transport);
    assertEquals(
      typesOf(sent),
      ["q:before", "q:after"],
      "nothing poisoned the queue, and nothing else was dropped with it",
    );
  } finally {
    _resetTransport();
  }
});

Deno.test("core offline send: an ONLINE poison call is refused the same way", () => {
  _resetTransport();
  try {
    const { transport } = flakyTransport(-1);
    setTransport(transport);
    const err = assertThrows(
      () => send({ type: "q:online", payload: { args: [{ n: 1n }] } }),
      Error,
    ) as Error;
    assert(
      /q:online/.test(err.message) && /BigInt|circular/i.test(err.message),
      `the refusal must name the action and the reason, got: ${err.message}`,
    );
  } finally {
    _resetTransport();
  }
});

// ── the OTHER half of the same door: a value the wire CHANGES ───────────────
//
// `serverFn` arguments have warned since alpha76 that "the server receives
// DIFFERENT values than the caller passed". A cell method's arguments cross
// the identical wire and said nothing, so `cell.due(new Date())` stored a Date
// in `testCell` (no wire) and an ISO string in a browser — the exact shape
// CLAUDE.md calls green-test-broken-prod. Dev warns now; prod is byte-for-byte
// what it was (category (b) of the dev/prod rule: dev STRICTER, never the
// reverse).

function capture(): { seen: string[]; restore: () => void } {
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") seen.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  return { seen, restore: () => setLogger(prev) };
}

Deno.test("dev: a method argument the wire silently CHANGES is named", () => {
  _resetTransport();
  _resetActionWarnings();
  setDevModeOverride(true);
  const { seen, restore } = capture();
  try {
    setTransport(flakyTransport(-1).transport);
    send({
      type: "q:due",
      payload: { args: [{ at: new Date(0), tags: new Set(["a"]) }] },
    });
    assertEquals(
      seen.length,
      1,
      `expected one warning, got: ${seen.join("|")}`,
    );
    const w = seen[0]!;
    assertStringIncludes(w, "q:due");
    assertStringIncludes(w, "Date → string");
    assertStringIncludes(w, "Set → Object");

    // Said once per shape: a method called on every keystroke must not flood.
    send({
      type: "q:due",
      payload: { args: [{ at: new Date(1), tags: new Set(["b"]) }] },
    });
    assertEquals(seen.length, 1, "the same loss in the same method says once");

    // …but a DIFFERENT loss in the same method is still said.
    send({ type: "q:due", payload: { args: [{ n: NaN }] } });
    assertEquals(seen.length, 2, "a new shape is a new warning");
  } finally {
    restore();
    setDevModeOverride(null);
    _resetTransport();
  }
});

Deno.test("prod: the same call is silent, and lands the same bytes", () => {
  _resetTransport();
  _resetActionWarnings();
  setDevModeOverride(false);
  const { seen, restore } = capture();
  try {
    const { sent, transport } = flakyTransport(-1);
    setTransport(transport);
    send({ type: "q:due", payload: { args: [{ at: new Date(0) }] } });
    assertEquals(seen, [], "prod says nothing — observe-only is dev's half");
    assertStringIncludes(sent[0]!, "1970-01-01T00:00:00.000Z");
  } finally {
    restore();
    setDevModeOverride(false);
    setDevModeOverride(null);
    _resetTransport();
  }
});
