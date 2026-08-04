// Regression tests for the remaining a field report/a field report fixes that had none — each pins
// the behaviour at the seam the fix actually changed.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// ── trojan dispatch strips payload._origin, like the WS and UDS paths ─────

Deno.test("trojan: a forged payload._origin cannot reach the access predicate", async () => {
  const { cell, aio } = await import("../mod.ts");
  const { freePort } = await import("../src/testing/server-test.ts");
  const seen: unknown[] = [];
  const vault = cell("trojanorigin", {
    state: { wiped: 0 },
    access: (_u, method) => {
      seen.push(method);
      return true; // record what the gate was asked about
    },
    methods: {
      wipe(s: { wiped: number }) {
        s.wiped += 1;
      },
    },
  });
  const port = freePort();
  const app = await aio.run({
    cells: [vault],
    appId: `test-trojan-origin-${Deno.pid}`,
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  try {
    // The REAL route + the mandatory X-AIO header. The first version of this
    // test POSTed to `/__aio/dispatch` (404) without the header (403), so the
    // assertion passed unconditionally — a vacuous green over the exact
    // surface it claimed to pin. `seen` must prove the dispatch HAPPENED
    // (the gate was asked) before proving what it was asked about.
    const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({
        type: "trojanorigin:wipe",
        payload: { _origin: "read" }, // the spoof
      }),
    });
    assertEquals(r.status, 200, "the trojan dispatch must actually run");
    await r.body?.cancel();
    assert(
      seen.includes("wipe"),
      `the gate must be asked about the real method: ${JSON.stringify(seen)}`,
    );
    assert(
      !seen.includes("read"),
      `the gate must never be asked about a client-supplied origin: ${
        JSON.stringify(seen)
      }`,
    );
  } finally {
    await app.close();
  }
});

// ── the auth-fail budget map is bounded ──────────────────────────────────

Deno.test("auth budget: per-key history is capped and expired keys are swept", async () => {
  const { recordAuthFail, authFailBudgetExceeded, _resetAuthFails } =
    await import("../src/server/server-auth.ts");
  _resetAuthFails();
  try {
    // One key, far more failures than the cap: the entry must not grow without
    // bound just because an attacker keeps trying.
    for (let i = 0; i < 500; i++) recordAuthFail("1.2.3.4", "probe");
    assertEquals(authFailBudgetExceeded("1.2.3.4"), true, "still exceeded");

    // Many unique keys (a rotating botnet) — the sweep drops the expired ones
    // instead of retaining one entry per address forever.
    const old = Date.now() - 6 * 60_000; // outside the 5m window
    for (let i = 0; i < 400; i++) recordAuthFail(`10.0.0.${i}`, "probe", old);
    assertEquals(
      authFailBudgetExceeded("10.0.0.1"),
      false,
      "an expired key carries no budget",
    );
  } finally {
    _resetAuthFails();
  }
});

// ── build: the android dev URL is validated, not interpolated blindly ─────

Deno.test("android: an injectable --android-dev-url is refused", async () => {
  const { safeDevUrl } = await import("../src/build/build-android.ts");
  const injection =
    'http://x"); Runtime.getRuntime().exec("touch /tmp/pwned"); //';

  // Whatever the outcome, the raw injection must never reach the Kotlin source.
  let embedded: string | null = null;
  try {
    embedded = safeDevUrl(injection);
  } catch { /* refused outright — also fine */ }
  if (embedded !== null) {
    assert(
      !embedded.includes('"'),
      `a quote would close the Kotlin string: ${embedded}`,
    );
    assert(!embedded.includes("\n"), "a newline would end the statement");
    assert(!embedded.includes("exec("), `the payload survived: ${embedded}`);
  }

  // Non-URLs and non-http schemes are refused loudly, not silently emitted.
  for (
    const bad of ["not a url", "file:///etc/passwd", "javascript:alert(1)"]
  ) {
    let threw = false;
    try {
      safeDevUrl(bad);
    } catch (e) {
      threw = true;
      assertStringIncludes(String(e), "--android-dev-url");
    }
    assert(threw, `"${bad}" must be refused`);
  }

  // A real dev URL passes through, normalised.
  assertEquals(safeDevUrl("http://10.0.2.2:8000"), "http://10.0.2.2:8000/");
});

// ── ship: paths are joined, not concatenated ─────────────────────────────

Deno.test("ship: collectSources builds paths with join (no mixed separators)", async () => {
  const src = await Deno.readTextFile("src/build/ship.ts");
  assert(
    !/`\$\{d\}\/\$\{e\.name\}`/.test(src),
    "hardcoded '/' concatenation is a latent Windows bug — use join()",
  );
  assertStringIncludes(src, 'import { join } from "@std/path"');
});
