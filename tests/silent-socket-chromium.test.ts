// The silent-socket watchdog (browser-vitals.ts) in a REAL desktop browser,
// against a REAL black hole: a TCP relay between the page and the server that
// stops carrying bytes without closing anything — the network gone under an
// open socket, which no close event reports.
//
// Proven before only on an Android WebView and by fake-socket unit tests; the
// 20-beat ceiling (`SILENT_BEATS_DEAD`) only by the unit with fake time. Here:
//   · only the open socket goes silent, HTTP still answers → the page asks at
//     `SILENT_BEATS_ASK` beats, hears HTTP, and reconnects a beat later;
//   · everything goes silent, HTTP hangs too (a busy server looks the same) →
//     nothing is decided early, the page reconnects at the ceiling;
//   · a click made into the black hole lands exactly once when the network
//     comes back — though its first copy was only delayed, not lost.
import { assert, assertEquals } from "@std/assert";
import { boot, BROWSER, freePort, waitFor } from "./e2e-harness.ts";
import { chromiumPage, launchChromium } from "../src/testing/chromium.ts";
import { dropTempDir } from "../src/testing/temp-dir.ts";
import {
  SILENT_BEATS_ASK,
  SILENT_BEATS_DEAD,
} from "../src/browser/browser-vitals.ts";
import { DEFAULT_HEARTBEAT_INTERVAL } from "../src/vitals/types.ts";

const CELLS = `import { cell } from "aio";
export const counter = cell("counter", {
  state: { n: 0 },
  methods: { inc(s) { s.n += 1; } },
});`;

const APP = `import { counter } from "./cells.ts";
export default function App() {
  return (
    <div>
      <span id="n">{String(counter.n)}</span>
      <button id="go" onClick={() => counter.inc()}>go</button>
    </div>
  );
}`;

/** A TCP relay that can stop carrying bytes without closing anything. It
 *  notes when each WebSocket upgrade request reaches it — the page's every
 *  (re)connect, whether or not the relay then carries it. */
function relay(to: number) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: freePort() });
  type Pair = { held: boolean; ws: boolean; conns: Deno.Conn[] };
  const pairs = new Set<Pair>();
  const waiters = new Set<() => void>();
  let holeNew = false;
  const upgrades: number[] = [];
  const wake = () => {
    for (const w of waiters) w();
    waiters.clear();
  };
  const until = (open: () => boolean) =>
    open() ? Promise.resolve() : new Promise<void>((r) => {
      const check = () => open() ? r() : void waiters.add(check);
      waiters.add(check);
    });
  const pump = async (
    pair: Pair,
    from: Deno.Conn,
    into: Deno.Conn,
    first?: (head: string) => void,
  ) => {
    const buf = new Uint8Array(64 * 1024);
    try {
      for (;;) {
        const n = await from.read(buf);
        if (n === null) break;
        first?.(new TextDecoder().decode(buf.subarray(0, n)));
        first = undefined;
        await until(() => !pair.held);
        let off = 0;
        while (off < n) off += await into.write(buf.subarray(off, n));
      }
    } catch { /* aio-ok: the other side went; closed below */ }
    for (const c of pair.conns) {
      try {
        c.close();
      } catch { /* aio-ok: already closed by the other pump */ }
    }
    pairs.delete(pair);
  };
  const accepting = (async () => {
    for await (const client of listener) {
      const pair: Pair = { held: holeNew, ws: false, conns: [client] };
      pairs.add(pair);
      (async () => {
        const server = await Deno.connect({ hostname: "127.0.0.1", port: to });
        pair.conns.push(server);
        await Promise.all([
          pump(pair, client, server, (head) => {
            if (!/^upgrade:\s*websocket/im.test(head)) return;
            pair.ws = true;
            upgrades.push(Date.now());
          }),
          pump(pair, server, client),
        ]);
      })();
    }
  })().catch(() => {}); // aio-ok: ends when the listener closes
  return {
    port: (listener.addr as Deno.NetAddr).port,
    upgrades,
    /** Stop carrying the open WebSocket; `all`: every open connection and
     *  every new one too. */
    hole(all: boolean) {
      for (const p of pairs) if (all || p.ws) p.held = true;
      holeNew = all;
    },
    release() {
      holeNew = false;
      for (const p of pairs) p.held = false;
      wake();
    },
    async close() {
      listener.close();
      this.release();
      for (const p of pairs) {
        for (const c of p.conns) {
          try {
            c.close();
          } catch { /* aio-ok: already closed */ }
        }
      }
      await accepting;
    },
  };
}

