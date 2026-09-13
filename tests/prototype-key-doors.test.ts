// A client names the cell. `Object.prototype` answers for names nobody booted.
//
// `action.type` is `"<cell>:<method>"`, and the cell half is whatever the
// client typed. Server code looked it up in a plain object with a bare index,
// so `constructor`, `toString`, `valueOf`, `hasOwnProperty` and friends
// resolved up the PROTOTYPE CHAIN to a `Function` — which is not nullish, so
// `?? []` did not fire — and the next `.includes(…)` threw a TypeError.
//
// What that cost, measured:
//   • the throw escaped before any ack was written, so the caller's
//     `await cell.method()` hung to its ceiling rather than being told no;
//   • it was swallowed into `degraded("ws:message")`, which escalates after
//     five — so SIX unauthenticated frames permanently marked
//     `/__aio/health` as degraded, and a default app is public (`--expose`
//     included). That endpoint is what a readiness probe, a load balancer,
//     `am` and amui all read;
//   • on the trojan route the same throw was caught by the route's outer
//     handler, which answered `400 invalid JSON` for a body that was valid
//     JSON — failing loud about the wrong thing.
//
// `cell()` has always refused `__proto__`/`constructor`/`prototype` as cell
// NAMES. This file is the other half of that guard: every network door must
// refuse an unbooted name the same way, whatever `Object.prototype` says
// about it. It is written as a sweep over the whole chain rather than over
// the three names that bit, because the defect is the LOOKUP, not the word.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Every own name of Object.prototype, plus the two Function ones a
 *  `<name>:<method>` lookup can also land on. */
const CHAIN_KEYS = [
  ...Object.getOwnPropertyNames(Object.prototype),
  "length",
  "name",
];

const box = cell("protobox", {
  state: { n: 0 },
  methods: {
    inc(s: Any) {
      s.n++;
    },
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("every prototype-chain cell name is refused, with an ack, on the socket", async () => {
  await using srv = await testServer({ cells: [box] });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const acks = new Map<string, { ok?: boolean; error?: string }>();
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data));
    if (f.t === "ack" && f.d?.cid) acks.set(f.d.cid, f.d);
  };
  await new Promise<void>((r) => {
    ws.onopen = () => r();
  });
  await sleep(120);

  for (const key of CHAIN_KEYS) {
    ws.send(JSON.stringify({
      v: 2,
      t: "action",
      d: { type: `${key}:inc`, cid: `cid-${key}` },
    }));
  }
  await sleep(600);

  const missing = CHAIN_KEYS.filter((k) => !acks.has(`cid-${k}`));
  assertEquals(
    missing,
    [],
    "every frame must be ANSWERED — a swallowed throw hangs the caller's await",
  );
  for (const key of CHAIN_KEYS) {
    const ack = acks.get(`cid-${key}`)!;
    assertEquals(ack.ok, false, `"${key}:inc" must be refused, not accepted`);
    assertStringIncludes(
      String(ack.error),
      key,
      "and the refusal must name the cell the client asked for",
    );
  }
  ws.close();
});

Deno.test("…and the health endpoint is untouched by them", async () => {
  await using srv = await testServer({ cells: [box] });
  const health = async () =>
    JSON.parse(await (await srv.fetch("/__aio/health")).text());
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  await new Promise<void>((r) => {
    ws.onopen = () => r();
  });
  await sleep(120);
  assertEquals((await health()).status, "healthy", "healthy to begin with");

  // Well past the five-failure escalation threshold.
  for (let i = 0; i < 12; i++) {
    ws.send(JSON.stringify({
      v: 2,
      t: "action",
      d: { type: "constructor:inc" },
    }));
    await sleep(15);
  }
  await sleep(400);
  const h = await health();
  assertEquals(
    h.status,
    "healthy",
    `an unauthenticated client must not be able to mark the app degraded: ${
      JSON.stringify(h.degraded)
    }`,
  );
  ws.close();
});

Deno.test("a real handler failure DOES degrade — and recovers when it stops", async () => {
  // The guard above must not have been bought by making the tracker deaf.
  const { _resetDegraded, degraded, degradedReport } = await import(
    "../src/diagnostics/degraded.ts"
  );
  _resetDegraded();
  try {
    for (let i = 0; i < 6; i++) degraded("ws:message").fail(new Error("boom"));
    assert(
      degradedReport().some((d) => d.name === "ws:message"),
      "six consecutive failures still escalate",
    );
    degraded("ws:message").ok();
    assertEquals(
      degradedReport().filter((d) => d.name === "ws:message"),
      [],
      "and ONE success ends the episode — the contract the ws handler now keeps",
    );
  } finally {
    _resetDegraded();
  }
});

Deno.test("the trojan door refuses a prototype-chain cell as 404, not 400", async () => {
  await using srv = await testServer({ cells: [box] });
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const res = await srv.fetch("/__aio/trojan/dispatch", {
      method: "POST",
      headers: { "X-AIO": "1", "content-type": "application/json" },
      body: JSON.stringify({ type: `${key}:inc`, payload: { args: [] } }),
    });
    const body = await res.text();
    assertEquals(
      res.status,
      404,
      `"${key}" is an unknown cell, not a malformed body: ${body}`,
    );
    // The body is JSON, so the quotes around the name are escaped in it.
    assertStringIncludes(body, "unknown cell");
    assertStringIncludes(body, key);
  }
});
