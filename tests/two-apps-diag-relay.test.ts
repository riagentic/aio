// The dev `diag` relay forwards only its OWN app's diagnostics.
//
// The diagnostic bus is one per process, and every server subscribed to it and
// forwarded every event to its sockets. Two apps in one process (library mode,
// `testApps`): app B's reduce error — its thrown message verbatim, whatever
// B's method put in it — arrived in app A's dev overlay and was written to A's
// client logs. Feedback auto-capture already filtered by the event's app scope
// (feedback-boot.ts); the relay did not. An event emitted outside any app has
// no scope and stays everyone's.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { diagEmit } from "../src/diagnostics/diagnostic-bus.ts";

const SECRET = `B-SECRET-${crypto.randomUUID()}`;

const mk = (name: string) =>
  cell(name, {
    state: { n: 0 },
    visible: "all",
    methods: {
      fail(_s: { n: number }, note: string) {
        throw new Error(`rejected: ${note}`);
      },
    },
  });

function openWs(port: number) {
  const frames: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.onmessage = (e) => frames.push(String(e.data));
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws failed to open"));
  });
  const closed = new Promise<void>((res) => (ws.onclose = () => res()));
  return { ws, frames, opened, closed };
}

const until = async (pred: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
};

Deno.test("two apps: app B's diag frame never reaches app A's sockets", async () => {
  await using A = await testServer({ cells: [mk("diaga")] });
  await using B = await testServer({ cells: [mk("diagb")] });
  const a = openWs(A.port);
  const b = openWs(B.port);
  try {
    await Promise.all([a.opened, b.opened]);
    await new Promise((r) => setTimeout(r, 100));
    b.ws.send(JSON.stringify({
      v: 2,
      t: "action",
      d: { type: "diagb:fail", payload: { args: [SECRET] }, cid: "c1" },
    }));
    const isSecretDiag = (f: string) =>
      f.includes('"t":"diag"') && f.includes(SECRET);
    // Positive control: the event was published and B relayed it.
    assert(
      await until(() => b.frames.some(isSecretDiag), 3000),
      `B's own socket gets B's diag: ${b.frames.join("\n").slice(0, 2000)}`,
    );
    // An unscoped event (outside any app) is still everyone's.
    const OPEN = `UNSCOPED-${crypto.randomUUID()}`;
    diagEmit({
      type: `test:unscoped-${OPEN}`,
      severity: "info",
      source: "test",
      message: OPEN,
    });
    assert(
      await until(() => a.frames.some((f) => f.includes(OPEN)), 3000),
      "an event from outside any app reaches every app's sockets",
    );
    assertEquals(
      a.frames.filter(isSecretDiag).length,
      0,
      "A's socket must not receive B's diagnostic",
    );
  } finally {
    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);
  }
});
