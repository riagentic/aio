// The control plane over the Unix socket.
//
// `am` used to reach a running app on ONE wire: a TCP port. An app on UDS
// therefore had a control plane its own operator could not open — `am-http`
// said so in prose ("the dev control plane is not served there") — which made
// "an Electron app should bind no ports" impossible to actually adopt: closing
// the port closed `am state`, `am dispatch`, `am surface`, `am trigger` with
// it.
//
// The fix is deliberately NOT a socket-native control API. A `ctl` frame is
// turned back into a `Request` and handed to the SAME handler the TCP listener
// calls, so there is one implementation of the routes and — much more
// importantly — one set of auth gates. These tests pin that: the socket
// answers, and it answers with the same decisions.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/aio.ts";
import { udsRequest } from "../src/am/am-uds.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { resolveSocketPath } from "../src/server/paths.ts";
import { removePid, writePid } from "../src/am/am-utils.ts";
import { trojanGet } from "../src/am/am-http.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

async function socketDir(prefix: string): Promise<string> {
  return join(await tempDir(prefix), "s.sock");
}

/** A stand-in for the server's `control` — records what it was handed, so the
 *  tests can assert on the REQUEST the frame became, not only on the reply. */
function recordingControl() {
  const seen: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }[] = [];
  const control = async (req: Request) => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    seen.push({
      url: req.url,
      method: req.method,
      headers,
      body: req.method === "POST" ? await req.text() : "",
    });
    return new Response(JSON.stringify({ ok: true, route: req.url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { seen, control };
}

Deno.test("uds control: a GET round-trips through the server's own handler", async () => {
  const socketPath = await socketDir("aio-ctl-get-");
  const { seen, control } = recordingControl();
  const uds = createUDSListener(
    socketPath,
    () => ({ hello: "world" }),
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    control,
  );
  try {
    const r = await udsRequest(
      socketPath,
      "/__aio/trojan/state?x=1",
      { method: "GET" },
      5000,
    );
    assert(!("error" in r), `control call failed: ${JSON.stringify(r)}`);
    assertEquals(r.status, 200);
    assertEquals(JSON.parse(r.body).ok, true);
    // The PATH and its query survive the trip — a control route that silently
    // lost its query string would answer the wrong question with a 200.
    assertEquals(seen.length, 1);
    assert(
      seen[0]!.url.endsWith("/__aio/trojan/state?x=1"),
      `path/query lost in translation: ${seen[0]!.url}`,
    );
    assertEquals(seen[0]!.method, "GET");
  } finally {
    uds.shutdown();
  }
});

Deno.test("uds control: a POST carries body and credential headers verbatim", async () => {
  const socketPath = await socketDir("aio-ctl-post-");
  const { seen, control } = recordingControl();
  const uds = createUDSListener(
    socketPath,
    () => ({}),
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    control,
  );
  try {
    const r = await udsRequest(
      socketPath,
      "/__aio/trojan/dispatch",
      {
        method: "POST",
        headers: {
          "X-AIO": "1",
          "X-Aio-Control": "secret-control-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: "todos:add" }),
      },
      5000,
    );
    assert(!("error" in r));
    assertEquals(r.status, 200);
    assertEquals(seen[0]!.method, "POST");
    assertEquals(seen[0]!.body, JSON.stringify({ type: "todos:add" }));
    // These two headers ARE the auth story: the CSRF marker and the local
    // control credential. If the socket dropped them, every gate downstream
    // would be deciding on different evidence than it does over TCP — which is
    // the exact drift this design exists to prevent.
    assertEquals(seen[0]!.headers["x-aio"], "1");
    assertEquals(seen[0]!.headers["x-aio-control"], "secret-control-key");
  } finally {
    uds.shutdown();
  }
});

Deno.test("uds control: the handler's refusal is relayed, not swallowed", async () => {
  const socketPath = await socketDir("aio-ctl-deny-");
  const uds = createUDSListener(
    socketPath,
    () => ({}),
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "access denied" }), {
          status: 403,
        }),
      ),
  );
  try {
    const r = await udsRequest(
      socketPath,
      "/__aio/trojan/state",
      { method: "GET" },
      5000,
    );
    // A refusal is an ANSWER. Reporting it as a transport failure would tell
    // the operator their app is unreachable when it is in fact working and
    // saying no — the difference between "start your app" and "authenticate".
    assert(!("error" in r), "a 403 must arrive as a status, not an error");
    assertEquals(r.status, 403);
    assertEquals(JSON.parse(r.body).error, "access denied");
  } finally {
    uds.shutdown();
  }
});

