# Binary side channels

A sustained binary stream — screen frames, audio, telemetry, remote input — does
not belong in cell state. State is persisted, diffed and broadcast to every
client; a 60 fps stream through it would write the disk raw and fan every frame
out to everyone. The state channel carries **control**; a WebSocket you own
carries **payload**.

This page is the shape that keeps working. It is generic — a media app, a
telemetry pipe and a remote-input relay all end up here.

## The split

| Concern                                            | Where it goes              |
| -------------------------------------------------- | -------------------------- |
| Who is connected, session ids, quality, start/stop | cell state (methods)       |
| Frames, chunks, samples                            | your own WS route          |
| "Which socket belongs to which session"            | a map, keyed by session id |

## Upgrading a route

`routes` handlers get the raw `Request`, so `Deno.upgradeWebSocket` works
directly:

```ts
// app.ts
const sockets = new Map<string, WebSocket>(); // sessionId → socket

await aio.run({
  cells: [session],
  routes: {
    "/stream": (req) => {
      const url = new URL(req.url);
      const sid = url.searchParams.get("sid") ?? "";
      // Authorize BEFORE upgrading: a socket that upgrades and is then closed
      // has already cost you a handshake, and the client has to distinguish
      // "rejected" from "dropped".
      if (!session.hasSession(sid)) {
        return new Response("unknown session", { status: 403 });
      }

      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => sockets.set(sid, socket);
      socket.onclose = () => {
        // Only delete OUR socket: a reconnect may already have installed a new
        // one under the same id, and deleting unconditionally unregisters the
        // live connection.
        if (sockets.get(sid) === socket) sockets.delete(sid);
        session.markDisconnected(sid);
      };
      socket.onmessage = (e) =>
        onFrame(sid, new Uint8Array(e.data as ArrayBuffer));
      return response;
    },
  },
});
```

The state channel and this socket are separate connections: assume they can
open, close and fail independently, and let the cell be the one that says
whether a session exists.

## Framing

Length-prefixed frames with a kind byte carry every stream this shape is used
for:

```ts
// [kind:u8][seq:u24][payload…]  — 4-byte header, little-endian seq
const encode = (kind: number, seq: number, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + body.length);
  out[0] = kind;
  out[1] = seq & 0xff;
  out[2] = (seq >> 8) & 0xff;
  out[3] = (seq >> 16) & 0xff;
  out.set(body, 4);
  return out;
};
```

**One sequence counter per kind, never one shared.** A shared counter makes
every interleaved frame of another kind look like a gap, so the receiver reports
packet loss that never happened — and anything reacting to loss (a quality
controller, a retransmit request, a reconnect) then fights a phantom. Keep
`Map<kind, number>` on each side and compare per kind.

Wrap them at a known modulus (`seq = (seq + 1) % 0x1000000` for a u24) and
compare with the same modulus on the receiver, or the first wrap reads as a
catastrophic gap.

## Backpressure: drop or queue, decided per kind

A slow consumer is not a reason to grow memory without bound. `bufferedAmount`
is the only honest signal a WebSocket gives you:

```ts
const HIGH_WATER = 4 * 1024 * 1024; // bytes already queued in the socket

function send(
  sock: WebSocket,
  kind: number,
  body: Uint8Array,
  droppable: boolean,
) {
  if (sock.readyState !== WebSocket.OPEN) return;
  if (sock.bufferedAmount > HIGH_WATER) {
    if (droppable) return; // a stale frame is worth less than the delay it adds
    sock.close(1011, "backpressure"); // it is NOT droppable → the stream is over
    return;
  }
  sock.send(encode(kind, nextSeq(kind), body));
}
```

The rule: **droppable = the next one supersedes it** (video frames, cursor
positions, telemetry samples). Anything the receiver's state depends on — a key
frame, a keystroke, a control message — is not droppable, and if it cannot be
sent the stream must fail loudly rather than silently desynchronize. Prefer
sending control over the cell (dispatch) rather than the binary socket: it is
already ordered, acked and reconnect-safe.

## Gap detection

The receiver checks its own expectation, per kind:

```ts
const expected = new Map<number, number>();
function accept(kind: number, seq: number): "ok" | "gap" | "dup" {
  const want = expected.get(kind);
  expected.set(kind, (seq + 1) % 0x1000000);
  if (want === undefined || seq === want) return "ok";
  return ((seq - want + 0x1000000) % 0x1000000) < 0x800000 ? "gap" : "dup";
}
```

A gap on a droppable kind is information (report it, let the quality controller
react). A gap on a non-droppable kind is a broken stream: tear it down and let
the cell restart the session, so the failure lands where the app can see it.

## Limits

`wsLimits` applies to aio's **own** WS endpoint, not to a socket you upgrade
yourself — your route is your responsibility. Set the equivalents explicitly:

```ts
wsLimits: { maxMessageBytes: 1_000_000, messagesPerSec: 100, bytesPerSec: 5_000_000 }
maxConnections: 100                     // concurrent WS clients, server-wide
```

Those are the **defaults**, and they are chosen for a desktop app talking to
itself. An exposed server usually wants larger ones — a photo is base64'd and
JSON-wrapped before it reaches the socket (~1.35x), so a 0.75 MB image already
trips the 1 MB frame default.

**A refused frame is not silent.** Over-size, over-rate and over-byte-budget
frames are dropped — and the sender is told, as a `diag` frame naming the limit
it hit and the key that raises it. The `maxConnections` ceiling logs once per
process when it is first reached, with the same. A limit enforced by silence is
indistinguishable from a bug in your app.

`maxConnections` counts **every** socket in the process, with no per-peer
accounting: one machine holding the ceiling in idle sockets locks everyone else
out. If your app is reachable by strangers, put a per-peer cap in front of it (a
reverse proxy's `limit_conn`, or your own accounting in a route).

For your own socket, cap the frame size on the RECEIVE side before allocating
anything from a length header, and drop a client that exceeds a rate you choose.
An unbounded `Map` of sockets is the other half: remove on close, and put a
ceiling on how many sessions may exist at once — in the cell, where the number
is visible.

## Broadcasting while a table changes

A broadcast that iterates the socket map while a handler mutates it (a
disconnect during the loop) skips or repeats receivers. Iterate a copy:

```ts
for (const [sid, sock] of [...sockets]) send(sock, KIND_FRAME, body, true);
```

The same applies to any list a cell method broadcasts from after an `await`:
re-read it, or copy it before the first suspension.

## Checklist

- [ ] Control in cells, payload on your socket
- [ ] Authorized before upgrading, session id matched to socket
- [ ] One sequence counter **per kind**, wrapping at a known modulus
- [ ] Every kind classified droppable / not droppable
- [ ] `bufferedAmount` checked before every send
- [ ] Gaps reported per kind; non-droppable gap tears the stream down
- [ ] Receive-side size cap and a ceiling on concurrent sessions
- [ ] Socket map cleaned on close, and only when it is still ours

## See also

- [Example 5: Integrations](../examples/05-integrations.md) — custom routes,
  uploads, external APIs
- [App architectures](../basics/app-architectures.md) — service + rich clients
- [Browser client](browser.md) — how the state channel itself connects
