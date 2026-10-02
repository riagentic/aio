// The local-peer gate over a REAL listener — the production property, proven
// end to end on this machine:
//
//   • a foreign peer (same user, NOT this app's window) is given NO state and
//     cannot run a method — every frame kind that reads state or runs code is
//     dropped, with a spy on each sink proving it never arrived;
//   • over `ctl` it may ask ONE thing, `GET /__aio/health`, and is told only
//     "up" and "which app" — which is what `am health` and the packaged-app
//     door test ask a running production server;
//   • once armed with the window's pid, the window is served normally, and
//     once the window is gone the gate trusts no one again.
//
// The pid is the kernel's answer (SO_PEERCRED / LOCAL_PEERPID), so a same-user
// process cannot forge it. Windows uses the pipe's client pid; macOS the same
// unix fd path. See src/server/local-peer.ts and local-listen.ts.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createUDSListener } from "../src/server/uds.ts";
import type { ServerSyncHandler } from "../src/sync/server-handler.ts";
import { requireLocalPeer } from "../src/server/local-peer.ts";
import { dropTempDir, tempDirSync } from "../src/testing/temp-dir.ts";

// The FFI library is a resource Deno's sanitizer tracks per test: open it here,
// before any case, so no case opens a library it does not close. The live
// server keeps it for the process.
requireLocalPeer();

const dir = tempDirSync("local-peer-");
const sock = `${dir}/peer.sock`;

/** Every sink a frame can reach, counted. A foreign frame that is "dropped"
 *  but still lands in one of these is not dropped. */
const spy = {
  action: 0,
  op: 0,
  sync: 0,
  tt: 0,
  state: 0,
  control: [] as string[],
};
const HEALTH = JSON.stringify({
  status: "healthy",
  appId: "myapp",
  pid: 4242,
  cells: [{ id: "c", lastAction: "c:inc" }],
});

const handle = createUDSListener(
  sock,
  () => {
    spy.state++;
    return { n: 1, secret: "hkept" };
  },
  () => {
    spy.action++;
  },
  () => {},
  undefined,
  {
    handleOp: () => {
      spy.op++;
    },
    handleSync: () => {
      spy.sync++;
    },
  } as unknown as ServerSyncHandler,
  undefined,
  {
    onCommand: () => {
      spy.tt++;
    },
    getBroadcast: () => ({}),
  },
  undefined,
  // The control plane: the health document, and an app route beside it.
  (req) => {
    const path = new URL(req.url).pathname;
    spy.control.push(`${req.method} ${path}`);
    return Promise.resolve(
      path === "/__aio/health"
        ? new Response(HEALTH, {
          headers: { "content-type": "application/json", "x-internal": "1" },
        })
        : new Response("ROUTE-BODY"),
    );
  },
  undefined,
  undefined,
  { required: true },
);
// Armed to a process that is not this one: every connection THIS test opens
// is a foreign one until a case arms `Deno.pid`.
handle.armPeerPid?.(1);

/** The fd-bearing backend binds asynchronously (node), so wait for the socket
 *  file rather than racing it. */
async function waitBound(p: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      if (Deno.lstatSync(p).isSocket) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`listener never bound ${p}`);
}

/** Send `frame` (if given) and return the first line received, or null when
 *  the deadline passes with nothing — the "refused" outcome. */
async function exchange(
  p: string,
  frame: string | undefined,
  ms = 1200,
): Promise<string | null> {
  const c = await Deno.connect({ transport: "unix", path: p });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (frame !== undefined) {
      const w = c.writable.getWriter();
      await w.write(new TextEncoder().encode(frame + "\n"));
    }
    const reader = c.readable.getReader();
    const r = await Promise.race([
      reader.read(),
      new Promise<null>((res) => {
        timer = setTimeout(() => res(null), ms);
      }),
    ]);
    if (r === null || r.done || !r.value) return null;
    return new TextDecoder().decode(r.value);
  } finally {
    // The deadline must not outlive the test (Deno's sanitizer counts a timer
    // that fires in a later case against it).
    if (timer !== undefined) clearTimeout(timer);
    try {
      c.close();
    } catch { /* already closed by the server */ }
  }
}