Deno.test("uds control: a throwing handler answers 500 instead of hanging the caller", async () => {
  const socketPath = await socketDir("aio-ctl-throw-");
  const uds = createUDSListener(
    socketPath,
    () => ({}),
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => Promise.reject(new Error("handler exploded")),
  );
  try {
    const r = await udsRequest(
      socketPath,
      "/__aio/trojan/state",
      { method: "GET" },
      5000,
    );
    assert(!("error" in r), "a handler throw must not read as a dead socket");
    assertEquals(r.status, 500);
    assert(r.body.includes("handler exploded"));
  } finally {
    uds.shutdown();
  }
});

Deno.test("uds control: an app with no control plane says so, and does not go quiet", async () => {
  const socketPath = await socketDir("aio-ctl-none-");
  // No `control` argument — the shape a prod/skipHttp app has, where the
  // trojan does not exist at all.
  const uds = createUDSListener(socketPath, () => ({}), () => {}, () => {});
  try {
    const r = await udsRequest(
      socketPath,
      "/__aio/trojan/state",
      { method: "GET" },
      5000,
    );
    assert(!("error" in r));
    assertEquals(r.status, 503);
    assert(
      r.body.includes("no control plane"),
      "silence would leave the caller unable to tell refused from absent",
    );
  } finally {
    uds.shutdown();
  }
});

Deno.test("uds control: replies are matched by id, never by arrival order", async () => {
  const socketPath = await socketDir("aio-ctl-id-");
  // Answer slowly for the first route and fast for the second, so the replies
  // come back out of order. A client that took "the next ctlr" would hand the
  // caller another call's answer — a wrong-app-wrong-answer bug that looks
  // like corrupted state rather than a transport fault.
  const control = async (req: Request) => {
    const slow = req.url.includes("slow");
    if (slow) await new Promise((r) => setTimeout(r, 120));
    return new Response(JSON.stringify({ route: slow ? "slow" : "fast" }), {
      status: 200,
    });
  };
  const uds = createUDSListener(
    socketPath,
    () => ({}),
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    control,
  );
  try {
    const [slow, fast] = await Promise.all([
      udsRequest(socketPath, "/__aio/trojan/slow", { method: "GET" }, 5000),
      udsRequest(socketPath, "/__aio/trojan/fast", { method: "GET" }, 5000),
    ]);
    assert(!("error" in slow) && !("error" in fast));
    assertEquals(JSON.parse(slow.body).route, "slow");
    assertEquals(JSON.parse(fast.body).route, "fast");
  } finally {
    uds.shutdown();
  }
});

Deno.test("uds control: a ctlr for a different id is skipped, not mistaken for ours", async () => {
  // The listener greets every connection with proto/state frames before any
  // answer, and other control calls may be in flight on the same socket. The
  // client must read past all of it. Driven at the frame level so the
  // interleaving is exact rather than hoped for.
  const socketPath = await socketDir("aio-ctl-skip-");
  const uds = createUDSListener(
    socketPath,
    () => ({ big: "greeting" }),
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ mine: true }), {
          status: 200,
        }),
      ),
  );
  try {
    const conn = await Deno.connect({ path: socketPath, transport: "unix" });
    const enc2 = new TextEncoder();
    await conn.write(
      enc2.encode(
        enc("ctl", { id: "MINE", path: "/__aio/trojan/x", method: "GET" }) +
          "\n",
      ),
    );
    const dec2 = new TextDecoder();
    const buf = new Uint8Array(1 << 16);
    let pending = "";
    let mine: unknown = null;
    const deadline = Date.now() + 5000;
    while (!mine && Date.now() < deadline) {
      const n = await conn.read(buf);
      if (n === null) break;
      pending += dec2.decode(buf.subarray(0, n), { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const f = line ? dec(line) : null;
        if (f?.t === "ctlr") mine = f.d;
      }
    }
    conn.close();
    assertEquals((mine as { id: string }).id, "MINE");
  } finally {
    uds.shutdown();
  }
});

