// The LOCAL CONTROL CREDENTIAL — how `am`/amui prove they are the machine's
// owner to a locally running app's dev control plane (`/__aio/trojan/*`).
//
// The security fix that gated the trojan behind "same-machine + dev + (in
// per-user mode) an authenticated admin" was right, and it locked the toolchain
// out of every auth-enabled app: `am` has no account to log in as. The answer is
// a credential, not a hole — the app mints one per boot into its own 0700 data
// dir as 0600, so "can read this file" == "is the OS user who owns this app's
// data", the same boundary that makes the same-machine rule mean anything.
//
// Every test here fails against the pre-fix code.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _controlDirRefusal,
  appKeyPath,
  controlKeyPath,
  mintControlKey,
  readControlKey,
  removeControlKey,
} from "../src/server/app-key.ts";
import {
  armLocalControl,
  disarmLocalControl,
  LOCAL_CONTROL_HEADER,
  localControlAuthorized,
  trojanDenialForUserMode,
} from "../src/server/server-auth.ts";
import { handleTrojan } from "../src/server/server-trojan.ts";
import { clearPairing, currentPin } from "../src/server/pairing.ts";
import {
  _resetInstanceVerify,
  httpGet,
  resolveControlPort,
  trojanGet,
  trojanPost,
} from "../src/am/am-http.ts";
import { freePort } from "../src/testing/server-test.ts";

const WINDOWS = Deno.build.os === "windows";

/** Pin AIO_APPS_DIR at a temp dir so nothing touches the real home, and restore
 *  whatever was there. */
async function withAppsDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const prev = Deno.env.get("AIO_APPS_DIR");
  const dir = await Deno.makeTempDir();
  Deno.env.set("AIO_APPS_DIR", dir);
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    disarmLocalControl();
  }
}

const trojanReq = (key?: string, path = "/__aio/trojan/state") =>
  new Request(`http://127.0.0.1/${path.slice(1)}`, {
    headers: key === undefined ? {} : { [LOCAL_CONTROL_HEADER]: key },
  });

// ── The credential file ──────────────────────────────────────────────────────

Deno.test("control key: minted 0600 in the 0700 data dir, fresh at every boot", async () => {
  await withAppsDir(async () => {
    const appId = "ctl-mint";
    const a = mintControlKey(appId);
    assert(a.error === undefined, `mint must succeed: ${a.error}`);
    assertEquals(a.path, controlKeyPath(appId));
    assertEquals(a.key.length, 64, "256 bits, hex");

    const st = Deno.statSync(a.path);
    const dirSt = Deno.statSync(
      controlKeyPath(appId).replace(/.control\.key$/, ""),
    );
    if (!WINDOWS) {
      assertEquals((st.mode! & 0o777).toString(8), "600", "file is owner-only");
      assertEquals(
        (dirSt.mode! & 0o777).toString(8),
        "700",
        "data dir is owner-only",
      );
    }
    assertEquals(Deno.readTextFileSync(a.path).trim(), a.key);

    // Per BOOT: a copy taken from an earlier run must be dead.
    const b = mintControlKey(appId);
    assert(b.error === undefined);
    assert(b.key !== a.key, "every boot mints a new credential");
    if (!WINDOWS) {
      assertEquals(
        (Deno.statSync(b.path).mode! & 0o777).toString(8),
        "600",
        "an overwrite keeps 0600 (writeTextFile's mode applies at create only)",
      );
    }
    removeControlKey(appId);
    assertEquals(readControlKey(appId).key, undefined);
    return;
  });
});

Deno.test("control key: refuses a data dir other users can read", () => {
  // The pure rule, pinned. Reachable when the 0700 cannot be applied — a dir
  // owned by another uid, a read-only or permission-less mount.
  assertEquals(_controlDirRefusal("/d", 0o40700), null);
  assertEquals(_controlDirRefusal("/d", null), null, "Windows: no POSIX mode");
  for (const mode of [0o40750, 0o40755, 0o40777, 0o40701]) {
    const r = _controlDirRefusal("/d", mode);
    assert(r, `mode ${mode.toString(8)} must be refused`);
    assertStringIncludes(r, "not owner-only");
    assertStringIncludes(r, "chmod 700");
  }
});

