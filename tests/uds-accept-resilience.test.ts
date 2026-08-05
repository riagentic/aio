// The UDS accept loop is the Electron/CLI transport's only door. Everything it
// does per connection happens INSIDE `for await (const conn of listener)`, so
// anything that throws there does not fail one connection — it ends the loop,
// and the process runs on with a listener that will never accept again.
//
// The state-serialization guard is the case that matters. Building a snapshot
// can throw (a getter in state, a BigInt, a cycle — the field-report class
// where JSON corrupts state on its way out), and the transport used to decide
// how to handle that in THREE places: the broadcast path guarded the read but
// not the `JSON.stringify` that follows it, the `subs`/`resync` path carried
// its own copy of the same filter, and the accept path had no guard at all. So
// one unserializable snapshot killed the Electron transport permanently
// (leaving a single "accept loop error" behind) and, once a client was already
// connected, threw straight out of `broadcastState` into the broadcaster.
// There is now ONE snapshot builder, and it reports instead of throwing.

import { assert, assertEquals } from "@std/assert";
import { createUDSListener } from "../src/server/aio.ts";
import { join } from "@std/path";

const encoder = new TextEncoder();

/** Read whole NDJSON lines from a conn until `pred` is satisfied or time runs out. */
async function readLines(
  conn: Deno.Conn,
  pred: (lines: string[]) => boolean,
  ms = 2000,
): Promise<string[]> {
  const lines: string[] = [];
  const dec = new TextDecoder();
  const reader = conn.readable.getReader();
  let buf = "";
  const deadline = Date.now() + ms;
  try {
    while (!pred(lines) && Date.now() < deadline) {
      const race = await Promise.race([
        reader.read(),
        new Promise<null>((r) =>
          setTimeout(() => r(null), deadline - Date.now())
        ),
      ]);
      if (!race || race.done) break;
      buf += dec.decode(race.value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop()!;
      for (const p of parts) if (p) lines.push(p);
    }
  } catch { /* closed */ }
  try {
    reader.releaseLock();
  } catch { /* errored */ }
  return lines;
}

Deno.test("uds: an unserializable snapshot fails ONE connection, not the listener", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-uds-accept-" });
  const socketPath = join(dir, "s.sock");
  // First connect gets a state that cannot be serialized; later ones are fine.
  let n = 0;
  const uds = createUDSListener(
    socketPath,
    () => (++n === 1 ? { bad: 1n } : { ok: true }), // BigInt → JSON.stringify throws
    () => {},
    () => {},
  );
  try {
    await new Promise((r) => setTimeout(r, 50));

    const first = await Deno.connect({ transport: "unix", path: socketPath });
    await readLines(first, (l) => l.length >= 3, 400);
    try {
      first.close();
    } catch { /* server may have closed it */ }
    await new Promise((r) => setTimeout(r, 100));

    // The app recovered (the offending value is gone). The transport must too.
    const second = await Deno.connect({ transport: "unix", path: socketPath });
    const lines = await readLines(
      second,
      (l) => l.some((x) => x.includes('"t":"state"')),
      2000,
    );
    try {
      second.close();
    } catch { /* already closed */ }

    assert(
      lines.some((l) => l.includes('"t":"state"')),
      `the listener must still serve after a bad snapshot — got ${
        JSON.stringify(lines)
      }`,
    );
  } finally {
    uds.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("uds: a client that dies mid-handshake does not take the listener with it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-uds-accept-" });
  const socketPath = join(dir, "s.sock");
  const uds = createUDSListener(
    socketPath,
    () => ({ ok: true }),
    () => {},
    () => {},
  );
  try {
    await new Promise((r) => setTimeout(r, 50));
    // Connect and vanish before reading a single byte of the handshake.
    for (let i = 0; i < 5; i++) {
      const c = await Deno.connect({ transport: "unix", path: socketPath });
      c.close();
    }
    await new Promise((r) => setTimeout(r, 150));

    const good = await Deno.connect({ transport: "unix", path: socketPath });
    const lines = await readLines(
      good,
      (l) => l.some((x) => x.includes('"t":"state"')),
      2000,
    );
    try {
      good.close();
    } catch { /* already closed */ }
    assert(
      lines.some((l) => l.includes('"t":"state"')),
      `listener must survive aborted handshakes — got ${JSON.stringify(lines)}`,
    );
  } finally {
    uds.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("uds: the accept-time snapshot is filtered by the SAME rule as every later one", async () => {
  // The initial state frame is produced by its own inline `JSON.stringify(
  // getUIState())`, while every later frame goes through the subscription
  // filter. One decider or the two drift.
  const dir = await Deno.makeTempDir({ prefix: "aio-uds-accept-" });
  const socketPath = join(dir, "s.sock");
  const state = { a: { n: 1 }, b: { n: 2 } };
  const uds = createUDSListener(socketPath, () => state, () => {}, () => {});
  try {
    await new Promise((r) => setTimeout(r, 50));
    const conn = await Deno.connect({ transport: "unix", path: socketPath });
    const first = await readLines(
      conn,
      (l) => l.some((x) => x.includes('"t":"state"')),
      2000,
    );
    const initial = first.find((l) => l.includes('"t":"state"'))!;
    assertEquals(
      JSON.parse(initial).d,
      state,
      "an unsubscribed client gets the whole snapshot",
    );

    // Subscribe to one feature; the reply must be the filtered snapshot.
    const w = conn.writable.getWriter();
    await w.write(
      encoder.encode('{"v":2,"t":"subs","d":{"subs":["a"]}}\n'),
    );
    w.releaseLock();
    const after = await readLines(
      conn,
      (l) => l.some((x) => x.includes('"t":"state"')),
      2000,
    );
    const filtered = after.find((l) => l.includes('"t":"state"'))!;
    assertEquals(JSON.parse(filtered).d, { a: { n: 1 } });
    try {
      conn.close();
    } catch { /* already closed */ }
  } finally {
    uds.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("uds: an unchanged state is not re-sent after the accept-time snapshot", async () => {
  // The dedup cache (`lastFullJson`) is what makes "send only what changed"
  // true. The accept path serialized its own snapshot and never recorded it,
  // so the client's very first broadcast was always a byte-identical duplicate
  // of the state it had just been handed.
  const dir = await Deno.makeTempDir({ prefix: "aio-uds-accept-" });
  const socketPath = join(dir, "s.sock");
  const state = { a: { n: 1 } };
  const uds = createUDSListener(socketPath, () => state, () => {}, () => {});
  try {
    await new Promise((r) => setTimeout(r, 50));
    const conn = await Deno.connect({ transport: "unix", path: socketPath });
    await readLines(
      conn,
      (l) => l.some((x) => x.includes('"t":"state"')),
      2000,
    );
    await new Promise((r) => setTimeout(r, 50));

    uds.broadcastState(); // nothing changed
    const more = await readLines(conn, () => false, 300);
    try {
      conn.close();
    } catch { /* already closed */ }
    assertEquals(
      more.filter((l) => l.includes('"t":"state"')).length,
      0,
      `an unchanged state must not be broadcast again — got ${
        JSON.stringify(more)
      }`,
    );
  } finally {
    uds.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("uds: an unserializable state does not throw out of broadcastState", async () => {
  // The guard used to wrap `getUIState()` but not the `JSON.stringify` that
  // follows it — and stringify is where an unserializable value actually
  // throws. The exception escaped into whoever drove the broadcast.
  const dir = await Deno.makeTempDir({ prefix: "aio-uds-accept-" });
  const socketPath = join(dir, "s.sock");
  // Serializable while the client connects; a BigInt lands in state later —
  // the way an app actually gets here.
  let poisoned = false;
  const uds = createUDSListener(
    socketPath,
    () => (poisoned ? { bad: 1n } : { ok: true }),
    () => {},
    () => {},
  );
  try {
    await new Promise((r) => setTimeout(r, 50));
    const conn = await Deno.connect({ transport: "unix", path: socketPath });
    await readLines(
      conn,
      (l) => l.some((x) => x.includes('"t":"state"')),
      2000,
    );
    poisoned = true;
    uds.broadcastState(); // must report, never throw
    uds.broadcastState(true);
    uds.broadcastState([{ cell: "a", ops: [] }]);
    try {
      conn.close();
    } catch { /* already closed */ }
  } finally {
    uds.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