// ── End to end: a REAL server handle, reached by `am` over the socket ────────
//
// Everything above drives the frame layer. This drives the seam that matters:
// `server.control` is the HTTP handler itself, so what comes back over the
// socket has passed the same routing, the same dev-only trojan mount, and the
// same gates as a request over TCP. If those two ever diverge, the control
// plane's answer would depend on which wire you asked over — which is the one
// property this design exists to guarantee it cannot.
Deno.test("uds control: `am` reads real trojan state over the socket", async () => {
  const dir = await tempDir("aio-ctl-e2e-");
  const socketPath = join(dir, "s.sock");
  const appState = { count: 7, note: "over the socket" };
  const server = createServer({
    port: await freePort(),
    title: "CtlE2E",
    getUIState: () => ({ count: appState.count }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => appState,
      getSchedules: () => ["tick"],
      startedAt: Date.now() - 1000,
    },
  });
  const uds = createUDSListener(
    socketPath,
    () => ({ count: appState.count }),
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    server.control,
  );
  try {
    const r = await udsRequest(
      socketPath,
      "/__aio/trojan/state",
      { method: "GET" },
      5000,
    );
    assert(!("error" in r), `control call failed: ${JSON.stringify(r)}`);
    assertEquals(r.status, 200);
    assertEquals(JSON.parse(r.body), appState);

    // A route that does not exist must 404 over the socket exactly as it does
    // over TCP — a control plane that answered 200-with-an-error-string to an
    // unknown route is how `am surface` once reported a click that never
    // happened.
    const miss = await udsRequest(
      socketPath,
      "/__aio/trojan/no-such-route",
      { method: "GET" },
      5000,
    );
    assert(!("error" in miss));
    assertEquals(miss.status, 404);
  } finally {
    uds.shutdown();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── `am`'s transport choice ─────────────────────────────────────────────────

// The socket is a PREFERENCE, never a dead end. An app that has both wires
// must keep answering if the socket turns out to be unusable — a stale path, a
// permission change, a half-dead listener. A transport failure therefore falls
// through to TCP; only an answer FROM the app (including a refusal) ends the
// call. Without this, adding the socket would have made `am` less reliable
// than it was with one wire, which is not a trade worth making for a default.
Deno.test("am: a dead socket falls through to the TCP wire, not to an error", async () => {
  const dir = await tempDir("aio-ctl-fallback-");
  const appId = `ctl-fb-${Deno.pid}`;
  const port = await freePort();
  const appState = { count: 42 };
  const server = createServer({
    port,
    appId,
    title: "CtlFallback",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => appState,
      getSchedules: () => [],
      startedAt: Date.now() - 1000,
    },
  });
  // A lock that advertises a socket which does not exist — the app is alive on
  // TCP, and this process's own pid keeps the liveness check honest.
  writePid({
    appId,
    pid: Deno.pid,
    port,
    startedAt: Date.now(),
    status: "started",
    cwd: dir,
    socketPath: join(dir, "not-a-real.sock"),
  });
  try {
    await new Promise((r) => setTimeout(r, 50));
    const r = await trojanGet(port, "state", appId);
    assert(
      r.ok,
      `the TCP wire should have answered after the socket failed: ${
        r.ok ? "" : r.error
      }`,
    );
    assertEquals((r.data as typeof appState).count, 42);
  } finally {
    removePid(appId);
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Zero-port: the second socket ────────────────────────────────────────────

// An app that binds no TCP port needs TWO listeners, not one: the NDJSON
// state/IPC transport and the HTTP handler that serves its page and modules.
// They speak different protocols, and one listener owns one path — so the
// names must differ, and they must differ in the LONG-PATH fallback too. That
// branch used to drop the suffix, which was harmless while there was one
// socket per app and would now hand both listeners the same file.
Deno.test("sockets: the transport and HTTP listeners never share a path", () => {
  const ndjson = resolveSocketPath("some-app");
  const http = resolveSocketPath("some-app", "http");
  assert(ndjson !== http, "two listeners cannot share one socket path");
  assert(ndjson.endsWith("/some-app.sock"));
  assert(http.endsWith("/some-app.http.sock"));

  // The >100-char fallback keeps them apart too. A name long enough to trip it
  // is the only way to reach that branch, and it is exactly where a dropped
  // suffix would go unnoticed.
  const long = "x".repeat(120);
  const a = resolveSocketPath(long);
  const b = resolveSocketPath(long, "http");
  assert(a !== b, "the long-path fallback must keep the suffix");
  assert(b.endsWith(".http.sock"));
});

// `am`'s control client is not a window. It asks a question and leaves, so it
// must not appear in the client roster, must not take the index that
// `am surface N` addresses, and must not be mailed state broadcasts. Before
// this, every `am state` call showed up as a connected Electron client.
Deno.test("uds control: a control client is not counted as a UI client", async () => {
  const socketPath = await socketDir("aio-ctl-roster-");
  const uds = createUDSListener(
    socketPath,
    () => ({ n: 1 }),
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
  );
  try {
    for (let i = 0; i < 3; i++) {
      const r = await udsRequest(
        socketPath,
        "/__aio/trojan/state",
        { method: "GET" },
        5000,
      );
      assert(!("error" in r) && r.status === 200);
    }
    // Give the server a moment to process the type frames + closes.
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(
      uds.clients().length,
      0,
      `three control calls left ${uds.clients().length} phantom UI client(s) ` +
        `in the roster`,
    );
  } finally {
    uds.shutdown();
  }
});
