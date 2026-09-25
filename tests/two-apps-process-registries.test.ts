// two-apps-process-registries.test.ts — the module-level registries that two
// `aio.run()` apps in ONE process used to share, each pinned per app.
//
// Every one was a single module-level slot or map, so whatever app B did
// landed on app A too:
//   - `spawn()` children: closing B killed the child A had just started;
//   - `serverFns`: B (open, no auth) served a namespace A registered behind
//     its user auth, to an anonymous client;
//   - call ceilings: the LAST booted app's `effectTimeoutMs` bounded every
//     app's `await cell.method()`, and outlived that app's `close()`;
//   - `client.log`: A's browser console lines landed in B's `logs/`;
//   - signup / auth-work / failed-login budgets: 11 signups on B answered A's
//     first signup with a 429.
// Each boots A, then B beside it, and asks whether A's facts stay A's. The
// per-app answer is the app scope every `aio.run()` runs in.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio, cell, serverFns } from "../mod.ts";
import { spawn } from "../src/server-entry.ts";
import { freePort } from "../src/testing/server-test.ts";
import { enc } from "../src/protocol/envelope.ts";

// deno-lint-ignore no-explicit-any
type App = { close(): Promise<void>; port: number; getState(): any };

const tag = () => crypto.randomUUID().slice(0, 8);
const plain = (name: string) =>
  cell(name, {
    state: { x: 0 },
    methods: {
      inc(s: { x: number }) {
        s.x++;
      },
    },
  });

async function boot(
  id: string,
  dir: string,
  cells: unknown[],
  // deno-lint-ignore no-explicit-any
  extra: Record<string, any> = {},
): Promise<App> {
  return await aio.run({
    cells,
    appId: `${id}-${tag()}`,
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port: freePort(),
    ...extra,
  } as never) as unknown as App;
}

// Registered outside any app — at module top level, before any boot (a later
// `Deno.test` body can still carry the previous test's app scope) — so it has
// no app to belong to and every app serves it, as before.
const shared = `shared${tag()}`;
serverFns(shared, { read: () => "SHARED" });

const tmp = (p: string) => tempDir(`aio-reg-${p}-`);
const rmDir = (d: string) => dropTempDir(d).catch(() => {});
const alive = (pid: number) => {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
};

Deno.test({
  name: "two apps: closing B leaves the children A spawned running",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const [da, db] = [await tmp("spawn-a"), await tmp("spawn-b")];
    const a = cell("sp", {
      state: { pid: 0 },
      methods: {
        async start(s: { pid: number }) {
          s.pid = (await spawn("sleep", { args: ["37"] })).pid;
        },
      },
    });
    const A = await boot("spa", da, [a]);
    const B = await boot("spb", db, [plain("cb")]);
    let pid = 0;
    try {
      await (a as unknown as { start(): Promise<void> }).start();
      pid = A.getState().sp.pid;
      assert(pid > 0 && alive(pid), "A's child must be running");
      await B.close();
      await new Promise((r) => setTimeout(r, 150));
      assert(alive(pid), "closing app B killed a child app A spawned");
    } finally {
      await B.close();
      await A.close();
    }
    // A's own shutdown still reaps what A left running.
    await new Promise((r) => setTimeout(r, 150));
    assert(!alive(pid), "A's shutdown must still kill A's unclaimed child");
    await rmDir(da);
    await rmDir(db);
  },
});

