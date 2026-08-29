// A LIMIT ENFORCED BY SILENCE IS INDISTINGUISHABLE FROM A BUG IN THE APP.
//
// Four WS enforcement paths dropped a frame, logged it on the SERVER, and
// returned. Client sends are fire-and-forget, so a dropped frame is a message
// that vanishes on both ends — the app sees a send that "worked" and a reply
// that never comes.
//
// A field report raised `wsLimits` on both hops because a real photo is
// base64'd and JSON-wrapped before it reaches the relay (~1.35x), so even a
// ~0.75 MB image trips the 1 MB frame default. The defaults are defensible.
// Finding out by inference is not.
//
// The refusal travels as `diag` — an existing S→C kind every v3 client already
// routes to one sink — so this adds no protocol vocabulary and no version bump.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dec } from "../src/protocol/envelope.ts";

const probe = cell("ws-limits-probe", {
  state: { n: 0 },
  methods: {
    bump(s) {
      s.n++;
    },
  },
});

/** Open a socket and collect every frame for `ms`. */
function collect(
  url: string,
  send: (ws: WebSocket) => void,
  ms = 400,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const seen: string[] = [];
    const ws = new WebSocket(url);
    const done = () => {
      try {
        ws.close();
      } catch { /* already closed */ }
      resolve(seen);
    };
    ws.onmessage = (e) => void seen.push(String(e.data));
    ws.onerror = () => reject(new Error("socket error"));
    ws.onopen = () => {
      send(ws);
      setTimeout(done, ms);
    };
  });
}

/** The `diag` frames in a batch, decoded. */
function diags(frames: string[]): Record<string, unknown>[] {
  return frames
    .map((f) => dec(f))
    .filter((f): f is NonNullable<typeof f> => !!f && f.t === "diag")
    .map((f) => f.d as Record<string, unknown>);
}

Deno.test("ws: an over-size frame is refused where the SENDER can read it", async () => {
  await using server = await testServer({
    cells: [probe],
    wsLimits: { maxMessageBytes: 2_000 },
  });
  const frames = await collect(
    server.url.replace("http", "ws") + "/ws",
    (ws) =>
      ws.send(JSON.stringify({
        v: 2,
        t: "action",
        d: { type: "ws-limits-probe:bump", payload: "x".repeat(5_000) },
      })),
  );
  const refusal = diags(frames).find((d) => d.type === "ws-too-large");
  assert(
    refusal,
    `no readable refusal reached the sender — frames: ${
      frames.map((f) => f.slice(0, 60)).join(" | ")
    }`,
  );
  assertEquals(refusal.severity, "error");
  assertStringIncludes(String(refusal.message), "over the 2000-byte limit");
  // …and it names the knob, so the reader can act without reading our source.
  assertStringIncludes(String(refusal.hint), "maxMessageBytes");

  // The state must be untouched: a refused frame is not a half-applied one.
  assertEquals(
    (server.state() as { "ws-limits-probe": { n: number } })["ws-limits-probe"]
      .n,
    0,
  );
});

Deno.test("ws: a within-limits frame draws no refusal at all", async () => {
  // The other half of the contract — the ordinary path stays silent, or the
  // diagnostic becomes noise and gets skimmed past like every other.
  await using server = await testServer({
    cells: [probe],
    wsLimits: { maxMessageBytes: 100_000 },
  });
  const frames = await collect(
    server.url.replace("http", "ws") + "/ws",
    (ws) =>
      ws.send(JSON.stringify({
        v: 2,
        t: "action",
        d: { type: "ws-limits-probe:bump" },
      })),
  );
  assertEquals(
    diags(frames).filter((d) => String(d.type).startsWith("ws-")).length,
    0,
    "a frame inside every budget must produce no refusal",
  );
});
