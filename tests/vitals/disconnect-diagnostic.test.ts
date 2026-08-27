// tests/vitals/disconnect-diagnostic.test.ts
//
// What a client freeze actually TELLS you. Two things were structurally
// impossible before this file existed, and both were invisible because the
// alert still fired and the suite still passed:
//
//  1. The number. `onClientFrozen` recomputed the freeze duration as
//     `Date.now() - c.frozenSince`, and `frozenSince` is stamped ON that very
//     transition — so `measured` was ~0 every single time, and the reporter's
//     one human-readable line read "DISCONNECTED — client unreachable for
//     0.0s" forever, whatever had happened. The probe had the real gap and
//     threw it away.
//
//  2. The hint. `buildSnapshot()` hardcoded the transport layer to
//     `healthy / 0`, so the hint engine's rule 3 — "Network connection
//     stalled. No pong in Nms" — could never match. Every client-freeze alert
//     went out with `hint: null`, and the reporter fell back to its generic
//     string, while the rule written for exactly this alert sat one field
//     away.
import { assert, assertEquals } from "@std/assert";
import { createVitalsSystem } from "../../src/vitals/mod.ts";
import { DEFAULT_THRESHOLDS } from "../../src/vitals/types.ts";
import type { DiagEvent, VitalAlert } from "../../src/vitals/types.ts";

/** Run `fn` with the wall clock advanced by `ms`. The probes take every
 *  timestamp from `Date.now()` (the one-clock invariant), so this is the whole
 *  simulation — no sleeping, no injected clock plumbing. */
function atPlus<T>(ms: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

const FROZEN = DEFAULT_THRESHOLDS.transport.frozen;

Deno.test("vitals: a client freeze reports how long it has been unreachable", () => {
  const alerts: VitalAlert[] = [];
  const v = createVitalsSystem({ onVitalAlert: (a) => alerts.push(a) });
  try {
    v.serverTransport.onClientPing("c1");
    atPlus(FROZEN + 5_000, () => v.checkAndAlert());

    assertEquals(alerts.length, 1);
    const a = alerts[0]!;
    assertEquals(a.layer, "transport");
    assertEquals(a.status, "frozen");
    assert(
      a.measured >= FROZEN + 5_000,
      `measured must be the ping gap that tripped the threshold, got ${a.measured}`,
    );
    assertEquals(a.duration, a.measured);
  } finally {
    v.destroy();
  }
});

Deno.test("vitals: a client freeze carries the transport-stall hint", () => {
  const alerts: VitalAlert[] = [];
  const v = createVitalsSystem({ onVitalAlert: (a) => alerts.push(a) });
  try {
    v.serverTransport.onClientPing("c1");
    atPlus(FROZEN + 5_000, () => v.checkAndAlert());

    const hint = alerts[0]?.hint;
    assert(hint, "a client-freeze alert must carry rule 3's hint, got null");
    assert(
      /stalled/i.test(hint.cause) && /\d+ms/.test(hint.cause),
      `the cause must name the stall and the measurement — got "${hint.cause}"`,
    );
    assert(
      /network/i.test(hint.suggestion),
      `the suggestion must name the fix — got "${hint.suggestion}"`,
    );
  } finally {
    v.destroy();
  }
});

Deno.test("vitals: the reported disconnect summary is never 0.0s", () => {
  const events: DiagEvent[] = [];
  const v = createVitalsSystem({ onDiagnostic: (e) => events.push(e) });
  try {
    v.serverTransport.onClientPing("c1");
    atPlus(FROZEN + 5_000, () => v.checkAndAlert());

    const disconnect = events.find((e) => e.kind === "disconnect");
    assert(
      disconnect,
      `expected a disconnect event, got ${events.map((e) => e.kind)}`,
    );
    assert(
      typeof disconnect.detail.frozenFor === "number" &&
        disconnect.detail.frozenFor >= FROZEN,
      `frozenFor must be the real gap, got ${disconnect.detail.frozenFor}`,
    );
    assert(
      !/for 0\.0s/.test(disconnect.summary),
      `the summary reported a zero-length disconnect: "${disconnect.summary}"`,
    );
    assert(
      /network/i.test(String(disconnect.detail.hint)),
      `the disconnect detail must carry rule 3's suggestion, got "${disconnect.detail.hint}"`,
    );
  } finally {
    v.destroy();
  }
});

Deno.test("vitals: a healthy client produces no transport hint", () => {
  // The mirror of the three above: the guard must not have become "always
  // frozen". A live client is healthy and says nothing.
  const alerts: VitalAlert[] = [];
  const v = createVitalsSystem({ onVitalAlert: (a) => alerts.push(a) });
  try {
    v.serverTransport.onClientPing("c1");
    v.checkAndAlert();
    assertEquals(alerts.length, 0);
    assertEquals(v.getEndpointData().clients[0]?.frozenFor, undefined);
  } finally {
    v.destroy();
  }
});
