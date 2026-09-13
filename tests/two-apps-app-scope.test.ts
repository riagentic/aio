// two-apps-app-scope.test.ts — "whose app is this?" answered for EVERYTHING an
// app starts, not only for the code aio calls on its behalf.
//
// Two apps in one process (library mode, `testApps`) each own a logger, a
// health report and a diagnostic stream. The per-app scope used to be entered
// only around dispatch, effects and hooks, so anything else fell back to the
// LAST-booted app:
//   - a route handler, a timer armed in `onStart` or in a method → B's files;
//   - a line app B logged BEFORE its own logger existed → A's files;
//   - `degraded()`: B's `/health` listed a failure only A's client reported,
//     and a framework tracker A's server tripped.
// Each case boots A, then B beside it, and asks whether A's facts stay A's.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell, log } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { enc } from "../src/protocol/envelope.ts";
import { degraded } from "../src/diagnostics/degraded.ts";

type App = { close(): Promise<void>; port: number };

const mk = (id: string) =>
  cell("c", {
    state: { n: 0 },
    methods: {
      say(s: { n: number }) {
        s.n++;
        setTimeout(() => log.warn(`METHOD-TIMER-${id}`), 5);
      },
      trip(s: { n: number }) {
        s.n++;
        // A framework-style tracker tripped by THIS app's code.
        for (let i = 0; i < 5; i++) degraded("shared:op").fail(`BROKE-${id}`);
      },
    },
  });

async function boot(
  id: string,
  dir: string,
  // deno-lint-ignore no-explicit-any
  extra: Record<string, any> = {},
) {
  const c = mk(id);
  const app = await aio.run({
    cells: [c],
    appId: `${id}-${crypto.randomUUID().slice(0, 8)}`,
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port: freePort(),
    routes: {
      "/log": () => {
        log.warn(`ROUTE-${id}`);
        return new Response("ok");
      },
    },
    onStart: () => {
      setTimeout(() => log.warn(`ONSTART-TIMER-${id}`), 30);
    },
    ...extra,
  } as never) as unknown as App;
  return {
    app,
    cell: c as unknown as { say(): Promise<void>; trip(): Promise<void> },
  };
}

const read = (p: string) => Deno.readTextFile(p).catch(() => "");
const get = async (port: number, path: string) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return path.endsWith("health") ? await r.json() : await r.text();
};

Deno.test("two apps: routes, onStart timers, method timers and pre-logger lines log as their own app", async () => {
  const da = await Deno.makeTempDir({ prefix: "aio-scope-a-" });
  const db = await Deno.makeTempDir({ prefix: "aio-scope-b-" });
  const A = await boot("A", da);
  // B's boot says something before its logger exists.
  const B = await boot("B", db, {
    perfBudget: { methods: { "c:nope-before-logger": { maxMs: 5 } } },
  });
  try {
    await A.cell.say();
    await get(A.app.port, "/log");
    await get(B.app.port, "/log");
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    await B.app.close();
    await A.app.close();
  }
  const aLog = await read(join(da, "logs", "warning.log"));
  const bLog = await read(join(db, "logs", "warning.log"));
  for (const m of ["ROUTE-A", "ONSTART-TIMER-A", "METHOD-TIMER-A"]) {
    assert(aLog.includes(m), `A's warning.log must hold ${m}:\n${aLog}`);
    assert(!bLog.includes(m), `B's warning.log must not hold A's ${m}`);
  }
  for (const m of ["ROUTE-B", "ONSTART-TIMER-B"]) {
    assert(bLog.includes(m), `B's warning.log must hold ${m}:\n${bLog}`);
    assert(!aLog.includes(m), `A's warning.log must not hold B's ${m}`);
  }
  for (const f of ["app.log", "debug.log", "warning.log"]) {
    assert(
      !(await read(join(da, "logs", f))).includes("nope-before-logger"),
      `B's pre-logger boot line must not land in A's ${f}`,
    );
  }
  await Deno.remove(da, { recursive: true }).catch(() => {});
  await Deno.remove(db, { recursive: true }).catch(() => {});
});

Deno.test("two apps: /health degraded lists are each app's own", async () => {
  const da = await Deno.makeTempDir({ prefix: "aio-deg-a-" });
  const db = await Deno.makeTempDir({ prefix: "aio-deg-b-" });
  // No onStart timer here — these apps close before it would fire.
  const A = await boot("A", da, { onStart: () => {} });
  const B = await boot("B", db, { onStart: () => {} });
  const ws = new WebSocket(`ws://127.0.0.1:${A.app.port}/ws`);
  try {
    await new Promise((r) => ws.onmessage = r);
    ws.send(enc("cdiag", {
      name: "A-only-cache",
      kind: "down",
      failures: 9,
      since: 1,
      lastError: "A's browser failure",
    }));
    await A.cell.trip();
    let ha: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      ha = await get(A.app.port, "/__aio/health");
      if (ha.clientDegraded) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(
      (ha.clientDegraded as { name: string }[])?.map((d) => d.name),
      ["A-only-cache"],
      "A's own client failure is on A",
    );
    assert(
      JSON.stringify(ha.degraded ?? []).includes("shared:op"),
      `A's tripped tracker is on A: ${JSON.stringify(ha)}`,
    );
    const hb = await get(B.app.port, "/__aio/health");
    assertEquals(
      hb.clientDegraded,
      undefined,
      `B has no client reporting anything: ${JSON.stringify(hb)}`,
    );
    assert(
      !JSON.stringify(hb.degraded ?? []).includes("shared:op"),
      `A's tracker tripped by A's code is not B's: ${JSON.stringify(hb)}`,
    );
    assertEquals(hb.status, "healthy", JSON.stringify(hb));
  } finally {
    ws.close();
    await B.app.close();
    await A.app.close();
    await Deno.remove(da, { recursive: true }).catch(() => {});
    await Deno.remove(db, { recursive: true }).catch(() => {});
  }
});
