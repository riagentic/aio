// Regression tests for the alpha68 adversarial audit. Every case here was a
// WORKING exploit before the fix beside it — the reproduction is the test, so
// a refactor that reopens the hole is a red gate rather than a field report.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createServer } from "../src/server/server.ts";
import {
  _resetAuthFails,
  _resetHostWarnings,
  _resetMachineHostname,
  hostAllowed,
  hostRefusal,
} from "../src/server/server-auth.ts";
import { _exposeOf, _hostIsExposed } from "../src/server/aio.ts";
import { freePort } from "../src/testing/server-test.ts";
import { filterPatchesByStrategy } from "../src/state/state-filter.ts";
import { REPORT_LIMITS } from "../src/server/report.ts";
import type { Patch } from "immer";

const BASE_CFG = {
  title: "sec",
  getUIState: () => ({}),
  dispatch: () => {},
  baseDir: new URL("../examples", import.meta.url).pathname,
  debug: () => {},
};

/** A raw HTTP/1.1 request — `fetch()` refuses to set `Host`, so the ONE header
 *  a DNS-rebinding attack turns on cannot be exercised through it. Every
 *  browser sends it; a test that cannot set it proves nothing about the gate. */
async function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`).join("");
  await conn.write(
    new TextEncoder().encode(
      `GET ${path} HTTP/1.1\r\n${head}Connection: close\r\n\r\n`,
    ),
  );
  const chunks: Uint8Array[] = [];
  const tmp = new Uint8Array(65536);
  while (true) {
    const n = await conn.read(tmp);
    if (n === null) break;
    chunks.push(tmp.slice(0, n));
  }
  try {
    conn.close();
  } catch { /* peer closed first */ }
  const text = new TextDecoder().decode(
    new Uint8Array(chunks.flatMap((c) => [...c])),
  );
  const status = Number(text.split(" ")[1] ?? 0);
  return { status, body: text };
}

// ── 1. DNS rebinding into the dev control plane ──────────────────────────────

Deno.test("host gate: a foreign Host cannot read raw state from the trojan", async () => {
  const port = freePort();
  const h = createServer({
    ...BASE_CFG,
    port,
    trojan: {
      getState: () => ({ vault: { apiKey: "SUPER-SECRET" } }),
      getSchedules: () => [],
      startedAt: Date.now(),
    },
  } as never);
  try {
    // THE exploit: a tab on evil.example.com whose DNS flips to 127.0.0.1 is
    // same-origin with the app and needs no credential in public mode.
    const evil = await rawGet(port, "/__aio/trojan/state", {
      Host: "evil.example.com",
      Origin: "http://evil.example.com",
    });
    assertEquals(evil.status, 403);
    assert(
      !evil.body.includes("SUPER-SECRET"),
      "raw state leaked to a rebound host",
    );
    assertStringIncludes(evil.body, "allowedOrigins");

    // …and every name the app really answers to still works.
    for (
      const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
    ) {
      const ok = await rawGet(port, "/__aio/trojan/state", { Host: host });
      assertEquals(ok.status, 200, `legitimate Host ${host} was refused`);
    }
    // An IP LITERAL is the load-bearing allowance: it cannot be produced by
    // DNS, so `--expose` (LAN IPs, share links) is untouched.
    const lan = await rawGet(port, "/", { Host: `192.168.1.50:${port}` });
    assertEquals(lan.status, 200);
  } finally {
    await h.shutdown();
  }
});

Deno.test("host gate: the whole HTTP surface is behind it, not just the trojan", async () => {
  const port = freePort();
  const h = createServer({ ...BASE_CFG, port } as never);
  try {
    for (const path of ["/", "/ws", "/__aio/health", "/__aio/snapshot"]) {
      const r = await rawGet(port, path, { Host: "evil.example.com" });
      assertEquals(r.status, 403, `${path} answered a foreign Host`);
    }
  } finally {
    await h.shutdown();
  }
});

Deno.test("host gate: allowedOrigins is the named way back in (reverse proxy)", async () => {
  const port = freePort();
  const h = createServer({
    ...BASE_CFG,
    port,
    allowedOrigins: ["app.example.com"],
  } as never);
  try {
    assertEquals(
      (await rawGet(port, "/", { Host: "app.example.com" })).status,
      200,
    );
    assertEquals(
      (await rawGet(port, "/", { Host: "other.example.com" })).status,
      403,
    );
  } finally {
    await h.shutdown();
  }
});

Deno.test("hostAllowed: the rule, unit by unit", () => {
  _resetMachineHostname();
  const o = { bindHost: "127.0.0.1" };
  // No Host at all — a non-browser client; there is no name to rebind.
  assert(hostAllowed(null, o));
  assert(hostAllowed("", o));
  // IP literals can never come from DNS.
  assert(hostAllowed("127.0.0.1:8000", o));
  assert(hostAllowed("10.4.0.9", o));
  assert(hostAllowed("[fe80::1]:3000", o));
  // Loopback names.
  assert(hostAllowed("localhost:1234", o));
  assert(hostAllowed("app.localhost", o));
  // Foreign domains, in every spelling an attacker would reach for.
  assert(!hostAllowed("evil.example.com", o));
  assert(!hostAllowed("EVIL.example.com:8000", o));
  assert(!hostAllowed("localhost.evil.com", o));
  assert(!hostAllowed("127.0.0.1.evil.com", o));
  // The bind host, and explicit allowances (bare, host:port and full origin).
  assert(hostAllowed("app.example.com", { bindHost: "app.example.com" }));
  assert(hostAllowed("a.example.com", { allowedOrigins: ["a.example.com"] }));
  assert(
    hostAllowed("a.example.com:8443", {
      allowedOrigins: ["https://a.example.com:8443"],
    }),
  );
  assert(hostAllowed("anything.at.all", { allowedOrigins: ["*"] }));
  // A wildcard BIND is not a name — it must not accidentally allow one.
  assert(!hostAllowed("evil.example.com", { bindHost: "0.0.0.0" }));
});

// ── 2. trustProxyHeader read the attacker-controlled first hop ───────────────

Deno.test("trustProxyHeader: a forged first hop cannot buy a fresh abuse bucket", async () => {
  _resetAuthFails();
  const port = freePort();
  const h = createServer({
    ...BASE_CFG,
    port,
    users: { goodtoken: { id: "u", role: "user" } },
    trustProxyHeader: "x-forwarded-for",
  } as never);
  try {
    // nginx APPENDS, so element 0 is whatever the client sent. 30 bad tokens,
    // each with a fresh forged first hop, used to sail past the budget that
    // ten from one address trips.
    let last = 0;
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/?token=bad`, {
        headers: { "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` },
      });
      last = r.status;
      await r.body?.cancel();
    }
    assertEquals(
      last,
      429,
      "rotating the forged first hop evaded the auth-fail budget",
    );
  } finally {
    _resetAuthFails();
    await h.shutdown();
  }
});

