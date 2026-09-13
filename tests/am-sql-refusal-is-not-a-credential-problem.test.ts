// `am sql "delete from kv"` answered with the route's own refusal — "trojan
// SQL is read-only" — and then two paragraphs diagnosing a CREDENTIAL problem:
// a stale control key, a shared-key file to delete. Every 401/403 was read as
// an auth failure, and a 403 from a route that had already let am in is not
// one. The reader was sent to fix the wrong thing. Measured by a hunter
// running `am` as a user; pinned here against a real app over the trojan.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import {
  _resetInstanceVerify,
  isAuthRefusal,
  trojanPost,
} from "../src/am/am-http.ts";

const APP = "am-sql-refusal-app";

Deno.test({
  name: "am sql: a read-only refusal carries no credential diagnosis",
  async fn() {
    _resetInstanceVerify();
    await using srv = await testServer({
      cells: [cell("am-sql-refusal-c", { state: { n: 0 }, methods: {} })],
      appId: APP,
      persist: true, // the sql route needs a database to refuse a write to
    });
    const r = await trojanPost(
      srv.port,
      "sql",
      { query: "delete from kv" },
      APP,
    );
    assert(!r.ok, "a DELETE through the trojan was accepted");
    assertStringIncludes(r.error, "read-only");
    for (const wrong of ["control credential", "control plane", "shared key"]) {
      assert(
        !r.error.includes(wrong),
        `a route refusal was diagnosed as a credential problem:\n${r.error}`,
      );
    }
  },
});

Deno.test("isAuthRefusal: who wrote the body decides a 403", () => {
  assertEquals(isAuthRefusal(401, '{"error":"x"}'), true);
  assertEquals(isAuthRefusal(401, "Unauthorized"), true);
  // The auth gates answer in plain text.
  assertEquals(
    isAuthRefusal(
      403,
      'Forbidden — /__aio/trojan/* is the raw-state control plane and requires role "admin"',
    ),
    true,
  );
  // A trojan route answers through its JSON err() helper — after auth passed.
  assertEquals(
    isAuthRefusal(403, '{"error":"trojan SQL is read-only — only SELECT"}'),
    false,
  );
  assertEquals(isAuthRefusal(404, "Not Found"), false);
  assertEquals(isAuthRefusal(500, "boom"), false);
});
