// A client's PATCH STREAM is what a browser tab actually applies; state is the
// sum. "works in testUI, broken in the window" needs the stream to be
// assertable from a real boot (field report §4.4).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { testMultiClient } from "../src/testing/multi-client-test.ts";

type S = { count: number; secret: string; pad: string };

// `pad` keeps the state large enough that a one-field change ships as a
// PATCH: a delta over 50% of the full-state size is sent as full state
// (server-broadcast.ts), which is itself visible here as a root `replace`.
const counter = cell("mcp-counter", {
  state: { count: 0, secret: "s3", pad: "x".repeat(4000) } as S,
  visible: { exclude: ["secret"] },
  methods: {
    increment(s: S, by = 1) {
      s.count += by;
    },
    reseal(s: S) {
      s.secret = "s4"; // hidden from every client — no patch must carry it
    },
  },
});

Deno.test("multi-client: received patches are exposed per client", async () => {
  await using m = await testMultiClient({ cells: [counter] }, 2);
  const [a, b] = m.clients as [typeof m.clients[0], typeof m.clients[0]];
  assert(
    a.patches.some((p) => p.op === "replace" && p.path.length === 0),
    "the initial full state is recorded as a root replace",
  );
  const seenOnB: unknown[] = [];
  const off = b.onPatch((batch) => seenOnB.push(...batch));

  await a.dispatch({ type: "mcp-counter:increment", payload: { args: [2] } });
  const p = await b.waitForPatch((p) =>
    p.path.join(".") === "mcp-counter.count"
  );
  assertEquals(p.value, 2, "the OTHER client received the count patch");
  assert(seenOnB.length > 0, "onPatch observed it");
  off();
  assertEquals(
    b.patches.filter((p) => p.path.join(".") === "mcp-counter.count").length,
    1,
    "exactly one count patch — no full-state resend for a one-field change",
  );
});

Deno.test("multi-client: a hidden field never appears in any patch", async () => {
  await using m = await testMultiClient({ cells: [counter] }, 2);
  await m.clients[0]!.dispatch({ type: "mcp-counter:reseal" });
  // A visible change AFTER the hidden one, so "the reseal patch never came"
  // is proven by ordering, not by a timeout.
  await m.clients[0]!.dispatch({
    type: "mcp-counter:increment",
    payload: { args: [1] },
  });
  for (const c of m.clients) {
    await c.waitForPatch((p) => p.path.join(".") === "mcp-counter.count");
  }
  for (const c of m.clients) {
    assert(
      !c.patches.some((p) => JSON.stringify(p).includes("s4")),
      `client ${c.index} must not see the hidden value`,
    );
  }
  await assertRejects(
    () =>
      m.clients[1]!.waitForPatch((p) => p.path.includes("secret"), {
        timeoutMs: 150,
      }),
    Error,
    "no matching patch",
  );
});

Deno.test("multi-client: the WebSocket wrapper is restored on close", async () => {
  const before = globalThis.WebSocket;
  {
    await using m = await testMultiClient({ cells: [counter] }, 1);
    assert(globalThis.WebSocket !== before, "wrapped while the harness is up");
    await m.clients[0]!.dispatch({
      type: "mcp-counter:increment",
      payload: { args: [1] },
    });
    await m.clients[0]!.waitForPatch((p) => p.path.includes("count"));
  }
  assertEquals(globalThis.WebSocket, before, "and handed back afterwards");
});