const ctl = (path: string, method = "GET") =>
  JSON.stringify({ v: 2, t: "ctl", d: { id: "1", path, method } });

Deno.test("local-peer gate: a foreign peer is given NO state, and `ctl` health says only up + which app", async () => {
  await waitBound(sock);
  const reply = await exchange(sock, ctl("/__aio/health"));
  assert(reply !== null, "the control plane did not answer a foreign peer");
  const r = JSON.parse(reply.split("\n")[0]!) as {
    t: string;
    d: { status: number; body: string; headers: Record<string, string> };
  };
  assertEquals(r.t, "ctlr");
  assertEquals(r.d.status, 200);
  assertEquals(JSON.parse(r.d.body), { status: "healthy", appId: "myapp" });
  assertEquals(
    r.d.headers["x-internal"],
    undefined,
    "the handler's own headers are not a foreign peer's to read",
  );
  assertEquals(spy.state, 0, "state was read for a foreign connection");
});

Deno.test("local-peer gate: a foreign `ctl` for anything else is refused BEFORE the handler runs", async () => {
  await waitBound(sock);
  spy.control.length = 0;
  for (
    const [path, method] of [
      ["/api/hello", "GET"],
      ["/api/hello", "POST"],
      ["/__aio/vitals", "GET"],
      ["/__aio/metrics", "GET"],
      ["/__aio/snapshot", "GET"],
      ["/__aio/trojan/state", "GET"],
      ["/__aio/health", "POST"],
      ["/", "GET"],
    ] as const
  ) {
    const reply = await exchange(sock, ctl(path, method));
    assert(reply !== null, `${method} ${path}: a ctl request must be ANSWERED`);
    const r = JSON.parse(reply.split("\n")[0]!) as {
      d: { status: number; body: string };
    };
    assertEquals(r.d.status, 404, `${method} ${path}: ${r.d.body}`);
    assertStringIncludes(r.d.body, "local-peer lockdown");
    assertEquals(r.d.body.includes("ROUTE-BODY"), false);
  }
  assertEquals(
    spy.control,
    [],
    "the app's handler ran for a process that is not its window",
  );
});

Deno.test("local-peer gate: no foreign frame reaches dispatch, sync, time travel or state — and nothing is sent back", async () => {
  await waitBound(sock);
  const frames = [
    { t: "action", d: { type: "c:inc", cid: "x1" } },
    { t: "sfn", d: { cid: "s1", ns: "a", name: "b", args: [] } },
    { t: "tt-cmd", d: "pause" },
    { t: "op", d: { id: "o", cell: "c", action: "inc", hlc: [1, 0, "x"] } },
    { t: "sync-req", d: { clientId: "x" } },
    { t: "subs", d: { subs: ["*"] } },
    { t: "resync", d: {} },
    { t: "client-state", d: { n: 2 } },
  ];
  for (const f of frames) {
    // One connection per kind, so "nothing came back" is said of each one.
    const back = await exchange(sock, JSON.stringify({ v: 2, ...f }), 400);
    assertEquals(back, null, `a foreign "${f.t}" frame was answered: ${back}`);
  }
  assertEquals(
    {
      action: spy.action,
      op: spy.op,
      sync: spy.sync,
      tt: spy.tt,
      state: spy.state,
    },
    { action: 0, op: 0, sync: 0, tt: 0, state: 0 },
    "a foreign frame reached a sink",
  );
});

Deno.test("local-peer gate: a foreign peer's subscription is dropped", async () => {
  await waitBound(sock);
  assertEquals(
    await exchange(
      sock,
      JSON.stringify({ v: 2, t: "subs", d: { subs: ["*"] } }),
    ),
    null,
  );
});

Deno.test("local-peer gate: once armed with this window's pid, it is served", async () => {
  handle.armPeerPid?.(Deno.pid); // this process stands in for the window
  const line = await exchange(sock, undefined);
  assert(line !== null, "the armed window received nothing");
  assertStringIncludes(line, '"t":"proto"');
});