Deno.test({
  name:
    "two apps: a server the app starts in onStart carries the app once its handler is wrapped as documented",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // Deno runs a `Deno.serve` handler in the runtime's ambient context, not
    // the context that started the server — so a server the APP starts is
    // outside any app unless its handler is wrapped. The documented wrap:
    // `AsyncLocalStorage.snapshot()` taken in onStart.
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const [da, db] = [await tmp("usrv-a"), await tmp("usrv-b")];
    let srv: Deno.HttpServer<Deno.NetAddr> | undefined;
    let pid = 0;
    const A = await boot("usa", da, [plain("ca")], {
      onStart: () => {
        const asThisApp = AsyncLocalStorage.snapshot();
        srv = Deno.serve(
          { port: 0, onListen() {} },
          (req) =>
            asThisApp(async (_r: Request) => {
              pid = (await spawn("sleep", { args: ["38"] })).pid;
              return new Response("ok");
            }, req),
        );
      },
    });
    const B = await boot("usb", db, [plain("cb")]);
    try {
      await (await fetch(`http://127.0.0.1:${srv!.addr.port}/`)).text();
      assert(pid > 0 && alive(pid));
      await B.close();
      await new Promise((r) => setTimeout(r, 150));
      assert(alive(pid), "closing B killed the child A's own server spawned");
    } finally {
      await B.close();
      await srv?.shutdown();
      await A.close();
    }
    await new Promise((r) => setTimeout(r, 150));
    assert(!alive(pid), "A's shutdown still reaps it");
    await rmDir(da);
    await rmDir(db);
  },
});

async function sfnCall(
  port: number,
  ns: string,
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws`,
    headers ? { headers } as never : undefined,
  );
  try {
    return await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("sfn timed out")), 5000);
      ws.onopen = () =>
        ws.send(enc("sfn", { cid: "c1", ns, name: "read", args: [] }));
      ws.onmessage = (e) => {
        const f = JSON.parse(String(e.data));
        if (f.t === "sfnr") {
          clearTimeout(t);
          res(f.d);
        }
      };
      ws.onclose = (e) => {
        clearTimeout(t);
        rej(new Error(`closed ${e.code} ${e.reason}`));
      };
    });
  } finally {
    const closed = new Promise((r) => ws.addEventListener("close", r));
    ws.close();
    await closed;
  }
}

Deno.test("two apps: a serverFns namespace A registered is served by A only", async () => {
  const [da, db] = [await tmp("sfn-a"), await tmp("sfn-b")];
  const ns = `vault${tag()}`;
  const token = "alice-token-1234567890";
  const A = await boot("sfa", da, [plain("ca")], {
    users: { [token]: { id: "alice", role: "admin" } },
    // Registered AS app A (onStart runs in its scope).
    onStart: () => {
      serverFns(ns, { read: () => "A-SECRET" });
    },
  });
  const B = await boot("sfb", db, [plain("cb")]);
  try {
    const onA = await sfnCall(A.port, ns, { authorization: `Bearer ${token}` });
    assertEquals(onA.value, "A-SECRET", JSON.stringify(onA));
    const onB = await sfnCall(B.port, ns);
    assertEquals(
      onB.ok,
      false,
      `B served A's serverFns: ${JSON.stringify(onB)}`,
    );
    assert(!JSON.stringify(onB).includes("A-SECRET"));
    assertStringIncludes(String(onB.error), "not registered");
    const sh = await sfnCall(B.port, shared);
    assertEquals(sh.value, "SHARED", JSON.stringify(sh));
  } finally {
    await B.close();
    await A.close();
  }
  await rmDir(da);
  await rmDir(db);
});

Deno.test("serverFns: a namespace an app registered is served by the next app once the first has closed", async () => {
  // The documented pattern: a *.server.ts module the app imports from
  // onStart. The module registry caches it, so a later app's onStart does
  // NOT register it again — the first app's ownership must end with it.
  const [d1, d2] = [await tmp("seq-1"), await tmp("seq-2")];
  const ns = `seqapi${tag()}`;
  const modDir = await tempDir("aio-seq-");
  const mod = `${modDir}/api.ts`;
  const serverFnsUrl = new URL("../mod.ts", import.meta.url).href;
  await Deno.writeTextFile(
    mod,
    `import { serverFns } from "${serverFnsUrl}";\n` +
      `export const api = serverFns("${ns}", { read: () => "OK" });\n`,
  );
  const onStart = async () => {
    await import(`file://${mod}`);
  };
  const first = await boot("seq1", d1, [plain("c1")], { onStart });
  try {
    assertEquals((await sfnCall(first.port, ns)).value, "OK");
  } finally {
    await first.close();
  }
  const second = await boot("seq2", d2, [plain("c2")], { onStart });
  try {
    const r = await sfnCall(second.port, ns);
    assertEquals(
      r.value,
      "OK",
      `a closed app kept the namespace: ${JSON.stringify(r)}`,
    );
  } finally {
    await second.close();
  }
  await dropTempDir(modDir);
  await rmDir(d1);
  await rmDir(d2);
});