Deno.test("control key: a leaked or foreign file is refused, loudly", async () => {
  if (WINDOWS) return;
  await withAppsDir(async () => {
    const appId = "ctl-perms";
    const r = mintControlKey(appId);
    assert(r.error === undefined);
    Deno.chmodSync(r.path, 0o644);
    const read = readControlKey(appId);
    assertEquals(read.key, undefined, "a world-readable credential is refused");
    assertStringIncludes(read.error!, "other local users can read");
    assertStringIncludes(read.error!, "delete it and restart");

    Deno.removeSync(r.path);
    const missing = readControlKey(appId);
    assertStringIncludes(missing.error!, "no local control credential");
    assertStringIncludes(missing.error!, controlKeyPath(appId));
    assertStringIncludes(missing.error!, "Restart the app in dev");
    return;
  });
});

Deno.test("control key: a production build mints nothing", async () => {
  await withAppsDir(async () => {
    const appId = "ctl-prod";
    armLocalControl({ appId, prod: true });
    let exists = true;
    try {
      Deno.statSync(controlKeyPath(appId));
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "no control secret exists in a prod build");
    // …and nothing is armed, so no header can open the control plane.
    assertEquals(localControlAuthorized(trojanReq("anything")), false);
    return;
  });
});

// ── The gate ─────────────────────────────────────────────────────────────────

Deno.test("trojan gate: the machine owner's credential opens the control plane", async () => {
  await withAppsDir(async () => {
    const appId = "ctl-gate";
    armLocalControl({ appId });
    const key = readControlKey(appId).key!;

    assertEquals(
      trojanDenialForUserMode("/__aio/trojan/state", undefined, trojanReq(key)),
      null,
      "the owner's credential is sufficient authority for the trojan",
    );
    // …and it outranks a non-admin app account, which is what it is: proof of
    // owning the app's data, not membership in the app.
    assertEquals(
      trojanDenialForUserMode(
        "/__aio/trojan/sql",
        { id: "u1", role: "user" },
        trojanReq(key),
      ),
      null,
    );
    return;
  });
});

Deno.test("trojan gate: no credential is still 401 — with a way forward", async () => {
  await withAppsDir(async () => {
    const appId = "ctl-gate-401";
    armLocalControl({ appId });

    const anon = trojanDenialForUserMode(
      "/__aio/trojan/state",
      undefined,
      trojanReq(),
    );
    assertEquals(anon?.status, 401);
    const body = await anon!.text();
    assertStringIncludes(body, LOCAL_CONTROL_HEADER);
    assertStringIncludes(body, controlKeyPath(appId));
    assertStringIncludes(body, "amui");

    // The old two-argument call site behaves exactly as before.
    assertEquals(
      trojanDenialForUserMode("/__aio/trojan/state", undefined)?.status,
      401,
    );
    assertEquals(
      trojanDenialForUserMode("/__aio/trojan/state", {
        id: "a",
        role: "admin",
      }),
      null,
    );
    return;
  });
});

Deno.test("trojan gate: a wrong credential is refused and named as stale", async () => {
  await withAppsDir(async () => {
    const appId = "ctl-gate-stale";
    armLocalControl({ appId });
    const real = readControlKey(appId).key!;

    // The near-miss must be built by CHANGING the last character, never by
    // substituting a fixed one: the key is hex, so `real.slice(0, -1) + "0"`
    // reconstructs the REAL key whenever it already ends in "0" — one run in
    // sixteen, where this test then failed claiming a correct credential had
    // been accepted. A security assertion that is wrong 6% of the time reads
    // as flakiness and gets ignored, which is worse than not having it.
    const lastChar = real.slice(-1);
    const nearMiss = real.slice(0, -1) + (lastChar === "0" ? "1" : "0");
    assert(nearMiss !== real, "the near-miss fixture must differ from the key");
    for (const bogus of ["", "x", nearMiss, real + "0"]) {
      const denial = trojanDenialForUserMode(
        "/__aio/trojan/state",
        undefined,
        trojanReq(bogus),
      );
      assertEquals(
        denial?.status,
        401,
        `"${bogus.slice(0, 8)}" must be refused`,
      );
    }
    const denial = trojanDenialForUserMode(
      "/__aio/trojan/state",
      undefined,
      trojanReq("deadbeef"),
    );
    const body = await denial!.text();
    assertStringIncludes(body, "minted fresh at every boot");
    assertStringIncludes(body, "AIO_APPS_DIR");
    return;
  });
});

