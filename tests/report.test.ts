// report.test.ts — a problem report must answer the questions a maintainer
// would ask anyway, must never carry what the app said to retain nowhere, and
// must stay small enough to attach to an issue.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildReport,
  listReports,
  REPORT_LIMITS,
  type ReportSources,
  summarize,
  writeReport,
} from "../src/server/report.ts";
import { makeRedactor } from "../src/diagnostics/redact.ts";
import type { TimelineEntry } from "../src/server/timeline.ts";

async function tmp(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "aio-report-" });
}

function sources(over: Partial<ReportSources> = {}): ReportSources {
  return {
    appId: "wallet",
    appVersion: "1.4.0",
    aioVersion: "1.0.0-alpha53",
    dataDir: "/home/u/.wallet/data",
    logsDir: "/home/u/.wallet/logs",
    exposed: false,
    persist: true,
    cells: ["wallet", "prices"],
    ...over,
  };
}

Deno.test("report: answers what is running, without being asked", async () => {
  const r = await buildReport(
    { kind: "user", title: "the balance is wrong", body: "after a restore" },
    sources({ channel: "prod", commit: "abc123" }),
  );

  // The questions a maintainer asks first, all answered from the process.
  assertEquals(r.app.id, "wallet");
  assertEquals(r.app.version, "1.4.0");
  assertEquals(r.app.channel, "prod");
  assertEquals(r.app.commit, "abc123");
  assertEquals(r.app.build, "source"); // under `deno test`, and read not assumed
  assertEquals(r.app.platform, `${Deno.build.os}/${Deno.build.arch}`);
  assertEquals(r.environment.cells, ["wallet", "prices"]);
  assertEquals(r.body, "after a restore");
  assert(r.id.length > 10 && r.createdAt.endsWith("Z"));
});

Deno.test("report: honours the SAME redaction rule as the journal", async () => {
  // The rule this enforces: a report carries state, and the app already
  // declared which state must be retained nowhere. A report that ignored that
  // would be the leak the list exists to prevent.
  const redact = makeRedactor(["wallet:unlockWith"]);
  const r = await buildReport(
    { kind: "user", title: "x" },
    sources({
      redact,
      getState: () => ({
        wallet: { passphrase: "hunter2", balance: 10 },
        prices: { btc: 1 },
      }),
    }),
  );

  assertEquals(r.state?.wallet, "[redacted]");
  // The cell that was NOT redacted still comes through — withholding
  // everything would make reports useless.
  assertEquals((r.state?.prices as Record<string, unknown>).btc, 1);
  // And the absence is NAMED, so it reads as a decision rather than as "this
  // app has no wallet state".
  assertEquals(r.redactedCells, ["wallet"]);
});

Deno.test("report: with no redaction declared, state comes through whole", async () => {
  const r = await buildReport(
    { kind: "user", title: "x" },
    sources({
      getState: () => ({ wallet: { balance: 10 } }),
    }),
  );
  assertEquals(r.state?.wallet, { balance: 10 });
  assertEquals(r.redactedCells, undefined);
});

Deno.test("report: oversized state is DROPPED, not truncated, and says so", async () => {
  // Half a state tree misleads in a way that none does not — a maintainer
  // reading a truncated object cannot tell which fields were missing versus
  // which were never set.
  const huge = { blob: "x".repeat(REPORT_LIMITS.stateBytes + 1000) };
  const r = await buildReport(
    { kind: "user", title: "x" },
    sources({
      getState: () => huge,
    }),
  );
  assertEquals(r.state, undefined);
  assert(r.truncated?.some((t) => t.includes("state omitted")));
});

Deno.test("report: the timeline is capped, newest kept, and truncation stated", async () => {
  const many: TimelineEntry[] = Array.from({ length: 250 }, (_, i) => ({
    seq: i,
    ts: i,
    type: `act:${i}`,
    diff: [],
  }));
  const r = await buildReport(
    { kind: "user", title: "x" },
    sources({
      getTimeline: () => many,
    }),
  );

  assertEquals(r.timeline?.length, REPORT_LIMITS.timelineEntries);
  // Newest LAST: a maintainer reads toward the failure, not away from it.
  assertEquals(r.timeline?.at(-1)?.type, "act:249");
  assert(r.truncated?.some((t) => t.includes("timeline trimmed")));
});

Deno.test("report: a source that throws costs that section, not the report", async () => {
  // Capturing a problem must never cause one — the report is about something
  // that is already going wrong.
  const r = await buildReport(
    { kind: "crash", title: "boom" },
    sources({
      getState: () => {
        throw new Error("state is unreadable right now");
      },
      getTimeline: () => {
        throw new Error("timeline is gone");
      },
    }),
  );
  assertEquals(r.kind, "crash");
  assertEquals(r.title, "boom");
  assertEquals(r.state, undefined);
  assert(r.truncated?.some((t) => t.includes("state could not be captured")));
  assert(
    r.truncated?.some((t) => t.includes("timeline could not be captured")),
  );
});

Deno.test("report: unserializable state is dropped rather than exploding", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const r = await buildReport(
    { kind: "user", title: "x" },
    sources({
      getState: () => circular,
    }),
  );
  assertEquals(r.state, undefined);
  assert(r.truncated?.length);
});

Deno.test("report: written, listed newest-first, and summarizable", async () => {
  const dir = await tmp();
  try {
    const a = await buildReport({
      kind: "user",
      title: "first",
      id: "2026-01-01-aaa",
    }, sources({ dataDir: dir }));
    const b = await buildReport({
      kind: "error",
      title: "second",
      id: "2026-02-02-bbb",
    }, sources({ dataDir: dir }));
    const pathA = await writeReport(dir, a);
    await writeReport(dir, b);
    assertStringIncludes(pathA, join("reports", "2026-01-01-aaa.json"));

    const all = await listReports(dir);
    assertEquals(all.map((r) => r.title), ["second", "first"]);
    assertStringIncludes(summarize(all[0]!), "ERROR");
    assertStringIncludes(summarize(all[0]!), "wallet 1.4.0");

    // A half-written file must not lose the rest.
    await Deno.writeTextFile(join(dir, "reports", "broken.json"), "{ nope");
    assertEquals((await listReports(dir)).length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("report: listing a directory that does not exist is empty, not an error", async () => {
  assertEquals(await listReports("/nonexistent/nowhere"), []);
});