const slowCell = (name: string) =>
  cell(name, {
    state: { done: 0 },
    methods: {
      async slow(s: { done: number }) {
        await new Promise((r) => setTimeout(r, 500));
        s.done++;
        return "ok";
      },
    },
  });

Deno.test("two apps: each app's call ceiling is its own, and outlives the other's close", async () => {
  const [da, db] = [await tmp("ct-a"), await tmp("ct-b")];
  const a = slowCell("ca") as unknown as { slow(): Promise<string> };
  const A = await boot("cta", da, [a], { effectTimeoutMs: 5000 });
  const B = await boot("ctb", db, [slowCell("cb")], { effectTimeoutMs: 100 });
  try {
    assertEquals(await a.slow(), "ok", "B's 100ms ceiling bounded A's call");
    await B.close();
    assertEquals(await a.slow(), "ok", "B's ceiling outlived B's close");
  } finally {
    await B.close();
    await A.close();
  }
  await rmDir(da);
  await rmDir(db);
});

async function sendConsoleLine(port: number, marker: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => ws.onmessage = r);
  ws.send(enc("log", { level: "error", msg: marker, ts: Date.now() }));
  await new Promise((r) => setTimeout(r, 200));
  const closed = new Promise((r) => ws.addEventListener("close", r));
  ws.close();
  await closed;
}

Deno.test("two apps: a browser's console lines land in its own app's client.log", async () => {
  const [da, db] = [await tmp("cl-a"), await tmp("cl-b")];
  const A = await boot("cla", da, [plain("ca")]);
  const B = await boot("clb", db, [plain("cb")]);
  try {
    await sendConsoleLine(A.port, "MARKER-FROM-A-BROWSER");
    await sendConsoleLine(B.port, "MARKER-FROM-B-BROWSER");
  } finally {
    await B.close();
    await A.close();
  }
  const read = (d: string) =>
    Deno.readTextFile(join(d, "logs", "client.log")).catch(() => "");
  const [la, lb] = [await read(da), await read(db)];
  assertStringIncludes(la, "MARKER-FROM-A-BROWSER");
  assert(!la.includes("MARKER-FROM-B-BROWSER"), `A's client.log:\n${la}`);
  assertStringIncludes(lb, "MARKER-FROM-B-BROWSER");
  assert(!lb.includes("MARKER-FROM-A-BROWSER"), `B's client.log:\n${lb}`);
  await rmDir(da);
  await rmDir(db);
});

Deno.test("two apps: the signup budget is counted per app", async () => {
  const [da, db] = [await tmp("au-a"), await tmp("au-b")];
  const extra = { persist: true, auth: true };
  const A = await boot("aua", da, [plain("ca")], extra);
  const B = await boot("aub", db, [plain("cb")], extra);
  const signup = async (app: App, id: string) => {
    const r = await fetch(`http://127.0.0.1:${app.port}/__aio/auth/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${app.port}`,
      },
      body: JSON.stringify({ id, password: `correct-horse-battery-${id}` }),
    });
    await r.body?.cancel();
    return r.status;
  };
  try {
    const onB: number[] = [];
    for (let i = 0; i < 11; i++) onB.push(await signup(B, `u${i}`));
    assertEquals(onB.at(-1), 429, `B's own budget must still hold: ${onB}`);
    assertEquals(await signup(A, "bob"), 201, "B's signups spent A's budget");
  } finally {
    await B.close();
    await A.close();
  }
  await rmDir(da);
  await rmDir(db);
});
