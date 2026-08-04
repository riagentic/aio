// Who is `am` actually talking to?
//
// Three failures with one shape — am decided WHICH app a command hits from
// something other than the app itself:
//
//  1. `verifyInstance` guarded `trojanGet` only. Every READ was checked against
//     the port's own /__aio/health appId while every MUTATION — shutdown,
//     dispatch, sql, snapshot, tt, trigger — went through unchecked, so a
//     stale `--port` could dispatch actions or run SQL into whatever app held
//     that port. Backwards: the write is the one that cannot be undone.
//  2. `am stop --port=N` derived the appId from the CWD, so in a two-app repo
//     it addressed a lock that did not exist, fell back to the main port, and
//     printed the bare "app not running" — discarding the real error — while
//     the app on N kept running. Under `--expose` the main port is TLS and the
//     plain-HTTP control port lives only in the lock file, so the `--port=N`
//     the message recommended could not work at all.
//  3. "app not running (no lock file)" named neither the directory searched
//     nor AIO_APPS_DIR, the env var that decides it — two shells genuinely
//     look in different places and the message was true in both.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import {
  _resetInstanceVerify,
  httpGet,
  probePort,
  trojanGet,
  trojanPost,
} from "../src/am/am-http.ts";
import { noLockMessage, resolveStopTarget } from "../src/am/am-cmd-process.ts";
import { lockDir } from "../src/server/single-instance-lock.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { parseGlobalFlags } from "../src/am/am-utils.ts";
import { compareValue } from "../src/am/am-cmd-state.ts";

/** Pin AIO_APPS_DIR (and therefore lockDir) to a throwaway root for the whole
 *  test, and RESTORE whatever the suite had — never delete it. */
async function withAppsDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const prev = Deno.env.get("AIO_APPS_DIR");
  const root = await Deno.makeTempDir({ prefix: "aio-am-target-" });
  Deno.env.set("AIO_APPS_DIR", root);
  try {
    return await fn(root);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

const ledger = () =>
  cell("ledger", {
    state: { rows: [] as string[] },
    methods: {
      add(s: { rows: string[] }, p: { row: string }) {
        s.rows.push(p.row);
      },
    },
  });

// ── 1. mutations are gated at least as hard as reads ────────────────

Deno.test({
  name:
    "am: a MUTATING trojanPost against a port owned by a DIFFERENT app is refused",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withAppsDir(async () => {
      _resetAioRuntime();
      _resetInstanceVerify();
      await using srv = await testServer({
        cells: [ledger()],
        appId: "prod-ledger",
      });
      const port = srv.port;

      // The e2e's sandbox app, aimed (stale) at the production port.
      const bad = await trojanPost(
        port,
        "dispatch",
        { type: "ledger:add", payload: { args: [{ row: "TEST-ROW" }] } },
        "e2e-sandbox",
      );
      assert(!bad.ok, "a write to another app's port must be REFUSED");
      const err = (bad as { error: string }).error;
      assertStringIncludes(err, 'answers as app "prod-ledger"');
      assertStringIncludes(err, 'not "e2e-sandbox"');

      // …and nothing reached the app: the refusal is before the call.
      const before = await trojanGet(port, "state", "prod-ledger");
      assert(before.ok, JSON.stringify(before));
      assert(
        !JSON.stringify(before.data).includes("TEST-ROW"),
        `the refused write must not have landed: ${
          JSON.stringify(before.data)
        }`,
      );

      // A read-only dump of another app's data is refused on the same terms.
      const snap = await httpGet(port, "/__aio/snapshot", "e2e-sandbox");
      assert(!snap.ok, "httpGet must be gated too");

      // The right app is unaffected — the gate refuses, it does not break.
      const good = await trojanPost(
        port,
        "dispatch",
        { type: "ledger:add", payload: { args: [{ row: "REAL-ROW" }] } },
        "prod-ledger",
      );
      assert(good.ok, JSON.stringify(good));
      const after = await trojanGet(port, "state", "prod-ledger");
      assert(after.ok, JSON.stringify(after));
      assertStringIncludes(JSON.stringify(after.data), "REAL-ROW");
      _resetInstanceVerify();
    });
  },
});

Deno.test({
  name:
    "am: the identity verdict expires — a port outlives the app that had it",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withAppsDir(async () => {
      _resetInstanceVerify();
      // One port, two apps in sequence — the amui shape (one long-lived module
      // watching apps restart). A permanent cache would refuse the app that is
      // actually there, quoting one that exited.
      const port = freePort();
      _resetAioRuntime();
      {
        await using _a = await testServer({
          cells: [ledger()],
          appId: "first-owner",
          port,
        });
        assert((await trojanGet(port, "state", "first-owner")).ok);
      }
      _resetAioRuntime();
      await using _b = await testServer({
        cells: [ledger()],
        appId: "second-owner",
        port,
      });
      // No reset in between: only the TTL may clear the stale verdict.
      await new Promise((r) => setTimeout(r, 2200));
      const r = await trojanGet(port, "state", "second-owner");
      assert(
        r.ok,
        `stale identity must not refuse the live app: ${JSON.stringify(r)}`,
      );
      _resetInstanceVerify();
    });
  },
});

