// A frame the server DROPS must settle the call it was carrying.
//
// `refuseAction` in server-ws.ts states the rule: "A refused frame that
// carries a cid is TOLD. The client registered an ack for it, so a silent
// return left `await cell.method()` waiting to its ceiling for a method that
// was never dispatched — then blaming a server that 'never confirmed the
// call'." That was applied to refusals AFTER parsing. The four limit drops
// (global fuse, per-client rate, oversize frame, byte budget) happen BEFORE
// parsing and answered on the `diag` channel alone — which every client routes
// to a log, and which carries no cid, so it can settle nothing.
//
// MEASURED against a live app before the fix: 250 sequential
// `await cell.method()` calls over one socket, 248 applied — and the 2 callers
// whose frames were dropped waited out the full ack ceiling, then were told the
// server "never confirmed the call: it may still be running (its writes can
// commit later)". It was not running and never would.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

Deno.test("ws: a frame dropped by the rate limit rejects its caller, by reason", async () => {
  const c = cell("wsdrop", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-wsdrop-");
  const app = await aio.run({
    cells: [c],
    appId: `wsdrop-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    // a budget small enough that a handful of rapid calls trips it
    wsLimits: { messagesPerSec: 2 },
    // deno-lint-ignore no-explicit-any
  } as any);

  // Driven as a RAW socket: the cell is already bound to this in-process app
  // (D2 — a cell def binds to exactly one), so a second binding is refused.
  // This is also the more exact test: it is the frame path itself.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const acks: { cid: string; ok: boolean; error?: string }[] = [];
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("socket failed to open"));
  });
  ws.onmessage = (e) => {
    try {
      const f = dec(String(e.data)) as { t?: string; d?: unknown } | null;
      if (f?.t !== "ack") return;
      const d = f.d as { cid?: string; ok?: boolean; error?: string };
      if (typeof d?.cid === "string") {
        acks.push({ cid: d.cid, ok: d.ok === true, error: d.error });
      }
    } catch { /* not our frame */ }
  };

  try {
    await opened;
    ws.send(enc("proto", protoHello()));

    // Well past a 2 msg/sec budget, all in one window.
    const cids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const cid = `c${i}`;
      cids.push(cid);
      ws.send(enc("action", { type: "wsdrop:bump", payload: {}, cid }));
    }
    // Every dropped frame must answer NOW, not at some ack ceiling.
    const t0 = Date.now();
    while (acks.length < 12 && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const refused = acks.filter((a) => !a.ok);
    assert(
      refused.length > 0,
      `a 2 msg/sec budget dropped nothing across 12 frames; acks=${acks.length}`,
    );
    for (const r of refused) {
      const m = r.error ?? "";
      assert(
        /over its budget|dropped/.test(m),
        `a dropped frame must be refused by its reason: ${m}`,
      );
    }
    // …and every frame is accounted for: acked ok, or refused. None silent.
    assertEquals(
      acks.length,
      12,
      `${12 - acks.length} frame(s) settled nothing — the caller would wait ` +
        `out its ack ceiling and be told the fate is unknown`,
    );
  } finally {
    try {
      ws.close();
    } catch { /* already closed */ }
    await app.close();
  }
});

// …and the frame most likely to be dropped was the one whose caller was never
// told. `_droppedCid` capped the INPUT at 64 KB before looking for the cid, so
// an oversized frame — dropped precisely for its size — could not have its cid
// read, and that caller alone hung. Found by fuzzing the door: of 27 malformed
// frames, 26 settled and the 1 MB one did not. The cap now bounds the SCAN.
Deno.test("ws: an OVERSIZED frame settles its caller too — the cap is on the scan, not the frame", async () => {
  const c = cell("wsbig", {
    state: { n: 0 },
    methods: {
      add(s: { n: number }, _v: string) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-wsbig-");
  const app = await aio.run({
    cells: [c],
    appId: `wsbig-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    // deno-lint-ignore no-explicit-any
  } as any);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const acks: { cid: string; ok: boolean; error?: string }[] = [];
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("socket failed to open"));
  });
  ws.onmessage = (e) => {
    try {
      const f = dec(String(e.data)) as { t?: string; d?: unknown } | null;
      if (f?.t !== "ack") return;
      const d = f.d as { cid?: string; ok?: boolean; error?: string };
      if (typeof d?.cid === "string") {
        acks.push({ cid: d.cid, ok: d.ok === true, error: d.error });
      }
    } catch { /* not our frame */ }
  };

  try {
    await opened;
    ws.send(enc("proto", protoHello()));
    // Over the 1 MB ceiling, with the cid where a real client puts it.
    ws.send(
      enc("action", {
        type: "wsbig:add",
        payload: "x".repeat(1_100_000),
        cid: "big-1",
      }),
    );
    const t0 = Date.now();
    while (acks.length < 1 && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(
      acks.length,
      1,
      "an oversized frame settled nothing — that caller waits out its ack " +
        "ceiling for a method the server already threw away",
    );
    assertEquals(acks[0]?.ok, false, "and it must be refused, not confirmed");
    assert(
      /too large|dropped/.test(acks[0]?.error ?? ""),
      `refused by its reason: ${acks[0]?.error}`,
    );
  } finally {
    try {
      ws.close();
    } catch { /* already closed */ }
    await app.close();
  }
});
