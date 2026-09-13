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

// ── the cid must be the ENVELOPE's, not one the app happened to write ────────
//
// The cid was recovered by scanning the raw frame text for the first
// `"cid":"…"`. That finds the app's OWN payload field before the envelope's,
// because the envelope appends its cid after `payload` (`{...action, cid}`) —
// and an outbox row's correlation id is exactly the thing an app calls `cid`.
//
// Measured: a `chat:send` carrying `{ cid: "row-7f3a", image: … }` over the
// size limit was refused, the ack came back addressed to `row-7f3a`, and the
// awaiting call was never settled at all. If that string had named a LIVE
// call, an unrelated `await cell.method()` would have been rejected with a
// failure belonging to a different frame.
Deno.test("ws: a refused frame settles ITS caller, not a cid from the payload", async () => {
  const c = cell("wscid", {
    state: { n: 0 },
    methods: {
      send(s: { n: number }, _row: unknown) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-wscid-");
  const app = await aio.run({
    cells: [c],
    appId: `wscid-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    wsLimits: { maxMessageBytes: 4000 },
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
    // The realistic trigger: an outbox row with its own correlation id, plus
    // an attachment that puts the frame over the budget.
    ws.send(enc("action", {
      type: "wscid:send",
      payload: { args: [{ cid: "row-7f3a", image: "x".repeat(5000) }] },
      cid: "call-42",
    }));

    const t0 = Date.now();
    while (acks.length === 0 && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assertEquals(acks.length, 1, "the refusal must be answered exactly once");
    assertEquals(
      acks[0]!.cid,
      "call-42",
      `the ack must address the CALL, not the app's own payload field — ` +
        `\`await cell.send(row)\` is what is waiting`,
    );
    assertEquals(acks[0]!.ok, false);
  } finally {
    try {
      ws.close();
    } catch { /* already closed */ }
    await app.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── a refused serverFn must be answered where its caller is listening ────────
//
// `settleDroppedCall` always emitted an `ack`. A `serverFn` caller waits on
// `sfnr` — a different registry — so the server believed it had answered while
// the promise sat pending to its full 30s ceiling and then reported that the
// function "may still be running". It never ran.
//
// The case is the one the server's own size hint names: "a photo is base64'd
// and JSON-wrapped on the way here".
Deno.test("ws: a refused serverFn frame is answered on sfnr, not ack", async () => {
  const c = cell("wssfn", { state: { n: 0 }, methods: {} });
  const port = freePort();
  const dir = await tempDir("aio-wssfn-");
  const app = await aio.run({
    cells: [c],
    appId: `wssfn-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    wsLimits: { maxMessageBytes: 2000 },
    // deno-lint-ignore no-explicit-any
  } as any);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: { t: string; cid?: string; ok?: boolean }[] = [];
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("socket failed to open"));
  });
  ws.onmessage = (e) => {
    try {
      const f = dec(String(e.data)) as { t?: string; d?: unknown } | null;
      if (f?.t !== "ack" && f?.t !== "sfnr") return;
      const d = f.d as { cid?: string; ok?: boolean };
      frames.push({ t: f.t, cid: d?.cid, ok: d?.ok });
    } catch { /* not our frame */ }
  };

  try {
    await opened;
    ws.send(enc("proto", protoHello()));
    // The exact frame `serverFn("api").upload(big)` puts on the wire.
    ws.send(enc("sfn", {
      ns: "api",
      name: "upload",
      args: ["x".repeat(4000)],
      cid: "sfn-1-fixture",
    }));

    const t0 = Date.now();
    while (frames.length === 0 && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assertEquals(frames.length, 1, "the refusal must be answered once");
    assertEquals(
      frames[0]!.t,
      "sfnr",
      "a serverFn caller listens on `sfnr` — an `ack` settles nothing and " +
        "the promise waits out its full ceiling",
    );
    assertEquals(frames[0]!.cid, "sfn-1-fixture");
    assertEquals(frames[0]!.ok, false);
  } finally {
    try {
      ws.close();
    } catch { /* already closed */ }
    await app.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
