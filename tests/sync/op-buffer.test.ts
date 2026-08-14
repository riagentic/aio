import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { createOpBuffer, parseRetention } from "../../src/sync/op-buffer.ts";
import type { SyncOp } from "../../src/sync/types.ts";
import { createMemoryStorage } from "./_memory-storage.ts";

describe("OpBuffer", () => {
  const mkOp = (id: string, cell = "todos"): SyncOp => ({
    id,
    cell,
    action: "add",
    payload: { text: "test" },
    hlc: [Date.now(), 0, "c1"],
    confirmed: false,
  });

  it("adds and loads ops", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    const op = mkOp("op1");
    await buf.add(op);
    const loaded = await buf.getUnconfirmed("todos");
    assertEquals(loaded.length, 1);
    assertEquals(loaded[0]!.id, "op1");
  });

  it("confirms ops", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    await buf.add(mkOp("op1"));
    await buf.confirm("todos", "op1", [2000, 0, "s"]);
    const unconfirmed = await buf.getUnconfirmed("todos");
    assertEquals(unconfirmed.length, 0);
  });

  it("enforces pending cap", async () => {
    const buf = createOpBuffer(createMemoryStorage(), { pendingCap: 3 });
    await buf.add(mkOp("op1"));
    await buf.add(mkOp("op2"));
    await buf.add(mkOp("op3"));
    const result = await buf.add(mkOp("op4"));
    assertEquals(result, false); // rejected — cap hit
  });

  it("prunes confirmed ops", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    await buf.add(mkOp("op1"));
    await buf.add(mkOp("op2"));
    await buf.confirm("todos", "op1", [2000, 0, "s"]);
    await buf.pruneConfirmed("todos");
    const all = await buf.getUnconfirmed("todos");
    assertEquals(all.length, 1);
    assertEquals(all[0]!.id, "op2");
  });

  it("confirm() marks the op without touching cursor meta", async () => {
    // 2026-07-21 chaos-suite finding: an ack is NOT a delivery watermark —
    // advancing lastHlc to the ack's serverHlc made catch-up skip peer ops
    // persisted before the ack that this client never received. confirm()
    // now only marks the op; cursors move on actually delivered data.
    const buf = createOpBuffer(createMemoryStorage());
    await buf.add(mkOp("op1"));
    await buf.confirm("todos", "op1", [2000, 5, "s"]);
    assertEquals(await buf.getMeta("todos"), undefined);
    assertEquals((await buf.getUnconfirmed("todos")).length, 0, "confirmed");
  });

  it("clears all data for a cell", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    await buf.add(mkOp("op1"));
    await buf.clear("todos");
    const loaded = await buf.getUnconfirmed("todos");
    assertEquals(loaded.length, 0);
  });

  it("evicts stale ops when buffer is full (H3 backpressure fix)", async () => {
    const buf = createOpBuffer(createMemoryStorage(), {
      pendingCap: 2,
      staleAfter: 10_000,
    });

    await buf.add({ ...mkOp("fresh"), _clientTs: Date.now() });
    await buf.add({ ...mkOp("old-stale"), _clientTs: Date.now() - 5 * 60_000 }); // 5 min old

    const result = await buf.add({ ...mkOp("new-op"), _clientTs: Date.now() });
    assertEquals(result, true); // accepted after eviction

    const unconfirmed = await buf.getUnconfirmed("todos");
    assertEquals(unconfirmed.length, 2);
    const ids = unconfirmed.map((o) => o.id).sort();
    assertEquals(ids, ["fresh", "new-op"]); // stale op was evicted
  });

  it("does not evict non-stale ops when buffer is full", async () => {
    const buf = createOpBuffer(createMemoryStorage(), { pendingCap: 2 });

    // Add two fresh ops (no _clientTs means they're not eligible for TTL eviction)
    await buf.add(mkOp("fresh1"));
    await buf.add(mkOp("fresh2"));

    // Adding a third should fail — no stale ops to evict
    const result = await buf.add({ ...mkOp("new-op"), _clientTs: Date.now() });
    assertEquals(result, false);
  });

  it("frees room by pruning CONFIRMED ops when the cap is hit", async () => {
    const buf = createOpBuffer(createMemoryStorage(), { pendingCap: 2 });
    await buf.add(mkOp("op1"));
    await buf.add(mkOp("op2"));
    // Server acks op1 — it's now confirmed but still occupying a slot.
    await buf.confirm("todos", "op1", [2000, 0, "s"]);
    // Cap is hit by raw count, but pruning the confirmed op frees a slot, so
    // the new op is accepted (exercises the prune-confirmed-makes-room branch).
    const result = await buf.add(mkOp("op3"));
    assertEquals(result, true);
    const unconfirmed = await buf.getUnconfirmed("todos");
    assertEquals(unconfirmed.map((o) => o.id).sort(), ["op2", "op3"]);
  });

  it("invokes onDrop('prune-failed') when a full buffer has nothing to evict", async () => {
    const dropped: { id: string; reason: string }[] = [];
    const buf = createOpBuffer(createMemoryStorage(), {
      pendingCap: 2,
      onDrop: (op, reason) => dropped.push({ id: op.id, reason }),
    });
    // Two fresh, unconfirmed, non-stale ops → neither prunable nor evictable.
    await buf.add(mkOp("keep1"));
    await buf.add(mkOp("keep2"));
    const result = await buf.add(mkOp("rejected"));
    assertEquals(result, false);
    assertEquals(dropped, [{ id: "rejected", reason: "prune-failed" }]);
  });

  it("round-trips a snapshot (save then load)", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    assertEquals(await buf.loadSnapshot("todos"), undefined); // empty first
    const snap = { state: { items: [1, 2, 3] }, hlc: [500, 2, "s"] as const };
    await buf.saveSnapshot("todos", { state: snap.state, hlc: [500, 2, "s"] });
    const loaded = await buf.loadSnapshot("todos");
    assertEquals(loaded?.state, snap.state);
    assertEquals(loaded?.hlc, [500, 2, "s"]);
  });

  it("saveMeta persists lastHlc + lastServerTs independently of confirm()", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    assertEquals(await buf.getMeta("todos"), undefined);
    await buf.saveMeta("todos", {
      lastHlc: [900, 1, "s"],
      lastServerTs: 12345,
    });
    const meta = await buf.getMeta("todos");
    assertEquals(meta?.lastHlc, [900, 1, "s"]);
    assertEquals(meta?.lastServerTs, 12345);
  });

  it("clear() also wipes snapshot + meta, not just ops", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    await buf.add(mkOp("op1"));
    await buf.saveSnapshot("todos", { state: { n: 1 }, hlc: [1, 0, "s"] });
    await buf.saveMeta("todos", { lastHlc: [1, 0, "s"] });
    await buf.clear("todos");
    assertEquals(await buf.getUnconfirmed("todos"), []);
    assertEquals(await buf.loadSnapshot("todos"), undefined);
    assertEquals(await buf.getMeta("todos"), undefined);
  });

  it("isolates ops by cell", async () => {
    const buf = createOpBuffer(createMemoryStorage());
    await buf.add(mkOp("a1", "cellA"));
    await buf.add(mkOp("b1", "cellB"));
    await buf.add(mkOp("b2", "cellB"));
    assertEquals((await buf.getUnconfirmed("cellA")).map((o) => o.id), ["a1"]);
    assertEquals((await buf.getUnconfirmed("cellB")).map((o) => o.id), [
      "b1",
      "b2",
    ]);
    // Clearing one cell leaves the other intact.
    await buf.clear("cellA");
    assertEquals(await buf.getUnconfirmed("cellA"), []);
    assertEquals((await buf.getUnconfirmed("cellB")).length, 2);
  });
});

