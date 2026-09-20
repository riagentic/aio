// A frame larger than the PEER's runtime can receive is refused, loudly —
// never written and hoped for.
//
// Deno's WebSocket (server and client) fails the connection on a message over
// 64 MiB: `WS_RUNTIME_MAX_MESSAGE`, measured and already documented on the
// inbound side. The OUTBOUND side had no such rule, so an app whose state grew
// past 64 MiB pushed a full state to a Deno peer (`connectCli`, `am`, a
// service-to-service link), the runtime killed the socket with "Frame too
// large", the client reconnected, and the server sent it again: a reconnect
// loop moving 65 MB a second with `onerror` swallowing the only clue. The
// persist guard's 16 MiB hard limit never stopped it — it refuses nothing by
// design ("data loss is worse than any warning") and speaks about disk, not
// the wire.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import {
  peerFrameCeiling,
  WS_RUNTIME_MAX_MESSAGE,
} from "../src/server/server-ws.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { freePort } from "../src/testing/server-test.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Just over the ceiling once wrapped in an envelope. */
const HUGE = "h".repeat(WS_RUNTIME_MAX_MESSAGE + 1024);

async function distDir(prefix: string) {
  const dir = await tempDir(prefix);
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  return dir;
}

Deno.test("ws: a state frame a Deno peer cannot receive is refused, not written", async () => {
  const dir = await distDir("ws-ceiling-server-");
  const state = { big: { blob: HUGE } };
  const port = freePort();
  const errors: string[] = [];
  const prevLogger = getLogger();
  setLogger({
    // deno-lint-ignore no-explicit-any
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "error") errors.push(msg);
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const server = createServer({
    port,
    title: "FrameCeiling",
    getUIState: () => state,
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    syncIntervalMs: 10,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const diags: Array<Record<string, unknown>> = [];
  let socketError = "";
  let closed: { code: number } | undefined;
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data));
    if (f.t === "diag") diags.push(f.d);
  };
  ws.onerror = (e) => (socketError = (e as ErrorEvent).message ?? "error");
  ws.onclose = (e) => (closed = { code: e.code });
  try {
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    await sleep(400);
    assertEquals(
      socketError,
      "",
      `the runtime killed the connection instead: ${socketError}`,
    );
    assertEquals(closed, undefined, "the socket must stay open");
    const refusal = diags.find((d) =>
      String(d.type ?? "").includes("frame") ||
      String(d.message ?? "").includes("64")
    );
    assert(
      refusal,
      `the peer must be TOLD why it has no state: ${JSON.stringify(diags)}`,
    );
    assertEquals(refusal.severity, "error");
    assert(
      errors.some((e) =>
        e.includes("64") || e.toLowerCase().includes("ceiling")
      ),
      `and the server must say it too: ${errors.join(" | ")}`,
    );
  } finally {
    setLogger(prevLogger);
    try {
      ws.close();
    } catch { /* already gone */ }
    await server.shutdown();
    await sleep(50);
    await dropTempDir(dir);
  }
});

Deno.test("cli client: a frame the runtime refuses is loud, and does not spin a 1 s reconnect loop", async () => {
  // An OLD server (or any peer that does not know this rule) writing an
  // oversized frame: the client's own `onerror` used to be `() => {}`.
  let connects = 0;
  const t00 = Date.now();
  const times: number[] = [];
  const port = freePort();
  const listener = Deno.serve({ port, onListen() {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      connects++;
      times.push(Date.now() - t00);
      try {
        // The hello FIRST, exactly as a real server speaks: a small frame
        // landing before the fatal one must not put the retry clock back to
        // its 1 s floor.
        socket.send(
          JSON.stringify({ v: 2, t: "proto", d: { v: 2, ver: "test" } }),
        );
        socket.send(
          JSON.stringify({ v: 2, t: "state", d: { big: { blob: HUGE } } }),
        );
      } catch { /* the peer is already gone */ }
    };
    socket.onerror = () => {};
    return response;
  });
  const errors: string[] = [];
  const prevLogger = getLogger();
  setLogger({
    // deno-lint-ignore no-explicit-any
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "error") errors.push(msg);
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const app = connectCli(`ws://127.0.0.1:${port}`);
  try {
    await sleep(8_000);
    const loud = errors.filter((e) =>
      e.toLowerCase().includes("too large") || e.includes("64")
    );
    assert(
      loud.length > 0,
      `the client must SAY the frame was refused: ${errors.join(" | ")}`,
    );
    assertStringIncludes(loud[0]!, "64");
    // 1 s, then 2 s, then 4 s… — a handful of attempts in this window, at
    // GROWING intervals. The streak has to survive the small hello that lands
    // before the fatal frame, or the clock goes back to its 1 s floor on every
    // attempt — each one dragging 65 MB across the socket for nothing.
    assert(
      connects <= 4,
      `a refused frame cannot be retried at full speed: ${connects} ` +
        `connections in 8 s (${times.join(", ")})`,
    );
    // A REAL WAIT FOR THE THIRD OPEN, not a hope that three fit in 8 s. Every
    // attempt also has to drag 65 MB across the socket before it dies, and
    // under the parallel suite's load that took long enough that only two
    // ever landed — the growth check below then failed on a client that was
    // backing off perfectly.
    const deadline = Date.now() + 30_000;
    while (times.length < 3 && Date.now() < deadline) await sleep(100);
    assert(
      times.length >= 3,
      `three attempts are needed to see the interval grow; saw ${times.length} ` +
        `in ${Math.round((Date.now() - t00) / 1000)}s (${times.join(", ")})`,
    );
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    // Each gap is `backoff + however long that attempt took to die`, and that
    // second term is the machine's load, not the client's clock. Comparing
    // gaps by RATIO therefore measured the load: `2395, 3332` (real, from a
    // failing shard) is a perfect doubling with ~1.4 s of 65 MB transfer in
    // both, and it missed a 1.4× bar. The DIFFERENCE cancels that term —
    // doubling adds a second, then two; a clock reset to the 1 s floor adds
    // nothing at all.
    assert(
      gaps[gaps.length - 1]! - gaps[0]! > 600,
      `the retry interval must GROW while every attempt dies the same way: ${
        gaps.join(", ")
      }`,
    );
  } finally {
    setLogger(prevLogger);
    app.close();
    await listener.shutdown();
    await sleep(50);
  }
});

Deno.test("ws: only a peer whose ceiling is KNOWN is limited", () => {
  assertEquals(peerFrameCeiling("Deno/2.9.7"), WS_RUNTIME_MAX_MESSAGE);
  assertEquals(peerFrameCeiling(" deno/3.0.0 "), WS_RUNTIME_MAX_MESSAGE);
  // A browser takes far larger frames — refusing one it would have accepted
  // is a regression, not a guardrail.
  for (
    const ua of [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141 Safari/537.36",
      "Mozilla/5.0 (Macintosh) … Electron/33.0.0 Safari/537.36",
      "",
      "curl/8.5.0",
      "MyApp (Deno/2.9.7 inside)",
    ]
  ) {
    assertEquals(peerFrameCeiling(ua), undefined, ua);
  }
});
