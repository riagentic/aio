// `ok: true` from the trojan dispatch must mean the action DID something.
//
// `action-ack.ts` is described as "ONE decider for 'did this action actually
// DO anything?', shared by every transport that acks a client call
// (server-ws.ts, uds.ts)" — and its header names the exact failures it exists
// for: "a cell method that no longer exists, a cell the server never booted, a
// cell disabled by its breaker, a `validate` hook that refused the change — all
// four resolve, so `await todos.rename(id, 'x')` in the browser returned
// `ok: true` while the reduce had logged 'does NOTHING' and changed no state."
//
// The TROJAN route is the third transport that acks a call — it is what
// `am dispatch`, amui and any agent driving the JSON read — and it never asked.
// Measured: a write refused by `validate` answered `{"ok":true,"unsaved":null}`
// with the state unchanged. The rule this route states about ITSELF, ten lines
// above its own time-travel arm, is "ok:true must mean EXECUTED".
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const post = (port: number, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify(body),
  });

Deno.test("trojan dispatch: a validate refusal is not reported as ok", async () => {
  const c = cell("trej", {
    state: { n: 0 },
    methods: {
      setNeg(s: { n: number }) {
        s.n = -1;
      },
      setOk(s: { n: number }) {
        s.n = 5;
      },
    },
    validate: (s: { n: number }) => s.n >= 0 || "n must not be negative",
  });
  const port = freePort();
  const dir = await tempDir("aio-trej-");
  const app = await aio.run({
    cells: [c],
    appId: `trej-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
  } as never);
  try {
    // The ordinary case still answers ok — this is a refusal, not a new gate.
    const good = await post(port, { type: "trej:setOk" });
    const goodBody = await good.json();
    assertEquals(good.status, 200);
    assertEquals(goodBody.ok, true);

    // …and the refused write does NOT.
    const bad = await post(port, { type: "trej:setNeg" });
    const badBody = await bad.json() as { ok?: boolean; error?: string };
    assert(
      badBody.ok !== true,
      `a write the validator refused answered ${JSON.stringify(badBody)}`,
    );
    assert(
      typeof badBody.error === "string" &&
        badBody.error.includes("n must not be negative"),
      `the refusal must carry the validator's own words: ${
        JSON.stringify(badBody)
      }`,
    );

    // The state is the proof that it really did nothing.
    const st = await fetch(`http://127.0.0.1:${port}/__aio/trojan/state`);
    const state = await st.json() as { trej: { n: number } };
    assertEquals(state.trej.n, 5, "the refused write must not have landed");
  } finally {
    await app.close();
  }
});
