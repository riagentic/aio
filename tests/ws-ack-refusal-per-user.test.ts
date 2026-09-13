import { assertEquals, assertMatch } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
const V = cell("ackv", {
  state: { n: 0 },
  access: true,
  visible: "all",
  methods: {
    wipe(s: { n: number }) {
      s.n++;
    },
  },
});
Deno.test("per-user auth: unknown cell / method acks an error; a real call acks ok", async () => {
  await using srv = await testServer({
    cells: [V],
    users: { "tok-a": { id: "a", role: "user" } },
  });
  // deno-lint-ignore no-explicit-any
  const ws = new (WebSocket as any)(`ws://127.0.0.1:${srv.port}/ws`, {
    headers: { authorization: "Bearer tok-a" },
  }) as WebSocket;
  const acks = new Map<string, { ok: boolean; error?: string }>();
  let wake = () => {};
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data));
    if (f.t === "ack") {
      acks.set(f.d.cid, f.d);
      wake();
    }
  };
  await new Promise((r) => ws.onopen = r);
  const closed = new Promise((r) => ws.onclose = r);
  const call = async (type: string) => {
    const cid = crypto.randomUUID();
    ws.send(
      JSON.stringify({
        v: 2,
        t: "action",
        d: { type, payload: { args: [] }, cid },
      }),
    );
    while (!acks.has(cid)) await new Promise<void>((r) => wake = r);
    return acks.get(cid)!;
  };
  try {
    assertEquals((await call("ackv:wipe")).ok, true);
    const m = await call("ackv:nope");
    assertEquals(m.ok, false);
    assertMatch(m.error!, /no method by that name/);
    const c = await call("Nope:wipe");
    assertEquals(c.ok, false);
    assertMatch(c.error!, /unregistered cell 'Nope'/);
  } finally {
    ws.close();
    await closed;
  }
});