Deno.test("trustProxyHeader: distinct RIGHTMOST hops still get distinct buckets", async () => {
  _resetAuthFails();
  const port = freePort();
  const h = createServer({
    ...BASE_CFG,
    port,
    users: { goodtoken: { id: "u", role: "user" } },
    trustProxyHeader: "x-forwarded-for",
  } as never);
  try {
    // The whole point of the header: real clients must not share one bucket.
    for (let i = 0; i < 9; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/?token=bad`, {
        headers: { "x-forwarded-for": `198.51.100.${i}` },
      });
      assertEquals(r.status, 401, "an unrelated client was throttled");
      await r.body?.cancel();
    }
  } finally {
    _resetAuthFails();
    await h.shutdown();
  }
});

// ── 3. `host` was a second, unguarded exposure decider ───────────────────────

Deno.test("_exposeOf: a non-loopback host IS exposure", () => {
  // The hole: `host: "0.0.0.0"` bound every interface while `expose` stayed
  // false — no key generated, no auto-TLS, no "this app is OPEN" warning.
  assertEquals(_exposeOf({}, { host: "0.0.0.0" }), true);
  assertEquals(_exposeOf({}, { host: "::" }), true);
  assertEquals(_exposeOf({}, { host: "192.168.1.10" }), true);
  assertEquals(_exposeOf({ host: "0.0.0.0" }, {}), true);
  // Loopback is not exposure, in any spelling.
  assertEquals(_exposeOf({}, { host: "127.0.0.1" }), false);
  assertEquals(_exposeOf({}, { host: "127.0.0.53" }), false);
  assertEquals(_exposeOf({}, { host: "localhost" }), false);
  assertEquals(_exposeOf({}, { host: "::1" }), false);
  assertEquals(_exposeOf({}, { host: "[::1]" }), false);
  assertEquals(_exposeOf({}, {}), false);
  // The original contract is untouched: CLI wins over config.
  assertEquals(_exposeOf({ expose: true }, {}), true);
  assertEquals(_exposeOf({}, { expose: true }), true);
  // An unclassifiable name fails CLOSED — loud, not quiet.
  assertEquals(_hostIsExposed("some-host.lan"), true);
});

// ── 4. the app key was written to a world-readable log ───────────────────────

Deno.test("logs: the app log and its directory are owner-only", async () => {
  if (Deno.build.os === "windows") return; // no POSIX mode
  const { AioLogger } = await import("../src/diagnostics/logger-core.ts");
  const dir = await Deno.makeTempDir();
  // A loose directory is the realistic case — $HOME is 0755 on stock distros,
  // and the log used to land at whatever the umask allowed (0664 here).
  await Deno.chmod(dir, 0o755);
  const logger = new AioLogger({ dir, level: "info", console: false });
  await logger.init();
  logger.pub("info", "test", "share: https://host/?token=THE-APP-KEY");
  await logger.flush();
  const st = await Deno.stat(logger.path("app"));
  assertEquals(
    (st.mode ?? 0) & 0o777,
    0o600,
    "the app log carries share links and boot secrets — it must be owner-only",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("app dirs: home, data and logs are all 0700", async () => {
  if (Deno.build.os === "windows") return;
  const { appDirs, ensureAppDirs } = await import("../src/server/app-dirs.ts");
  const base = await Deno.makeTempDir();
  const dirs = appDirs("sec-dirs-test", `${base}/home`);
  ensureAppDirs(dirs);
  for (const d of [dirs.home, dirs.data, dirs.logs]) {
    const st = await Deno.stat(d);
    assertEquals((st.mode ?? 0) & 0o777, 0o700, `${d} is not owner-only`);
  }
  await Deno.remove(base, { recursive: true });
});

// ── 6. feedback.report() was anonymous, unrated and uncapped ─────────────────

Deno.test("feedback: report() is rate-limited, and says why", async () => {
  const { createFeedbackCell, installFeedbackRuntime, _resetFeedbackRate } =
    await import("../src/state/feedback-cell.ts");
  const { bootCells } = await import("../src/cell-test.ts");
  const fb = createFeedbackCell();
  let captures = 0;
  _resetFeedbackRate();
  installFeedbackRuntime({
    capture: () => {
      captures++;
      return Promise.resolve({
        id: String(captures),
        path: "/tmp/x",
        createdAt: new Date().toISOString(),
        delivered: false,
      });
    },
    count: () => Promise.resolve(captures),
  });
  // `FeedbackCell` is a cell REF; bootCells takes defs. The two resolve
  // through different module identities here, so the cast is the honest bridge.
  const h = await bootCells([fb as never]);
  try {
    // Anonymous, unrated and uncapped: every call serialized app state to disk
    // AND POSTed it, so anyone who could load the page had a remote disk-fill
    // with no knob an author could turn.
    for (let i = 0; i < 8; i++) await fb.report(`report ${i}`);
    await h.settle();
    assert(captures <= 5, `rate limit did not hold (${captures} captures)`);
    assertStringIncludes(String(fb.error), "too many reports");
  } finally {
    h.dispose();
    installFeedbackRuntime(null);
    _resetFeedbackRate();
  }
});

Deno.test("report: body is capped and a hidden field never reaches the report", async () => {
  const { buildReport } = await import("../src/server/report.ts");
  const r = await buildReport({
    kind: "user",
    title: "t",
    body: "x".repeat(REPORT_LIMITS.bodyChars + 5000),
    id: "fixed",
  }, {
    appId: "a",
    appVersion: "1",
    aioVersion: "1",
    dataDir: "/tmp",
    logsDir: "/tmp",
    exposed: false,
    persist: false,
    cells: ["vault"],
    getState: () => ({ vault: { shown: 1, apiKey: "SUPER-SECRET" } }),
    visible: {
      vault: {
        shown: { persisted: true, ui: true },
        apiKey: { persisted: true, ui: false },
      },
    },
  });
  assertEquals(r.body?.length, REPORT_LIMITS.bodyChars);
  assert(
    !JSON.stringify(r).includes("SUPER-SECRET"),
    'a field the app hides from clients ("visible") was serialized into a report',
  );
});

// ── 7. the smaller ones ──────────────────────────────────────────────────────

Deno.test("PUBLIC_HINT_RE: the exemption cannot be claimed by a substring", async () => {
  // `pubsubSecretKey` used to be silently exempted from the credential gate
  // because /pub(lic)?/i matched anywhere in the name.
  const src = await Deno.readTextFile(
    new URL("../src/server/aio-composition.ts", import.meta.url),
  );
  const line = src.split("\n").find((l) => l.includes("/(?:^|[_-])(?:pub|"));
  assert(line, "PUBLIC_HINT_RE moved — re-point this test at it");
  const re = new RegExp(line.trim().replace(/^\/|\/;$/g, ""));
  for (const k of ["pubKey", "publicKey", "owner_public_key", "PUB_KEY"]) {
    assert(re.test(k), `${k} should still be treated as public`);
  }
  for (
    const k of ["pubsubSecretKey", "republishedApiKey", "epubPassword"]
  ) {
    assert(!re.test(k), `${k} must NOT claim the public exemption`);
  }
});

Deno.test("include with a dot path: patches for that cell still flow", () => {
  // `include: ["profile.name"]` put the literal string in `fields`, which was
  // compared against the first path SEGMENT — never equal, so EVERY patch for
  // the cell was dropped and the field went stale after the first frame.
  const strategies = new Map([["u", "filter" as const]]);
  const fields = new Map([["u", {
    mode: "include" as const,
    fields: new Set<string>(),
    deepIncludes: [["profile", "name"]],
  }]]);
  const patch = (path: (string | number)[], value: unknown): Patch => ({
    op: "replace",
    path,
    value,
  });
  // A write to the included leaf survives.
  let out = filterPatchesByStrategy(
    [{ cell: "u", ops: [patch(["profile", "name"], "ada")] }],
    strategies,
    fields,
  );
  assertEquals(out?.[0]?.ops.length, 1);
  // A write to a SIBLING under the same head does not.
  out = filterPatchesByStrategy(
    [{ cell: "u", ops: [patch(["profile", "ssn"], "123")] }],
    strategies,
    fields,
  );
  assertEquals(out?.length, 0);
  // A replacement of the ancestor is PROJECTED, never sent whole.
  out = filterPatchesByStrategy(
    [{ cell: "u", ops: [patch(["profile"], { name: "ada", ssn: "123" })] }],
    strategies,
    fields,
  );
  assertEquals(out?.[0]?.ops[0]?.value, { name: "ada" });
  // An unrelated top-level field is still excluded.
  out = filterPatchesByStrategy(
    [{ cell: "u", ops: [patch(["balance"], 9)] }],
    strategies,
    fields,
  );
  assertEquals(out?.length, 0);
});

Deno.test("the auth-fail map is bounded under address rotation", async () => {
  const m = await import("../src/server/server-auth.ts");
  m._resetAuthFails();
  // Every entry is remote-fed and was only ever removed when the SAME key came
  // back — an attacker rotating addresses never comes back, so the map grew
  // without bound. (With the first-hop XFF bug, one client could drive this.)
  const now = Date.now();
  for (let i = 0; i < 12_000; i++) {
    m.recordAuthFail(`10.${(i >> 8) & 255}.${i & 255}.1`, "x", now);
  }
  // The bound must not cost the budget its meaning: a live attacker is still
  // over budget after the eviction pass.
  for (let i = 0; i < 10; i++) m.recordAuthFail("203.0.113.99", "x", now);
  assert(m.authFailBudgetExceeded("203.0.113.99", now));
  m._resetAuthFails();
});

// ── 5. the cell `access` gate was per-DISPATCHED cell, not per-AFFECTED cell ──

Deno.test("access escalation through listensTo is refused at compose time", async () => {
  const { cell } = await import("../mod.ts");
  const { composeCellsWiring } = await import(
    "../src/server/aio-composition.ts"
  );
  // The exploit: `vault` is admin-only, but it LISTENS to an ungated cell's
  // action — so any anonymous client calling `open.ping()` reduced `vault`.
  // The runtime gate only ever evaluated the rule of the cell named by the
  // action type's prefix, which is `open`, which has no rule.
  const open = cell("esc_open", {
    state: { n: 0 },
    methods: {
      ping(s: { n: number }) {
        s.n++;
      },
    },
  });
  const vault = cell("esc_vault", {
    state: { wiped: 0 },
    access: "admin",
    visible: "none",
    listensTo: { onPing: open.ping },
    methods: {
      onPing(s: { wiped: number }) {
        s.wiped++;
      },
    },
  });
  let threw: Error | null = null;
  try {
    composeCellsWiring({ cellEntries: [open, vault] } as never);
  } catch (e) {
    threw = e as Error;
  }
  assert(threw, "a gated cell listening to an ungated one booted anyway");
  assertStringIncludes(threw!.message, "access escalation through listensTo");
  assertStringIncludes(threw!.message, "esc_vault");
  assertStringIncludes(threw!.message, "esc_open");
  // The message must name BOTH ways out, or it is a wall rather than a gate.
  assertStringIncludes(threw!.message, "stronger");
});

Deno.test("a gated cell listening to a cell that is not booted is refused", async () => {
  const { cell } = await import("../mod.ts");
  const { composeCellsWiring } = await import(
    "../src/server/aio-composition.ts"
  );
  // Same hole, other shape: the runtime gate looks the rule up BY CELL NAME
  // from the action type's prefix, so an action prefixed with a cell this
  // server never booted resolves to no rule at all — while the gated listener
  // reduces it happily. A client can dispatch any type it likes.
  const vault = cell("unbooted_vault", {
    state: { hit: 0 },
    access: "admin",
    visible: "none",
    listensTo: ["ghost:bump"],
    methods: {},
  });
  let threw: Error | null = null;
  try {
    composeCellsWiring({ cellEntries: [vault] } as never);
  } catch (e) {
    threw = e as Error;
  }
  assert(threw, "a gated cell listening to an unbooted cell booted anyway");
  assertStringIncludes(threw!.message, "access escalation through listensTo");
  assertStringIncludes(threw!.message, "not booted here");
});

Deno.test("an equally-gated source is fine — the check is escalation, not listensTo", async () => {
  const { cell } = await import("../mod.ts");
  const { composeCellsWiring } = await import(
    "../src/server/aio-composition.ts"
  );
  const src = cell("eq_src", {
    state: { n: 0 },
    access: "admin",
    visible: "none",
    methods: {
      ping(s: { n: number }) {
        s.n++;
      },
    },
  });
  const sink = cell("eq_sink", {
    state: { seen: 0 },
    access: "admin",
    visible: "none",
    listensTo: { onPing: src.ping },
    methods: {
      onPing(s: { seen: number }) {
        s.seen++;
      },
    },
  });
  composeCellsWiring({ cellEntries: [src, sink] } as never); // must not throw
  // …and a STRICTER source is fine too: `false` never reaches the network.
  const strict = cell("eq_strict", {
    state: { n: 0 },
    access: false,
    visible: "none",
    methods: {
      ping(s: { n: number }) {
        s.n++;
      },
    },
  });
  const sink2 = cell("eq_sink2", {
    state: { seen: 0 },
    access: true,
    visible: "none",
    listensTo: { onPing: strict.ping },
    methods: {
      onPing(s: { seen: number }) {
        s.seen++;
      },
    },
  });
  composeCellsWiring({ cellEntries: [strict, sink2] } as never);
});

// ── 7a. the diagnostic surface was anonymous on an auth-flows app ────────────

Deno.test("auth app: health/metrics/vitals/error are not anonymous", async () => {
  const port = freePort();
  const h = createServer({
    ...BASE_CFG,
    port,
    users: { tok: { id: "u", role: "user" } },
    authFlows: { sessions: { onRevoked: () => () => {} } },
    getHealth: () => ({ status: "healthy", cells: { vault: 4096 } }),
  } as never);
  try {
    // `authFlows` makes the SHELL public so SignIn can render. It says nothing
    // about telemetry: these reported cell sizes, connected client ids and the
    // app's most recent error strings to anyone who asked.
    for (
      const p of [
        "/__aio/health",
        "/__aio/metrics",
        "/__aio/vitals",
        "/__aio/error",
      ]
    ) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      const body = await r.text();
      assertEquals(r.status, 401, `${p} answered an anonymous caller`);
      assertStringIncludes(body, "signed-in user");
      // …and the refusal names the door that IS open, so the fix nobody wants
      // (a credential in a monitoring config, forever, to answer "is it up")
      // is not the one people reach for.
      assertStringIncludes(body, "GET /");
      assertStringIncludes(body, "liveness");
    }
    // The shell itself stays public — that is the whole point of authFlows.
    const shell = await fetch(`http://127.0.0.1:${port}/`);
    assertEquals(shell.status, 200);
    await shell.body?.cancel();
  } finally {
    await h.shutdown();
  }
});

// The refusal reaches whoever made the request. The person who has to ACT on it
// is the operator — and they were reading a log that said nothing, so a
// reverse-proxied deployment failed as "users report Forbidden, nothing in the
// log". That is the shape that turns a one-line config fix into an afternoon.
Deno.test("a refused Host is reported on the SERVER, once, and bounded", () => {
  _resetHostWarnings();
  const said: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => said.push(a.map(String).join(" "));
  try {
    const opts = { bindHost: "0.0.0.0", allowedOrigins: [] as string[] };
    const req = (host: string) =>
      new Request("http://x/", { headers: { host } });
    // The operator's own log names the Host AND the one-line fix.
    assert(hostRefusal(req("evil.example"), undefined, opts));
    const first = said.join("\n");
    assertStringIncludes(first, "evil.example");
    assertStringIncludes(first, "allowedOrigins");
    assertStringIncludes(first, "rebinding");

    // A rebinding attempt is a LOOP. One line per Host, not per request.
    said.length = 0;
    for (let i = 0; i < 50; i++) {
      assert(hostRefusal(req("evil.example"), undefined, opts));
    }
    assertEquals(said, [], "the same Host must not be reported twice");

    // …and the set is attacker-chosen input, so it cannot grow without bound.
    said.length = 0;
    for (let i = 0; i < 200; i++) {
      hostRefusal(req(`h${i}.example`), undefined, opts);
    }
    assert(
      said.length < 200,
      `an unbounded warn set is a memory leak the attacker controls: ${said.length}`,
    );
  } finally {
    console.warn = orig;
    _resetHostWarnings();
  }
});
