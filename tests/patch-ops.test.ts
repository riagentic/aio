// The `append` patch op, on the APPLYING side. One function applies every
// `patches` frame — the browser (state-message.ts), the CLI/UDS client
// (cli-client.ts) and the worker-cell host — so these pin that function, then
// drive the real browser applier (`handleMessage`) with an `append` frame.
import { assertEquals, assertThrows } from "@std/assert";
import { enablePatches } from "immer";
import {
  applyWirePatches,
  expandAppends,
  type WirePatch,
} from "../src/protocol/patch-ops.ts";
import { _getState, _reset, handleMessage } from "../src/state-core.ts";
import { _cellSignals } from "../src/state/state-signals.ts";
import { _resetInitialStateFlag } from "../src/state/state-message.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { cell } from "../src/state/cell.ts";
import { testServer } from "../src/testing/server-test.ts";

enablePatches();

Deno.test("applyWirePatches: append extends the string at the path", () => {
  const base = { chat: { reply: "Hello", n: 1 } };
  const ops: WirePatch[] = [
    { op: "append", path: ["chat", "reply"], value: ", world" },
    { op: "replace", path: ["chat", "n"], value: 2 },
  ];
  const next = applyWirePatches(base, ops);
  assertEquals(next, { chat: { reply: "Hello, world", n: 2 } });
  assertEquals(base.chat.reply, "Hello", "the base is not mutated");
  // Two appends in one frame (two coalesced dispatches) extend in order.
  assertEquals(
    applyWirePatches(base, [
      { op: "append", path: ["chat", "reply"], value: "1" },
      { op: "append", path: ["chat", "reply"], value: "2" },
    ]).chat.reply,
    "Hello12",
  );
});

Deno.test("applyWirePatches: an append resolves against the state AS THE OPS APPLY", () => {
  // A coalesced frame: one dispatch removed rows[0], the next appended to the
  // (new) rows[0].text. Read against the ORIGINAL base, the append would
  // extend the deleted row's text — plausible, and silently wrong.
  const base = { c: { rows: [{ text: "gone" }, { text: "kept" }] } };
  const ops: WirePatch[] = [
    { op: "remove", path: ["c", "rows", 0] },
    { op: "append", path: ["c", "rows", 0, "text"], value: "!" },
  ];
  assertEquals(applyWirePatches(base, ops), {
    c: { rows: [{ text: "kept!" }] },
  });
  assertEquals(expandAppends(base, ops), [
    { op: "remove", path: ["c", "rows", 0] },
    { op: "replace", path: ["c", "rows", 0, "text"], value: "kept!" },
  ]);
  // A replace earlier in the frame is what the append extends.
  assertEquals(
    applyWirePatches({ c: { s: "old" } }, [
      { op: "replace", path: ["c", "s"], value: "new" },
      { op: "append", path: ["c", "s"], value: "+" },
    ]),
    { c: { s: "new+" } },
  );
});

Deno.test("applyWirePatches: an append onto a non-string is a loud desync, never a coercion", () => {
  for (
    const base of [{ c: { s: 5 } }, { c: {} }, { c: { s: null } }, {
      c: { s: ["a"] },
    }]
  ) {
    assertThrows(
      () =>
        applyWirePatches(base, [{
          op: "append",
          path: ["c", "s"],
          value: "x",
        }]),
      Error,
      "Cannot apply append at /c/s",
    );
  }
  // Immer-only lists pass through untouched (same array identity — no work).
  const plain: WirePatch[] = [{ op: "replace", path: ["c"], value: 1 }];
  assertEquals(expandAppends({ c: 0 }, plain) === plain, true);
});

Deno.test("browser applier: handleMessage applies an append frame to the client state", () => {
  _reset();
  _resetInitialStateFlag();
  const long = "L".repeat(300);
  assertEquals(handleMessage({ chat: { reply: long, n: 0 } }), "full");
  assertEquals(
    handleMessage({
      $patches: [{ op: "append", path: ["chat", "reply"], value: " tail" }],
    }),
    "delta",
  );
  const state = _getState() as { chat: { reply: string } };
  assertEquals(state.chat.reply, long + " tail");
  // …and the per-cell signal a component reads moved with it.
  assertEquals(
    (_cellSignals.get("chat")?.peek() as { reply: string }).reply,
    long + " tail",
  );
  _reset();
});

const streamer = cell("po-streamer", {
  state: { reply: "r".repeat(300), n: 0 },
  methods: {
    grow(s, chunk: string) {
      s.reply += chunk;
      s.n += 1;
    },
  },
});

Deno.test("CLI client: connectCli applies an append frame from a real server", async () => {
  await using srv = await testServer({ cells: [streamer] });
  const cli = connectCli<{ "po-streamer": { reply: string; n: number } }>(
    srv.url,
  );
  try {
    await cli.ready;
    await streamer.grow("-one");
    await streamer.grow("-two");
    const deadline = Date.now() + 3000;
    while (cli.state?.["po-streamer"]?.n !== 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(
      cli.state?.["po-streamer"]?.reply,
      "r".repeat(300) + "-one-two",
    );
  } finally {
    cli.close();
  }
});
