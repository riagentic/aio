// The trojan HTTP door answers failures in the SAME shape as the WS and UDS
// acks: `{ error, code }`. It answered `{ error }` alone, so `am dispatch`,
// amui and any agent reading the JSON could not branch on the failure the
// other two doors name (`errorCode(e)`). Additive: a new JSON field.
//
// And a non-array `payload.args` (`{args:"hi"}`) is the reducer's own
// sentence — "payload.args must be an ARRAY" — not "this call passes none".
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio, cell } from "../mod.ts";
import {
  handleTrojan,
  resetTrojanRateLimit,
  type TrojanDeps,
} from "../src/server/server-trojan.ts";
import { createAioError } from "../src/diagnostics/error.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

function makeDeps(fail?: () => Promise<unknown>) {
  const dispatched: unknown[] = [];
  const deps = {
    dispatch: (a: unknown) => {
      dispatched.push(a);
      return fail ? fail() : Promise.resolve();
    },
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    trojan: {
      cellMethods: () => ({ counter: ["inc"] }),
      cellAsyncMethods: () => ({}),
      cellMethodArity: () => ({ counter: { inc: 1 } }),
      getState: () => ({}),
      startedAt: Date.now(),
    },
  } as unknown as TrojanDeps;
  return { deps, dispatched };
}

async function dispatch(deps: TrojanDeps, body: unknown) {
  const req = new Request("http://x/__aio/trojan/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-aio": "1" },
    body: JSON.stringify(body),
  });
  const resp = await handleTrojan("/__aio/trojan/dispatch", req, deps)!;
  resetTrojanRateLimit();
  return {
    status: resp.status,
    body: await resp.json() as Record<string, unknown>,
  };
}

Deno.test("trojan dispatch: a failed dispatch carries the error's code", async () => {
  const { deps } = makeDeps(() =>
    Promise.reject(
      createAioError("REDUCE_ERROR", new Error("reducer blew up"), {}),
    )
  );
  const r = await dispatch(deps, {
    type: "counter:inc",
    payload: { args: [1] },
  });
  assertStringIncludes(String(r.body.error), "reducer blew up");
  assertEquals(r.body.code, "REDUCE_ERROR");
});

Deno.test("trojan dispatch: a non-array payload.args is named as such, before the arity check", async () => {
  const { deps, dispatched } = makeDeps();
  for (const args of ["hi", { v: 1 }]) {
    const r = await dispatch(deps, { type: "counter:inc", payload: { args } });
    assertEquals(r.status, 400);
    assertStringIncludes(String(r.body.error), "must be an ARRAY");
    assert(
      !String(r.body.error).includes("passes none"),
      String(r.body.error),
    );
  }
  assertEquals(dispatched.length, 0);
});

Deno.test("trojan dispatch: a validate refusal (409) carries ACTION_REFUSED", async () => {
  const c = cell("trcode", {
    state: { n: 0 },
    methods: {
      setNeg(s: { n: number }) {
        s.n = -1;
      },
    },
    validate: (s: { n: number }) => s.n >= 0 || "n must not be negative",
  });
  const port = freePort();
  const dir = await tempDir("aio-trcode-");
  const app = await aio.run({
    cells: [c],
    appId: `trcode-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: dir,
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ type: "trcode:setNeg" }),
    });
    const body = await r.json();
    assertEquals(r.status, 409, JSON.stringify(body));
    assertEquals(body.code, "ACTION_REFUSED", JSON.stringify(body));
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