Deno.test("trojan gate: an unarmed app accepts nothing, and disarm revokes", async () => {
  await withAppsDir(async () => {
    const appId = "ctl-disarm";
    armLocalControl({ appId });
    const key = readControlKey(appId).key!;
    assertEquals(localControlAuthorized(trojanReq(key)), true);

    disarmLocalControl(appId);
    assertEquals(
      localControlAuthorized(trojanReq(key)),
      false,
      "shutdown revokes the credential in memory…",
    );
    let exists = true;
    try {
      Deno.statSync(controlKeyPath(appId));
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "…and removes the file");
    assertEquals(
      trojanDenialForUserMode("/__aio/trojan/state", undefined, trojanReq(key))
        ?.status,
      401,
    );
    // Nothing armed: an empty/absent header must never satisfy an empty key set.
    assertEquals(localControlAuthorized(trojanReq("")), false);
    assertEquals(localControlAuthorized(trojanReq()), false);
    assertEquals(localControlAuthorized(undefined), false);
    return;
  });
});

Deno.test("trojan gate: the credential is scoped to /__aio/trojan/*", async () => {
  await withAppsDir(async () => {
    armLocalControl({ appId: "ctl-scope" });
    const key = readControlKey("ctl-scope").key!;
    // This decider only ever speaks for the control plane — /ws, /__aio/snapshot
    // and app routes are gated elsewhere and never consult it, so a credential
    // that satisfies it cannot widen anything else.
    for (const p of ["/ws", "/__aio/snapshot", "/", "/api/users"]) {
      assertEquals(
        trojanDenialForUserMode(p, undefined, trojanReq(key, p)),
        null,
        `${p} is not this gate's business`,
      );
    }
    return;
  });
});

// ── am presents it — and only where it belongs ───────────────────────────────

/** A stand-in app: records what `am` sent, and can pretend to be key-gated. */
function fakeApp(appId: string, opts: { gated?: boolean } = {}) {
  const seen: { path: string; headers: Headers }[] = [];
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, headers: req.headers });
      if (opts.gated && !req.headers.get("authorization")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.pathname === "/__aio/health") {
        return Response.json({ appId });
      }
      return Response.json({ ok: true });
    },
  );
  return { port, seen, close: () => server.shutdown() };
}

Deno.test("am: presents the control credential on the trojan, and nowhere else", async () => {
  await withAppsDir(async () => {
    const appId = "am-scope";
    const key = mintControlKey(appId).key!;
    _resetInstanceVerify();
    const app = fakeApp(appId);
    try {
      assert((await trojanGet(app.port, "state", appId)).ok);
      assert((await httpGet(app.port, "/__aio/vitals", appId)).ok);

      const trojan = app.seen.find((s) => s.path === "/__aio/trojan/state")!;
      assertEquals(
        trojan.headers.get(LOCAL_CONTROL_HEADER),
        key,
        "the control plane gets the operator's credential",
      );
      const vitals = app.seen.find((s) => s.path === "/__aio/vitals")!;
      assertEquals(
        vitals.headers.get(LOCAL_CONTROL_HEADER),
        null,
        "the app's own routes do NOT — this authorizes the control plane only",
      );
      // An OPEN app must not receive a Bearer token: in per-user mode a wrong
      // one is a failed LOGIN and would spend the operator's auth-fail budget.
      for (const s of app.seen) {
        assertEquals(s.headers.get("authorization"), null, s.path);
      }
    } finally {
      await app.close();
      _resetInstanceVerify();
    }
    return;
  });
});

Deno.test("am: presents the shared key only to an app that demands one", async () => {
  await withAppsDir(async () => {
    const appId = "am-keyed";
    mintControlKey(appId);
    Deno.writeTextFileSync(appKeyPath(appId), "the-shared-key\n");
    _resetInstanceVerify();
    const app = fakeApp(appId, { gated: true });
    try {
      const r = await trojanGet(app.port, "state", appId);
      assert(r.ok, `am must authenticate a keyed app: ${!r.ok && r.error}`);
      const trojan = app.seen.find((s) => s.path === "/__aio/trojan/state")!;
      assertEquals(
        trojan.headers.get("authorization"),
        "Bearer the-shared-key",
        "shared-key mode gates every route — the key is the credential there",
      );
    } finally {
      await app.close();
      _resetInstanceVerify();
    }
    return;
  });
});

Deno.test("am: a control-plane refusal explains itself", async () => {
  await withAppsDir(async () => {
    const appId = "am-diagnose";
    _resetInstanceVerify();
    const port = freePort();
    const server = Deno.serve(
      { port, hostname: "127.0.0.1", onListen: () => {} },
      (req) =>
        new URL(req.url).pathname === "/__aio/health"
          ? Response.json({ appId })
          : new Response("Unauthorized", { status: 401 }),
    );
    try {
      // No credential on disk: say why, and how to get one.
      const r = await trojanGet(port, "state", appId);
      assert(!r.ok);
      assertStringIncludes(r.error, "machine owner");
      assertStringIncludes(r.error, controlKeyPath(appId));
      assertStringIncludes(r.error, "Restart the app in dev");

      // A credential that the app rejects: say THAT, not the same thing.
      mintControlKey(appId);
      _resetInstanceVerify();
      const r2 = await trojanGet(port, "state", appId);
      assert(!r2.ok);
      assertStringIncludes(r2.error, "refused it");
      assertStringIncludes(r2.error, "AIO_APPS_DIR");
    } finally {
      await server.shutdown();
      _resetInstanceVerify();
    }
    return;
  });
});