// ── 2. `am stop --port=N` ───────────────────────────────────────────

Deno.test({
  name: "am stop --port=N IDENTIFIES the app on that port (not the cwd's app)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withAppsDir(async () => {
      _resetAioRuntime();
      _resetInstanceVerify();
      await using srv = await testServer({
        cells: [ledger()],
        appId: "port-owner",
      });
      // No --app, no lock file: pre-fix this resolved the appId from the CWD's
      // deno.json (the OTHER app in a two-app repo) and shut down nothing.
      const t = await resolveStopTarget({ port: srv.port });
      assert(t.ok, JSON.stringify(t));
      assertEquals(t.target.appId, "port-owner");
      assertEquals(t.target.port, srv.port);

      // An explicit --app that contradicts the port is a refusal, not a guess.
      const clash = await resolveStopTarget({
        port: srv.port,
        app: "some-other-app",
      });
      assert(!clash.ok, "a --app/--port contradiction must be refused");
      assertStringIncludes(clash.error, '"port-owner"');
      _resetInstanceVerify();
    });
  },
});

Deno.test("am stop --port=N on a dead port reports the REAL cause, not 'app not running'", async () => {
  await withAppsDir(async () => {
    const dead = freePort(); // bound, then released — nothing listens there
    const t = await resolveStopTarget({ port: dead, app: "ghost" });
    assert(!t.ok);
    assertStringIncludes(t.error, `nothing is listening on port ${dead}`);
    assert(
      t.error !== "app not running",
      "the specific error must not be discarded for the bare literal",
    );
  });
});

Deno.test({
  name:
    "am stop --port=N against a TLS port says so — and points at --app, the path that works",
  // openssl generates the self-signed cert; skip where it is absent.
  ignore: !(() => {
    try {
      return new Deno.Command("openssl", {
        args: ["version"],
        stdout: "null",
        stderr: "null",
      })
        .outputSync().success;
    } catch {
      return false;
    }
  })(),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withAppsDir(async (root) => {
      const { loadOrCreateCert } = await import("../src/server/tls.ts");
      const { cert, key } = await loadOrCreateCert(join(root, "tls"));
      const port = freePort();
      const ac = new AbortController();
      const server = Deno.serve(
        { port, cert, key, signal: ac.signal, onListen: () => {} },
        () => new Response("ok"),
      );
      try {
        // The --expose shape: https on the main port, and the plain-HTTP
        // trojan control port recorded ONLY in the lock file.
        assertEquals((await probePort(port)).kind, "tls");
        const t = await resolveStopTarget({ port, app: "exposed-app" });
        assert(!t.ok, "a TLS port cannot serve the plain-HTTP control call");
        assertStringIncludes(t.error, "speaks TLS");
        assertStringIncludes(t.error, "--app=");
        assertStringIncludes(t.error, lockDir());
      } finally {
        ac.abort();
        await server.finished;
      }
    });
  },
});

// ── 3. "no lock file" names where it looked ─────────────────────────

Deno.test("am: the no-lock-file message names the appId, the lock dir, and AIO_APPS_DIR", async () => {
  await withAppsDir(async (root) => {
    const msg = noLockMessage("ghost-app");
    assertStringIncludes(msg, "ghost-app");
    assertStringIncludes(msg, lockDir());
    assertStringIncludes(msg, `AIO_APPS_DIR=${root}`);
    assertStringIncludes(msg, "am instances");

    // …and it is the message `am stop` actually prints.
    const t = await resolveStopTarget({ app: "ghost-app" });
    assert(!t.ok);
    assertEquals(t.error, msg);
  });
});

Deno.test("am: the no-lock-file message says AIO_APPS_DIR is unset when it is", () => {
  const prev = Deno.env.get("AIO_APPS_DIR");
  try {
    Deno.env.delete("AIO_APPS_DIR");
    assertStringIncludes(noLockMessage("ghost-app"), "AIO_APPS_DIR=unset");
  } finally {
    if (prev !== undefined) Deno.env.set("AIO_APPS_DIR", prev);
  }
});

// ── 4. numeric-flag stragglers ──────────────────────────────────────

Deno.test("am: `-c<n>` short form — a non-numeric index is an ERROR, not a positional arg", () => {
  assertEquals(parseGlobalFlags(["surface", "-c2"]).flags.client, 2);
  const bad = parseGlobalFlags(["surface", "-c2x"]);
  assert(bad.flags.error, "an unreadable -c must be reported, never re-routed");
  assertStringIncludes(bad.flags.error!, "-c");
  assertEquals(bad.args, [], "and never leak into the positional args");
});

Deno.test("am expect: an ordering op on a non-number says so instead of failing the assertion", () => {
  const r = compareValue(5, "gt", "1O", true); // letter O, a real typo
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason, "needs numbers");
  assertStringIncludes(r.reason, "expected");
  const missing = compareValue(undefined, "lt", 5, false);
  assertEquals(missing.ok, false);
  assertStringIncludes(missing.reason, "actual");
  // Real numbers still compare, in every form a CLI hands them over.
  assertEquals(compareValue("10", "gt", 5, true).ok, true);
  assertEquals(compareValue(5, "gte", 5, true).ok, true);
});