Deno.test({
  name:
    "silent socket in a real browser: a black hole is judged — at the HTTP answer, or at the 20-beat ceiling — and a click into it lands once",
  ignore: BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): the relay's pumps end with its sockets in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): a browser and a server child, both stopped in `finally`
  async fn() {
    const server = await boot({ cells: CELLS, app: APP });
    const net = relay(server.port);
    const browser = await launchChromium(BROWSER!, [
      "--remote-debugging-port=0",
      "about:blank",
    ]);
    try {
      const page = await chromiumPage(browser);
      const js = async <T>(expression: string): Promise<T> =>
        ((await page.call("Runtime.evaluate", {
          expression,
          returnByValue: true,
        })) as { result: { value: T } }).result.value;
      await page.call("Page.navigate", {
        url: `http://127.0.0.1:${net.port}/`,
      });
      const n = () =>
        js<string | null>(`document.getElementById("n")?.textContent ?? null`);
      const served = async () =>
        ((await server.state()) as { counter?: { n?: number } }).counter?.n;
      await waitFor("mount", async () => (await n()) === "0" ? true : null);
      // A few beats: the connection has answered pings (the watchdog judges
      // only a connection that has).
      await new Promise((r) => setTimeout(r, 4 * DEFAULT_HEARTBEAT_INTERVAL));
      const beat = DEFAULT_HEARTBEAT_INTERVAL;

      // 1. Only the open socket goes silent; HTTP answers.
      const before1 = net.upgrades.length;
      const t1 = Date.now();
      net.hole(false);
      const at1 = await waitFor(
        "a reconnect after the HTTP answer",
        async () => {
          const o = net.upgrades;
          return o.length > before1 ? o[before1]! : null;
        },
        30_000,
      );
      const took1 = at1 - t1;
      assert(
        took1 >= (SILENT_BEATS_ASK - 1) * beat &&
          took1 <= (SILENT_BEATS_ASK + 6) * beat,
        `reconnected ${took1} ms after the socket went silent (ask at ${SILENT_BEATS_ASK} beats)`,
      );
      await js(`document.getElementById("go").click()`);
      await waitFor(
        "the click over the new socket",
        async () => (await served()) === 1 && (await n()) === "1" ? true : null,
      );

      // 2. Everything goes silent; HTTP hangs as well.
      net.release();
      await new Promise((r) => setTimeout(r, 4 * beat));
      const before2 = net.upgrades.length;
      const t2 = Date.now();
      net.hole(true);
      await new Promise((r) => setTimeout(r, beat / 2));
      await js(`document.getElementById("go").click()`);
      const at2 = await waitFor("a reconnect at the ceiling", async () => {
        const o = net.upgrades;
        return o.length > before2 ? o[before2]! : null;
      }, (SILENT_BEATS_DEAD + 15) * beat);
      const took2 = at2 - t2;
      assert(
        took2 >= (SILENT_BEATS_DEAD - 1) * beat &&
          took2 <= (SILENT_BEATS_DEAD + 5) * beat,
        `reconnected ${took2} ms into a full black hole (ceiling ${SILENT_BEATS_DEAD} beats)`,
      );
      assertEquals(await served(), 1, "nothing crossed the black hole");
      net.release();
      await waitFor(
        "the click from the black hole lands",
        async () => (await served()) === 2 && (await n()) === "2" ? true : null,
        30_000,
      );
      await new Promise((r) => setTimeout(r, 3 * beat));
      assertEquals(await served(), 2, "the click landed once");
      assertEquals(await n(), "2");
      console.log(`ask-path ${took1} ms, ceiling-path ${took2} ms`);
      await page.close();
    } finally {
      await browser.close();
      await net.close();
      await server.stop();
      await dropTempDir(server.dir);
    }
  },
});