// ── am pair ──────────────────────────────────────────────────────────────────

const pairDeps = (token?: string) =>
  ({
    dispatch: () => {},
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    port: 1,
    title: "t",
    token,
    expose: true,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      startedAt: Date.now(),
    },
    authInfo: { mode: "key", expose: true },
    getWsClients: () => [],
    sendToWsClient: () => ({ found: false as const }),
    getRecentErrors: () => [],
  }) as unknown as Parameters<typeof handleTrojan>[2];

Deno.test("am pair: a running keyed app issues a fresh single-use PIN", async () => {
  const req = new Request("http://127.0.0.1/__aio/trojan/pair", {
    method: "POST",
    headers: { "X-AIO": "1" },
  });
  const resp = await handleTrojan(
    "/__aio/trojan/pair",
    req,
    pairDeps("the-key"),
  )!;
  assertEquals(resp.status, 200);
  const body = await resp.json() as { pin: string; ttlSec: number };
  assert(/^\d{6}$/.test(body.pin), `six digits, got ${body.pin}`);
  assertEquals(body.ttlSec, 180);
  assertEquals(currentPin(), body.pin, "the app now holds exactly this PIN");

  // A second call REPLACES it — the point is regeneration without a restart.
  const again = await handleTrojan(
    "/__aio/trojan/pair",
    req,
    pairDeps("the-key"),
  )!;
  const body2 = await again.json() as { pin: string };
  assertEquals(currentPin(), body2.pin);
});

Deno.test("am pair: an app with no shared key says what to do instead", async () => {
  clearPairing();
  const resp = await handleTrojan(
    "/__aio/trojan/pair",
    new Request("http://127.0.0.1/__aio/trojan/pair", {
      method: "POST",
      headers: { "X-AIO": "1" },
    }),
    pairDeps(undefined),
  )!;
  assertEquals(resp.status, 400);
  const body = await resp.json() as { error: string };
  assertStringIncludes(body.error, "nothing to pair");
  assertStringIncludes(body.error, "auth: true");
  assertEquals(currentPin(), null, "no PIN was minted");
});

// ── End to end, through a real server ────────────────────────────────────────

Deno.test("am: reaches the control plane of a key-gated app", async () => {
  const PORT = freePort();
  await withAppsDir(async () => {
    const { cell, aio } = await import("../mod.ts");
    const c = cell("keyed", { state: { n: 7 }, methods: {} });
    const appId = `test-ctl-key-${Deno.pid}`;
    const app = await aio.run({
      cells: [c],
      appId,
      client: "server-only",
      persist: false,
      key: true,
      expose: true,
      // The lock file is how `am` finds the plain-HTTP control port that TLS
      // (automatic under --expose) moves the trojan onto — exactly as a real
      // app started by `am`/`deno task dev` records it.
      singleton: true,
      port: PORT,
      baseDir: await Deno.makeTempDir(),
    });
    _resetInstanceVerify();
    try {
      // --expose puts TLS on the main port; the plain-HTTP control listener is
      // recorded in the lock file, which is how `am` finds it.
      const ctrl = resolveControlPort(PORT, appId);
      // Anonymous: the key gates every route, control plane included.
      const anon = await fetch(`http://127.0.0.1:${ctrl}/__aio/trojan/state`);
      await anon.body?.cancel();
      assertEquals(
        anon.status,
        401,
        "an anonymous caller must still be refused",
      );

      // `am`: reads the app's own key out of the 0700 data dir and presents it.
      const r = await trojanGet(PORT, "state", appId);
      assert(r.ok, `am must reach a keyed app's trojan: ${!r.ok && r.error}`);
      assertEquals((r.data as { keyed: { n: number } }).keyed.n, 7);

      // …and `am pair` mints a code on the live app, no restart.
      const p = await trojanPost(PORT, "pair", undefined, appId);
      assert(p.ok, `am pair must work: ${!p.ok && p.error}`);
      assertEquals(currentPin(), (p.data as { pin: string }).pin);
    } finally {
      _resetInstanceVerify();
      await app.close();
    }
    return;
  });
});
