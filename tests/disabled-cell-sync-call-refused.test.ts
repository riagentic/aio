// docs/basics/concepts.md:244-246 (AIO6) — "sync methods resolve with `void`
// once the dispatch is applied". docs/state/methods.md:1364 — "Promise
// resolves once the dispatch is applied". docs/debugging/errors.md:76 — a
// disabled cell's action "applied nothing" (ACTION_REFUSED).
// docs/basics/api-reference.md:94 — `refusalsReject` makes the in-process
// caller get the answer the wire gives.
//
// On a disabled cell (`app.cells.disable(name)` / the circuit breaker), an
// ASYNC method call rejects ("cell 'x' is disabled — 'x:m' was not applied"),
// but a SYNC method call RESOLVES — nothing applied, no warning, and even with
// `refusalsReject: true`. The reduce's disabled branch records the refusal but
// neither throws (refusalsReject) nor warns, unlike `refuseValidation`.
import { assertEquals, assertRejects } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const dis = cell("r9disabled", {
  state: { v: 0 },
  methods: {
    set(s, v: number) {
      s.v = v;
    },
    async aset(s, v: number) {
      await 0;
      s.v = v;
    },
  },
});

Deno.test("disabled cell: a SYNC call is refused like an ASYNC one (refusalsReject: true)", async () => {
  const dir = await tempDir("r9-disabled-");
  const app = await aio.run({
    cells: [dis],
    appId: "r9disabled",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    appDir: dir,
    refusalsReject: true,
  });
  try {
    app.cells!.disable("r9disabled");
    // The async method already answers honestly.
    await assertRejects(() => dis.aset(7), Error, "is disabled");
    assertEquals(dis.v, 0);
    // The sync method must too: its write was not applied.
    await assertRejects(() => dis.set(9), Error, "is disabled");
    assertEquals(dis.v, 0);
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
