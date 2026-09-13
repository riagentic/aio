// A burst of calls from ONE page must land, every one of them, on a socket
// that stays open.
//
// MEASURED (field report, a real tab): `Promise.all` over 150 `counter.inc()`
// calls — an ordinary list operation — against the default 100 msg/sec
// per-connection budget. The server dropped every frame past 100, counted 50
// drops in a row, closed the socket with 1008 and denylisted the page's
// address for 60 s. The final count was 99; 51 callers were rejected (or lost
// with the socket), the tab showed no client in `am clients` for the whole
// minute, and it did not come back until the denylist expired. The server had
// ADVERTISED its budget in the hello (`rate`) the whole time — the sync
// engine paced to it, and the cell-method path, the one every button uses,
// did not read it.
//
// Driven through the REAL client runtime (browser-air-transport + browser-ack
// over Deno's WebSocket) against a REAL server: the budget, the drop, the
// close and the denylist are all the production code.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { BROWSER, waitFor, withE2E } from "./e2e-harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const g = globalThis as Record<string, unknown>;

type Rig = {
  send: (a: { type: string; payload?: unknown; cid?: string }) => void;
  register: (
    cid: string,
    o: { deferTimer?: boolean; methodKey?: string },
  ) => Promise<unknown>;
  teardown: () => Promise<void>;
};

/** Load the client runtime pointed at `url` (it wires itself at import, so
 *  `location` goes first) and open its socket. One page, one runtime: every
 *  test in this file shares it, re-pointed per server. */
async function clientFor(url: string): Promise<Rig> {
  const u = new URL(url);
  g.location = {
    protocol: u.protocol,
    host: u.host,
    search: "",
    origin: u.origin,
  };
  await import("../src/browser/browser-air-transport.ts");
  const { client, ensureConnected } = await import(
    "../src/browser/browser-protocol.ts"
  );
  const { _registerAck } = await import("../src/browser/browser-ack.ts");
  const sub = await import("../src/browser/protocol-subscription.ts");
  ensureConnected();
  // A live listener keeps the connection up (the runtime tears down 300 ms
  // after the last one goes).
  const unsub = sub._subscribe(() => {});
  return {
    // Exactly what a bound cell method does (cell-reactive `_registerAndSend`):
    // register the ack with a deferred clock, then hand the tagged action to
    // the transport.
    send: (a) => client.send(a),
    register: (cid, o) => _registerAck(cid, o),
    teardown: async () => {
      unsub();
      await sleep(400);
    },
  };
}

/** `n` awaited calls fired together, the way `Promise.all(list.map(…))` does. */
function burst(
  rig: Rig,
  creator: () => { type: string; payload?: unknown },
  n: number,
): Promise<unknown>[] {
  return Array.from({ length: n }, () => {
    const action = creator();
    const cid = crypto.randomUUID();
    const p = rig.register(cid, { deferTimer: true, methodKey: action.type });
    queueMicrotask(() => rig.send({ ...action, cid }));
    return p;
  });
}

async function connectedClients(
  fetchFn: (p: string) => Promise<Response>,
): Promise<number> {
  const body = await (await fetchFn("/__aio/vitals")).json() as {
    clients?: unknown[];
  };
  return body.clients?.length ?? 0;
}

Deno.test({
  name:
    "ws burst: 150 then 1000 parallel calls from one client all resolve, none lost, socket stays up",
  async fn(t) {
    const cells = [150, 1000].map((N) =>
      cell(`burst${N}`, {
        state: { n: 0 },
        methods: {
          inc(s: { n: number }) {
            s.n++;
          },
        },
      })
    );
    await using srv = await testServer({ cells });
    const rig = await clientFor(srv.url);
    try {
      for (let i = 0; i < 100; i++) {
        if (await connectedClients(srv.fetch)) break;
        await sleep(30);
      }
      assertEquals(await connectedClients(srv.fetch), 1, "client connected");

      for (const [i, N] of [150, 1000].entries()) {
        await t.step(`${N} parallel calls`, async () => {
          const creator = cells[i]!.__aio.actions.inc as () => {
            type: string;
            payload?: unknown;
          };
          const t0 = Date.now();
          const settled = await Promise.allSettled(burst(rig, creator, N));
          const rejected = settled.filter((r) => r.status === "rejected");
          assertEquals(
            rejected.length,
            0,
            `${rejected.length} of ${N} calls were refused — first: ${
              String(
                (rejected[0] as PromiseRejectedResult | undefined)?.reason,
              )
            }`,
          );
          const st = srv.state() as Record<string, { n: number }>;
          assertEquals(
            st[`burst${N}`]!.n,
            N,
            "every call applied exactly once — the count is exact",
          );
          assertEquals(
            await connectedClients(srv.fetch),
            1,
            "the socket was never closed for the burst (1008 + denylist)",
          );
          // Paced, not stalled.
          const took = Date.now() - t0;
          assert(took < 1000 + N * 25, `burst of ${N} took ${took} ms`);
        });
      }
    } finally {
      await rig.teardown();
    }
  },
});

// ── the same burst from a REAL browser tab ────────────────────────────────────
//
// The field report's exact shape: a button whose handler awaits
// `Promise.allSettled` over 150 `counter.inc()` calls, in headless Chromium,
// against a real dev server with the default budget.
const E2E_CELLS = `import { cell } from "aio";
export const counter = cell("counter", {
  state: { n: 0 },
  methods: { inc(s) { s.n += 1; } },
});`;

const E2E_APP = `import { useLocal } from "aio/air";
import { counter } from "./cells.ts";
export default function App() {
  const { local: res, set } = useLocal("");
  return (
    <div>
      <span t="n">{String(counter.n)}</span>
      <span t="res">{res}</span>
      <button t="go" onClick={async () => {
        const r = await Promise.allSettled(
          Array.from({ length: 150 }, () => counter.inc()),
        );
        const bad = r.filter((x) => x.status === "rejected");
        set("ok=" + (r.length - bad.length) + " rej=" + bad.length +
          (bad[0] ? " " + String(bad[0].reason).slice(0, 80) : ""));
      }}>go</button>
    </div>
  );
}`;

Deno.test({
  name:
    "e2e ws burst: 150 awaited calls from one real browser tab — all resolve, count exact, still connected",
  ignore: BROWSER === null,
  async fn() {
    await withE2E(
      { cells: E2E_CELLS, app: E2E_APP },
      async ({ server, tab }) => {
        await waitFor("mount", () => tab.text("n"));
        await tab.trigger("App:go", "click");
        const res = await waitFor("burst settled", async () => {
          const t = await tab.text("res");
          return t ? t : null;
        }, 30_000);
        assertEquals(res, "ok=150 rej=0", "every call resolves — none refused");
        const st = await server.state() as { counter?: { n?: number } };
        assertEquals(
          st.counter?.n,
          150,
          "and every write landed, exactly once",
        );
        // Still connected: a call after the burst goes through.
        await tab.trigger("App:go", "click");
        await waitFor("second burst", async () => {
          const s = await server.state() as { counter?: { n?: number } };
          return s.counter?.n === 300 ? true : null;
        }, 30_000);
      },
    );
  },
});
