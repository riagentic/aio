// A worker cell must behave EXACTLY as a normal one — the claim, tested.
//
// `tests/cell-workers.test.ts` states it in its header: "Everything else
// (state, persistence, broadcast) must behave exactly as it does for a normal
// cell, because the worker only streams patches home." Nothing pinned it, and
// the claim has been FALSE at least twice: schedule effects came home as
// actions and vanished, and teardown streamed a destroy-reset home and
// persisted it over real data.
//
// So: two cells with IDENTICAL config in ONE app, one `worker: true` and one
// not, driven through the same scenarios, compared server-side. A worker's
// entry is the app's own module, so this needs a real spawned process — the
// same shape cell-workers.test.ts uses, which is why this is its own file
// rather than a case appended to the transport differential.
//
// The interesting axis is that the two hops are DIFFERENT: a worker round trip
// is structuredClone (Date/Map survive), the socket is JSON (they do not). A
// divergence here is either a real bug or a limit worth naming out loud.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";

const REPO = new URL("../", import.meta.url).pathname;

async function writeApp(dir: string, port: number): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: {
        "aio": `${REPO}mod.ts`,
        "aio/": `${REPO}src/`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@1.1.2",
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "app.ts"),
    `import { aio, cell, schedule } from "aio";

// The ONLY difference between these two is \`worker: true\`.
const methods = {
  take(s: { got: unknown }, v: unknown) { s.got = v; },
  ret(s: { n: number }, v: unknown) { s.n++; return v; },
  async aret(s: { n: number }, v: unknown) {
    await new Promise((r) => setTimeout(r, 20));
    s.n++;
    return v;
  },
  async athrow(_s: unknown) {
    await new Promise((r) => setTimeout(r, 20));
    throw new Error("parity-boom");
  },
  mark(s: { note: string }) { s.note = "fired"; },
};

export const wk = cell("wk", {
  worker: true,
  state: { got: null as unknown, n: 0, note: "" },
  methods: {
    ...methods,
    // Schedules live on the MAIN isolate, so a worker has to hand the effect
    // back rather than run it. This is the path that once came home as an
    // action and vanished.
    later(s: { note: string }) {
      s.note = "scheduled";
      return schedule.after("wk:later", 30, wk.mark.action());
    },
  },
});

export const nw = cell("nw", {
  state: { got: null as unknown, n: 0, note: "" },
  methods: {
    ...methods,
    later(s: { note: string }) {
      s.note = "scheduled";
      return schedule.after("nw:later", 30, nw.mark.action());
    },
  },
});

const show = (v: unknown) =>
  JSON.stringify(v ?? null, (_k, val) => {
    if (val === undefined) return "<undefined>";
    if (val instanceof Map) return "<Map:" + JSON.stringify([...val]) + ">";
    if (val instanceof Set) return "<Set:" + JSON.stringify([...val]) + ">";
    if (val instanceof Date) return "<Date:" + val.toISOString() + ">";
    return val;
  });

await aio.run({
  appId: "worker-parity-e2e",
  cells: [wk, nw],
  client: "server-only",
  persist: false,
  port: ${port},
  routes: {
    // Same payload into both; compare what LANDED in state.
    "/parity/state": async () => {
      const payload = { s: "x", n: 1, arr: [1, [2, 3]], nested: { d: 4 } };
      await wk.take(payload);
      await nw.take(payload);
      return Response.json({ wk: show(wk.got), nw: show(nw.got) });
    },
    // A Date crosses structuredClone intact and JSON as a string — the two
    // hops differ, so this is where a worker cell could legitimately diverge.
    "/parity/date": async () => {
      const d = new Date("2020-01-02T03:04:05.000Z");
      await wk.take({ d });
      await nw.take({ d });
      return Response.json({ wk: show(wk.got), nw: show(nw.got) });
    },
    "/parity/ret": async () => {
      const a = await wk.ret({ ok: 1 });
      const b = await nw.ret({ ok: 1 });
      return Response.json({ wk: show(a), nw: show(b) });
    },
    "/parity/aret": async () => {
      const a = await wk.aret({ ok: 2 });
      const b = await nw.aret({ ok: 2 });
      return Response.json({ wk: show(a), nw: show(b) });
    },
    "/parity/athrow": async () => {
      let a = "no-throw", b = "no-throw";
      try { await wk.athrow(); } catch (e) { a = (e as Error).message; }
      try { await nw.athrow(); } catch (e) { b = (e as Error).message; }
      return Response.json({ wk: a, nw: b });
    },
    // The historical bug: a schedule effect returned from a worker method.
    "/parity/later": async () => {
      await wk.later();
      await nw.later();
      await new Promise((r) => setTimeout(r, 200));
      return Response.json({ wk: wk.note, nw: nw.note });
    },
    "/state": () => Response.json({ wk: wk.n, nw: nw.n }),
  },
});
`,
  );
}

async function boot(
  dir: string,
  port: number,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(dir, "app.ts")],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${url}/state`);
      await res.body?.cancel();
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    stop: async () => {
      try {
        child.kill("SIGTERM");
      } catch { /* gone */ }
      await child.status;
      await child.stdout.cancel().catch(() => {});
      await child.stderr.cancel().catch(() => {});
    },
  };
}

Deno.test({
  name:
    "worker parity: a worker cell behaves as a normal one — state, returns, throws, effects",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-wparity-" });
    const port = freePort();
    await writeApp(dir, port);
    const app = await boot(dir, port);
    try {
      for (
        const path of [
          "/parity/state",
          "/parity/date",
          "/parity/ret",
          "/parity/aret",
          "/parity/athrow",
          "/parity/later",
        ]
      ) {
        const r = await fetch(`${app.url}${path}`);
        const got = await r.json() as { wk: unknown; nw: unknown };
        assertEquals(
          got.wk,
          got.nw,
          `${path}: the worker cell and the normal cell disagreed\n` +
            `  worker: ${JSON.stringify(got.wk)}\n  normal: ${
              JSON.stringify(got.nw)
            }`,
        );
      }
      // …and the effect actually RAN, or "they agree" would be two silences.
      const later = await (await fetch(`${app.url}/parity/later`)).json() as {
        wk: string;
      };
      assertEquals(later.wk, "fired", "the schedule effect never fired");
    } finally {
      await app.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
