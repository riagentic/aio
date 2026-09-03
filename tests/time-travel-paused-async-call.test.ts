// The door's refusal must reach an ASYNC caller as fast as it reaches a sync
// one. `dispatch()` rejects a paused / closed / overflowed action at the door
// — but an async method's promise is the REGISTERED CALL, settled by the
// executor that runs the method, and a refused method never runs. Every entry
// point (bound `cell.method()`, the network dispatch behind WS acks / trojan /
// CLI) swallowed the door's rejection and returned the registration, so
// pressing undo in the debug panel made every async call hang for the 30s
// ceiling and then blame a method that had never started.
//
// Proven over a real server: pause via the same `tt-cmd` frame the debug panel
// sends, then the table of refusal kinds × sync/async × entry point, each
// asserting the caller settles within 100ms with the door's own reason — and
// never with "may still be running", which is only true of a method that ran.
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";

type S = { n: number };
const jobs = cell("jobs", {
  state: { n: 0 },
  methods: {
    bump(s: S) {
      s.n += 1;
    },
    async run(s: S) {
      s.n += 1;
      await new Promise((r) => setTimeout(r, 5));
      return "done";
    },
  },
});
const J = jobs as unknown as {
  bump: () => Promise<unknown>;
  run: () => Promise<unknown>;
};

const FAST = 100;
async function settlesFast(
  p: Promise<unknown>,
  label: string,
): Promise<string> {
  const t0 = performance.now();
  const err = await assertRejects(() => p).catch((e) => {
    throw new Error(`${label}: ${e.message}`);
  });
  const took = performance.now() - t0;
  assert(
    took < FAST,
    `${label}: settled in ${took.toFixed(0)}ms — the refusal must reach the ` +
      `caller now, not at the call ceiling`,
  );
  const msg = String((err as Error).message ?? err);
  assert(
    !/may still be running/.test(msg),
    `${label}: "may still be running" is only true of a method that RAN: ${msg}`,
  );
  return msg;
}

/** Open a WS and resolve once the first state frame arrives. */
function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("ws timeout"));
    }, 3000);
    ws.onmessage = () => {
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
}

/** Send an action with a cid exactly as the browser binding does — an async
 *  method also carries `_callId` — and return the ack as a settled promise. */
function wsCall(
  ws: WebSocket,
  type: string,
  opts: { async: boolean },
): Promise<unknown> {
  const cid = `c-${crypto.randomUUID().slice(0, 8)}`;
  const payload = opts.async ? { args: [], _callId: cid } : { args: [] };
  return new Promise((resolve, reject) => {
    const prev = ws.onmessage;
    ws.onmessage = (ev) => {
      const f = dec(String(ev.data));
      if (f?.t !== "ack") return;
      const d = f.d as { cid: string; ok?: boolean; error?: string };
      if (d.cid !== cid) return;
      ws.onmessage = prev;
      d.ok ? resolve(undefined) : reject(new Error(d.error));
    };
    ws.send(enc("action", { type, payload, cid }));
  });
}

/** Send the debug panel's own frame and wait for the tt-state that reports
 *  the change took effect. */
function panel(ws: WebSocket, cmd: "pause" | "resume"): Promise<void> {
  return new Promise((resolve) => {
    const prev = ws.onmessage;
    ws.onmessage = (ev) => {
      const f = dec(String(ev.data));
      if (
        f?.t === "tt-state" &&
        (f.d as { paused?: boolean }).paused === (cmd === "pause")
      ) {
        ws.onmessage = prev;
        resolve();
      }
    };
    ws.send(enc("tt-cmd", { cmd }));
  });
}

Deno.test("paused time travel: every entry point × sync/async settles at once with the door's reason", async () => {
  const port = freePort();
  const app = await aio.run({
    cells: [jobs],
    appId: "test-tt-paused-call",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  const ws = await connect(port);
  try {
    // Sanity: unpaused, both shapes work and the async value comes through.
    await J.bump();
    assert((await J.run()) === "done", "async value transported");
    await wsCall(ws, "jobs:bump", { async: false });
    await wsCall(ws, "jobs:run", { async: true });

    await panel(ws, "pause");

    const table: [string, () => Promise<unknown>][] = [
      ["bound sync  cell.bump()", () => J.bump()],
      ["bound async cell.run()", () => J.run()],
      [
        "WS ack sync  jobs:bump",
        () => wsCall(ws, "jobs:bump", { async: false }),
      ],
      ["WS ack async jobs:run", () => wsCall(ws, "jobs:run", { async: true })],
    ];
    for (const [label, call] of table) {
      const msg = await settlesFast(call(), label);
      assertStringIncludes(msg, "paused", label);
    }
    await panel(ws, "resume");
    await J.bump();
    assert((await J.run()) === "done", "resume restores both shapes");
  } finally {
    ws.close();
    await app.close();
  }

  // CLOSED: the door refuses after close() — same contract, both shapes.
  const msgSync = await settlesFast(J.bump(), "closed: bound sync");
  assertStringIncludes(msgSync, "close()");
  const msgAsync = await settlesFast(J.run(), "closed: bound async");
  assertStringIncludes(msgAsync, "close()");
});

Deno.test("WS: an unknown method, unknown cell, or framework-internal type is answered at once — never a silent wait", async () => {
  const port = freePort();
  const app = await aio.run({
    cells: [jobs],
    appId: "test-ws-refusals",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  const ws = await connect(port);
  try {
    // [label, type, what the ASYNC shape's rejection must name]. The sync shape
    // of an unknown method/cell is a warned no-op that acks ok (pre-existing,
    // out of scope here); the async shape carries a `_callId` and must REJECT,
    // because a caller awaiting a return value never gets one.
    const rows = [
      // The rejection quotes the REFUSING BRANCH's own words: one catch-all
      // sentence ("blocked — machine guard, cell disabled, or not found")
      // used to answer every one of these, and was wrong about a sync method,
      // which had actually run.
      ["unknown method", "jobs:nope", /has no method by that name/],
      ["unknown cell", "nobody:run", /unregistered cell 'nobody'/],
      ["framework-internal", "jobs:__exec", /framework-internal/],
    ] as const;
    for (const [label, type, expect] of rows) {
      for (const isAsync of [false, true]) {
        const tag = `${label} (${isAsync ? "async" : "sync"} shape)`;
        const t0 = performance.now();
        const outcome = await Promise.race([
          wsCall(ws, type, { async: isAsync }).then(() => "ok", (e) => e),
          new Promise<Error>((r) =>
            setTimeout(() => r(new Error("NO ACK within 300ms")), 300)
          ),
        ]);
        const took = performance.now() - t0;
        const msg = outcome === "ok"
          ? "ok"
          : String((outcome as Error).message);
        assert(!/NO ACK/.test(msg), `${tag}: the client was left waiting`);
        assert(took < FAST, `${tag}: answered in ${took.toFixed(0)}ms`);
        assert(
          !/may still be running/.test(msg),
          `${tag}: nothing ran, so nothing "may still be running": ${msg}`,
        );
        if (isAsync) {
          assert(outcome !== "ok", `${tag}: a call with no value must reject`);
          assert(expect.test(msg), `${tag}: names the cause, got: ${msg}`);
        }
      }
    }
  } finally {
    ws.close();
    await app.close();
  }
});