// eviction under backpressure discards UNCONFIRMED ops: mutations the
// user made that never reached the server. `onDrop` fired only for the
// INCOMING op when pruning failed, never for the ones actually thrown away, so
// the exact offline-queue changes this buffer exists to preserve vanished with
// nothing to observe.
Deno.test("op-buffer: an evicted stale op is REPORTED, not silently dropped", async () => {
  const dropped: { id: string; reason: string }[] = [];
  const storage = createMemoryStorage();
  const buffer = createOpBuffer(storage, {
    pendingCap: 2,
    staleAfter: 1000,
    onDrop: (op, reason) => dropped.push({ id: op.id, reason }),
  });

  const op = (id: string, clientTs: number): SyncOp => ({
    id,
    hlc: [clientTs, 0, "me"],
    cell: "notes",
    action: "add",
    payload: { t: id },
    confirmed: false,
    _clientTs: clientTs,
  });

  const old = Date.now() - 60_000; // well past the 1s TTL
  assertEquals(await buffer.add(op("a", old)), true);
  assertEquals(await buffer.add(op("b", old)), true);

  // Buffer is at cap; adding forces eviction of the two stale ops.
  assertEquals(await buffer.add(op("c", Date.now())), true);

  assertEquals(
    dropped.map((d) => d.id).sort(),
    ["a", "b"],
    "every evicted mutation is reported",
  );
  assertEquals(
    [...new Set(dropped.map((d) => d.reason))],
    ["stale-evicted"],
    "with a reason that says what happened",
  );
});

