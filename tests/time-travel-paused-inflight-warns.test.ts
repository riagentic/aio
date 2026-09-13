// Pausing time travel while an async method is mid-flight is the DEVELOPER's
// act, not an app failure. The paused door refuses the method's later writes
// (semantics unchanged — they are dropped), but that refusal used to surface as
// `ERROR EFFECT_ASYNC_ERROR` with a "catch inside the method" fix that cannot
// help, an error-severity diagnostic, and so an automatic feedback REPORT filed
// against the app for pressing pause in the debug panel.
//
// Now: the refusal is tagged `tt-paused`, said once per method at WARN naming
// the method whose in-flight writes were dropped and what to do (resume, run it
// again), and nothing reaches the bus at error severity — which is the only
// severity feedback auto-capture files.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import {
  type DiagnosticEvent,
  diagSubscribe,
} from "../src/diagnostics/diagnostic-bus.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

type S = { n: number; after: number };
const jobs = cell("jobs", {
  state: { n: 0, after: 0 },
  methods: {
    async run(s: S) {
      s.n += 1;
      await new Promise((r) => setTimeout(r, 150));
      s.after += 1;
      return "done";
    },
  },
});
const J = jobs as unknown as { run: () => Promise<unknown>; n: number };

function panel(ws: WebSocket, cmd: "pause" | "resume"): Promise<void> {
  return new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const f = dec(String(ev.data));
      if (
        f?.t === "tt-state" &&
        (f.d as { paused?: boolean }).paused === (cmd === "pause")
      ) {
        ws.onmessage = null;
        resolve();
      }
    };
    ws.send(enc("tt-cmd", { cmd }));
  });
}

Deno.test("TT pause during an async method: a WARN naming the method, never an error or a report", async () => {
  const port = freePort();
  const dir = await Deno.makeTempDir({ prefix: "aio-tt-inflight-" });
  const app = await aio.run({
    cells: [jobs],
    appId: "test-tt-inflight-warn",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    appDir: dir,
  } as never) as { close(): Promise<void> };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => ws.onmessage = r);
  const lines: { lvl: string; msg: string }[] = [];
  const events: DiagnosticEvent[] = [];
  const unsub = diagSubscribe((e) => events.push(e));
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _c: string, msg: string) => lines.push({ lvl, msg }),
      perf: () => {},
      flush: () => Promise.resolve(),
    } as unknown as LogSink,
  );
  try {
    for (let round = 0; round < 2; round++) {
      const call = J.run();
      await new Promise((r) => setTimeout(r, 40));
      await panel(ws, "pause");
      // The method's writes after the pause are refused — unchanged: the
      // caller learns it, and they are not applied.
      await assertRejects(() => call, Error, "paused");
      await panel(ws, "resume");
    }
    const errors = lines.filter((l) => l.lvl === "error");
    assertEquals(
      errors.map((l) => l.msg),
      [],
      "pausing the debug panel is not an app error",
    );
    const errEvents = events.filter((e) => e.severity === "error");
    assertEquals(
      errEvents.map((e) => e.type),
      [],
      "no error-severity diagnostic — the only kind feedback auto-captures",
    );
    const named = lines.filter((l) =>
      l.lvl === "warn" && l.msg.includes("jobs:run") &&
      /in-flight writes/.test(l.msg)
    );
    assertEquals(
      named.length,
      1,
      `warned ONCE for the method, across two paused runs: ${
        JSON.stringify(lines)
      }`,
    );
    assert(/resume time travel/i.test(named[0]!.msg), named[0]!.msg);
    assert(
      !/catch inside the method/.test(named[0]!.msg),
      "a hint that cannot help while paused is not a hint",
    );
  } finally {
    setLogger(null);
    unsub();
    ws.close();
    await app.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