Deno.test("local-peer gate: the window's own `ctl` reaches the whole handler, unreduced", async () => {
  handle.armPeerPid?.(Deno.pid);
  const c = await Deno.connect({ transport: "unix", path: sock });
  let got = "";
  const timer = setTimeout(() => c.close(), 3000);
  try {
    await c.write(
      new TextEncoder().encode(
        ctl("/api/hello") + "\n" + ctl("/__aio/health") + "\n",
      ),
    );
    const b = new Uint8Array(1 << 16);
    while ((got.match(/"ctlr"/g) ?? []).length < 2) {
      const n = await c.read(b);
      if (n === null) break;
      got += new TextDecoder().decode(b.subarray(0, n));
    }
  } finally {
    clearTimeout(timer);
    try {
      c.close();
    } catch { /* closed by the deadline */ }
  }
  assertStringIncludes(got, "ROUTE-BODY");
  assertStringIncludes(
    got,
    "4242",
    "the window reads the full health document",
  );
});

Deno.test("local-peer gate: when the window exits the gate is disarmed — its pid is trusted no more", async () => {
  handle.armPeerPid?.(Deno.pid);
  handle.disarmPeerPid?.(Deno.pid);
  assertEquals(await exchange(sock, undefined, 400), null);
  // A late exit notice for some OTHER pid changes nothing.
  handle.armPeerPid?.(Deno.pid);
  handle.disarmPeerPid?.(1);
  assert(await exchange(sock, undefined) !== null);
});

Deno.test("local-peer gate: when the window exits, its open session is closed — not left to whoever holds the descriptor", async () => {
  handle.armPeerPid?.(Deno.pid);
  const c = await Deno.connect({ transport: "unix", path: sock });
  const b = new Uint8Array(1 << 16);
  try {
    // A session: the server greets it.
    let got = "";
    while (!got.includes('"t":"proto"')) {
      const n = await c.read(b);
      assert(n !== null, `the armed window was not served: ${got}`);
      got += new TextDecoder().decode(b.subarray(0, n));
    }
    const sessions = handle.clients().length;
    assert(sessions >= 1);
    // The window process exits. A child it forked still holds this very
    // connection; the server must end it, not just refuse the next one.
    handle.disarmPeerPid?.(Deno.pid);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      (async () => {
        while ((await c.read(b)) !== null) { /* frames already in flight */ }
        return true;
      })(),
      new Promise<false>((r) => timer = setTimeout(() => r(false), 3000)),
    ]);
    clearTimeout(timer);
    assert(closed, "the session survived the window's exit");
    // …and it is off the roster: no broadcast is addressed to it.
    for (let i = 0; i < 100 && handle.clients().length >= sessions; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(handle.clients().length, sessions - 1);
  } finally {
    try {
      c.close();
    } catch { /* closed by the server */ }
  }
});

Deno.test("local-peer gate: a different same-user process gets no state", async () => {
  handle.armPeerPid?.(Deno.pid); // armed to US — the child is a stranger
  const child = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `const c = await Deno.connect({ transport: "unix", path: ${
        JSON.stringify(sock)
      } });
       const w = c.writable.getWriter();
       await w.write(new TextEncoder().encode(JSON.stringify({ v: 2, t: "subs", d: { subs: ["*"] } }) + "\\n"));
       const r = c.readable.getReader();
       const got = await Promise.race([r.read(), new Promise((res) => setTimeout(() => res(null), 1000))]);
       console.log(got === null || got.done || !got.value ? "QUIET" : "FRAME");
       try { c.close(); } catch {}`,
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  assertEquals(new TextDecoder().decode(child.stdout).trim(), "QUIET");
});

Deno.test("local-peer gate: shutdown closes the door and removes the socket", async () => {
  handle.shutdown();
  await dropTempDir(dir);
  // A closed listener has no door left to open.
  let threw = false;
  try {
    await Deno.connect({ transport: "unix", path: sock });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
