// Findings from the static audit, each pinned where it was fixed.
//
// The audit's own framing — "severity is my judgment of reachability × impact,
// not a claim that each is a confirmed bug" — is the right one: this project
// has refuted reported causes before. Everything below was verified against the
// source (and, where a behaviour could be driven, against a running app) before
// it was touched.
import { assert, assertEquals } from "@std/assert";
import { createServerDiagReporter } from "../src/vitals/diag-reporter.ts";
import type {
  LoopSnapshot,
  TransportSnapshot,
} from "../src/vitals/diag-reporter.ts";
import type { VitalAlert } from "../src/vitals/types.ts";

/** A minimal alert of the given status — only the fields the mapper reads. */
const alertOf = (status: VitalAlert["status"]): VitalAlert => ({
  id: "a1",
  layer: "transport",
  status,
  duration: 0,
  measured: 0,
  threshold: 0,
  hint: null,
  ts: 0,
});

// ── M7: recovery alerts were dropped ─────────────────────────────────────────
// `VitalStatus` carries BOTH "healthy" and "recovered". The reporter mapped
// only "healthy", and the one site that fires a recovery
// (`vitals/mod.ts` onClientRecovered) uses "recovered" — so every recovery fell
// through to null. The reporter had a recovered branch and dedup logic for an
// event it could never receive.

function reporterProbe() {
  const events: Array<{ kind: string }> = [];
  const clients: Array<{ id: string; status: string }> = [];
  const reporter = createServerDiagReporter({
    onDiagnostic: (e) => events.push({ kind: e.kind }),
    onConsole: () => {}, // silence — the assertion is on the event, not the log
    getLoopSnapshot: (): LoopSnapshot => ({
      status: "healthy",
      queueDepth: 0,
      drainRate: 0,
      lastReduceTime: 0,
      lastReduceAction: "",
      lastReduceCell: "",
      p95ReduceTime: 0,
      effectBacklog: 0,
      circuitBreakers: [],
      firstDegradedAt: null,
    }),
    // Mutable: the mapper reads the SNAPSHOT, not just the alert — a
    // degradation is "a frozen client is present", and the recovery that
    // follows is that same client gone.
    getTransportSnapshot: (): TransportSnapshot => ({ clients: [...clients] }),
  });
  return { reporter, events, clients };
}

Deno.test("M7: a transport recovery reaches the reporter", () => {
  const { reporter, events, clients } = reporterProbe();
  // A recovery is only meaningful after a degradation — the reporter dedups
  // "recovered from nothing" on purpose, so drive the real sequence: a frozen
  // client appears, then it is gone.
  clients.push({ id: "c1", status: "frozen" });
  reporter.onAlert(alertOf("frozen"));
  clients.length = 0;
  reporter.onAlert(alertOf("recovered"));
  assertEquals(
    events.map((e) => e.kind),
    ["disconnect", "recovered"],
    "the status the framework actually fires must map to the branch that exists",
  );
});

Deno.test("M7: the older 'healthy' spelling still maps too", () => {
  // Both are real members of VitalStatus; accepting one and not the other is
  // how this went quiet in the first place.
  const { reporter, events, clients } = reporterProbe();
  clients.push({ id: "c1", status: "frozen" });
  reporter.onAlert(alertOf("frozen"));
  clients.length = 0;
  reporter.onAlert(alertOf("healthy"));
  assertEquals(events.map((e) => e.kind), ["disconnect", "recovered"]);
});

Deno.test("M7: recovery from nothing is still not an event", () => {
  // The dedup is deliberate; widening the status match must not widen this.
  const { reporter, events } = reporterProbe();
  reporter.onAlert(alertOf("recovered"));
  reporter.onAlert(alertOf("recovered"));
  assertEquals(events, []);
});
