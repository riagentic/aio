// am instance identity + one-knob isolation (a field report: a
// sandboxed e2e's `am --port=N` silently reached the PRODUCTION instance and
// wrote test rows into a live leaderboard while every assertion passed).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import {
  _resetInstanceVerify,
  trojanGet,
  verifyInstance,
} from "../src/am/am-http.ts";
import { lockDir } from "../src/server/single-instance-lock.ts";

Deno.test({
  name: "am refuses a port that answers as a DIFFERENT app",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    _resetInstanceVerify();
    const c = cell("identity-app", { state: { n: 0 }, methods: {} });
    await using srv = await testServer({ cells: [c], appId: "identity-app" });
    const port = Number(new URL(srv.url).port);

    // The right app: verification passes, calls flow.
    assertEquals(await verifyInstance(port, "identity-app"), null);
    const ok = await trojanGet(port, "state", "identity-app");
    assert(ok.ok, JSON.stringify(ok));

    // The WRONG expectation: refused loudly, before any trojan call.
    _resetInstanceVerify();
    const bad = await trojanGet(port, "state", "some-other-app");
    assert(!bad.ok, "must refuse");
    const err = (bad as { error: string }).error;
    assert(err.includes('answers as app "identity-app"'), err);
    assert(err.includes('not "some-other-app"'), err);
    _resetInstanceVerify();
  },
});

Deno.test("lockDir scopes with AIO_APPS_DIR — one env var isolates lock+socket too", () => {
  const prev = Deno.env.get("AIO_APPS_DIR");
  try {
    Deno.env.set("AIO_APPS_DIR", "/tmp/aio-iso-test-a");
    const a = lockDir();
    Deno.env.set("AIO_APPS_DIR", "/tmp/aio-iso-test-b");
    const b = lockDir();
    Deno.env.delete("AIO_APPS_DIR");
    const plain = lockDir();
    assert(a !== b, `different roots, different lock dirs: ${a}`);
    assert(a !== plain && b !== plain, "scoped dirs differ from the default");
    assert(a.includes("aio-"), a);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
  }
});
