// A first connection that never happens must be REPORTABLE, not a hang.
//
// `connectCli` retries forever, which is right for a client that has already
// connected — a UI must out-wait a flaky network. The first attempt is a
// different question: a wrong address, a wrong token and an untrusted
// certificate never become right by retrying, and with `ready` left unsettled
// the caller cannot tell them from a slow server. The console said
// "still retrying" and `await app.ready` never returned — which reads as a
// hang, and cost two 400-second test timeouts to diagnose.
import { assert, assertRejects } from "@std/assert";
import { connectCli, connectCliUDS } from "../src/server/cli-client.ts";
import { testServer } from "../src/cell-test.ts";
import { cell } from "../mod.ts";

Deno.test("connectCli: readyTimeoutMs rejects a first connect that cannot happen", async () => {
  // Port 1 is never an aio server.
  const app = connectCli("ws://127.0.0.1:1/ws", { readyTimeoutMs: 300 });
  try {
    const e = await assertRejects(() => app.ready, Error);
    assert(
      e.message.includes("no connection"),
      `the rejection must say what went wrong: ${e.message}`,
    );
    assert(
      /address|token|certificate/.test(e.message),
      `it must name the three causes that retrying cannot fix: ${e.message}`,
    );
  } finally {
    app.close();
  }
});

Deno.test("connectCliUDS: the same deadline, so the answer is transport-independent", async () => {
  const app = connectCliUDS("/nonexistent/aio-ready-deadline.sock", {
    readyTimeoutMs: 300,
  });
  try {
    await assertRejects(() => app.ready, Error, "no connection");
  } finally {
    app.close();
  }
});

Deno.test("connectCli: a deadline does NOT reject a connection that succeeds", async () => {
  // The failure mode to avoid is the opposite one: a slow-but-fine connect
  // rejecting after it already delivered state.
  const counter = cell("rdl-counter", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  await using srv = await testServer({ cells: [counter] });
  const app = connectCli(`${srv.url}/ws`, { readyTimeoutMs: 10_000 });
  try {
    await app.ready;
    // And the deadline must not fire later either — wait past a short window
    // with the connection open and confirm nothing rejected.
    await new Promise((r) => setTimeout(r, 50));
    assert(app.connected, "the client stays connected after ready");
  } finally {
    app.close();
  }
});

Deno.test("connectCli: without the option, the default is unchanged (no rejection)", async () => {
  // A UI client must keep retrying silently — opting in is the whole design.
  const app = connectCli("ws://127.0.0.1:1/ws");
  try {
    const settled = await Promise.race([
      app.ready.then(() => "resolved").catch(() => "rejected"),
      new Promise((r) => setTimeout(() => r("still-pending"), 400)),
    ]);
    assert(
      settled === "still-pending",
      `the default must keep retrying, got: ${settled}`,
    );
  } finally {
    app.close();
  }
});