// ── retention: the value the app asked for is the value that runs ────
//
// `parseRetention` used to swallow anything it could not read and return the
// 4h default. `retention: "7d"` — the value docs/persistence/crdt.md puts in
// its own example — has no `d` unit in the old regex, so it silently became
// 4h: the offline queue evicted the user's unsent changes 42× earlier than the
// app asked for, with nothing to see anywhere. A retention that cannot be
// honoured is a misconfig, and a misconfig speaks.
Deno.test("op-buffer: parseRetention reads every documented unit, including days", () => {
  assertEquals(parseRetention("500ms"), 500);
  assertEquals(parseRetention("30s"), 30_000);
  assertEquals(parseRetention("15m"), 900_000);
  assertEquals(parseRetention("4h"), 4 * 3_600_000);
  assertEquals(parseRetention("7d"), 7 * 86_400_000);
  assertEquals(parseRetention(" 7d "), 7 * 86_400_000, "trimmed, not refused");
});

Deno.test("op-buffer: a retention it cannot honour throws — it never becomes 4h", () => {
  for (const bad of ["7 days", "1w", "abc", "", "-1h", "1.5h", "h"]) {
    let msg = "";
    try {
      parseRetention(bad);
    } catch (e) {
      msg = String(e);
    }
    assertStringIncludes(
      msg,
      "is not a duration",
      `"${bad}" must be refused loudly, not silently defaulted`,
    );
  }
});

// The per-cell wiring: `sync: { offline: { retention } }` was normalized,
// typed and documented — and read by nobody, so every cell evicted at the
// shared default no matter what it asked for.
Deno.test("op-buffer: each cell evicts on ITS OWN retention", async () => {
  const dropped: string[] = [];
  const buffer = createOpBuffer(createMemoryStorage(), {
    pendingCap: 2,
    staleAfter: 1000, // the default, for cells that say nothing
    staleAfterFor: (cell) => cell === "patient" ? 86_400_000 : undefined,
    onDrop: (op, reason) => dropped.push(`${op.cell}:${op.id}:${reason}`),
  });
  const op = (cell: string, id: string, clientTs: number): SyncOp => ({
    id,
    hlc: [clientTs, 0, "me"],
    cell,
    action: "add",
    payload: {},
    confirmed: false,
    _clientTs: clientTs,
  });
  const hourOld = Date.now() - 3_600_000;

  // A cell asking for a day of retention keeps hour-old ops — so the cap
  // refuses the new op rather than throwing the user's work away.
  assertEquals(await buffer.add(op("patient", "p1", hourOld)), true);
  assertEquals(await buffer.add(op("patient", "p2", hourOld)), true);
  assertEquals(await buffer.add(op("patient", "p3", Date.now())), false);
  assertEquals(
    dropped,
    ["patient:p3:prune-failed"],
    "an hour is well inside a day of retention: the queued mutations stay " +
      "and the INCOMING op is refused loudly instead",
  );

  // A cell that asks for nothing keeps the 1s default and evicts.
  assertEquals(await buffer.add(op("chatty", "c1", hourOld)), true);
  assertEquals(await buffer.add(op("chatty", "c2", hourOld)), true);
  assertEquals(await buffer.add(op("chatty", "c3", Date.now())), true);
  assertEquals(
    dropped.filter((d) => d.startsWith("chatty")).sort(),
    ["chatty:c1:stale-evicted", "chatty:c2:stale-evicted"],
    "a cell that asked for nothing keeps the shared default",
  );
});
