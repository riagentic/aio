// `serverUser()` inside a `worker: true` cell's method answers what the SAME
// cell answers in-isolate — docs/state/cell-workers.md: "serverUser() /
// serverRequest() answer inside the worker".
//
// In-isolate, a method's identity is the action's `_user` stamp
// (aio-dispatch.ts: `runWithUser(a._user, () => reduce(s, a))`; server-origin
// actions carry none → `undefined`). The worker bridge used to forward
// something else: the MAIN isolate's ambient `serverUser()` at route time,
// trimmed to `{ id, role }`. So:
//
//  1. a NETWORK call from an authenticated user — the user rides `_user`, the
//     main-side ambient is empty — reached the worker with NO user, and a
//     `serverUser()!.id` write (the docs/auth idiom) keyed on `undefined` only
//     when the cell happened to be a worker cell;
//  2. a SERVER-ORIGIN call made inside a user's ambient scope (a serverFn
//     calling the cell) — no `_user` — was anonymous in-isolate and ran AS
//     that user in the worker;
//  3. whatever `resolveUser` returned beyond `{ id, role }` (a tenant, a
//     plan, scopes) was silently dropped at the thread hop.
//
// This file is its own worker entry: the real worker re-imports it and boots
// into cell-host mode; the tests register only on the main isolate.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { aio, cell, isCellWorker, serverUser } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { runWithUser } from "../src/server/auth-context.ts";
import { enc } from "../src/protocol/envelope.ts";

export const whoW = cell("whoW", {
  worker: true,
  state: { last: "" },
  methods: {
    who(s: { last: string }) {
      const u = serverUser() as Record<string, unknown> | undefined;
      s.last = String(u?.id ?? "anon");
      return { id: u?.id ?? null, tenant: u?.tenant ?? null };
    },
    // The async body runs as the cell's `__exec` effect — the identity must
    // survive that hop too, on both sides of the thread.
    async whoLater(s: { last: string }) {
      await new Promise((r) => setTimeout(r, 5));
      const u = serverUser() as Record<string, unknown> | undefined;
      s.last = String(u?.id ?? "anon");
      return { id: u?.id ?? null, tenant: u?.tenant ?? null };
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    watch: false,
    appId: "worker-cell-server-user",
    cells: [whoW],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
} else {
  const ENTRY = import.meta.url;
  const USER = { id: "u1", role: "member", tenant: "acme" };
  const W = whoW as unknown as {
    who(): Promise<unknown>;
    whoLater(): Promise<unknown>;
  };

  /** Call `whoW.<method>()` over a real WS as the user `token` resolves to. */
  async function overWire(
    port: number,
    method: string,
    token = "t-acme",
  ): Promise<unknown> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const cid = `${method}-1`;
    try {
      return await new Promise((resolve, reject) => {
        const bail = setTimeout(
          () => reject(new Error("no ack in 10s")),
          10_000,
        );
        ws.onerror = () => {
          clearTimeout(bail);
          reject(new Error("ws error"));
        };
        ws.onopen = () =>
          ws.send(
            enc("action", {
              type: `whoW:${method}`,
              payload: { args: [] },
              cid,
            }),
          );
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          if (m.t === "ack" && m.d?.cid === cid) {
            clearTimeout(bail);
            resolve(m.d.ok ? m.d.value : { err: m.d.error });
          }
        };
      });
    } finally {
      ws.close();
    }
  }

  async function observe(real: boolean) {
    await using srv = await testServer({
      cells: [whoW],
      resolveUser: (tok: string) => tok === "t-acme" ? USER : null,
      ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
    });
    return {
      network: await overWire(srv.port, "who"),
      networkAsync: await overWire(srv.port, "whoLater"),
      // Server-origin (no `_user` stamp) from inside a user's ambient scope.
      serverOrigin: await runWithUser(USER, () => W.who()),
      serverOriginAsync: await runWithUser(USER, () => W.whoLater()),
    };
  }

  Deno.test("worker cell: a WS caller's FULL resolveUser object reaches serverUser()", async () => {
    const r = await observe(true);
    assertEquals(r.network, { id: "u1", tenant: "acme" });
    assertEquals(r.networkAsync, { id: "u1", tenant: "acme" });
  });

  Deno.test("worker cell: a server-origin call is anonymous, whatever ambient user surrounds it", async () => {
    const r = await observe(true);
    assertEquals(r.serverOrigin, { id: null, tenant: null });
    assertEquals(r.serverOriginAsync, { id: null, tenant: null });
  });

  Deno.test("worker vs in-isolate: serverUser() answers identically on every call path", async () => {
    const local = await observe(false);
    const worker = await observe(true);
    // The control: in-isolate answers the WS caller in full, server-origin
    // anonymous — and the worker must say exactly the same.
    assertEquals(local.network, { id: "u1", tenant: "acme" });
    assertEquals(local.serverOrigin, { id: null, tenant: null });
    assertEquals(worker, local);
  });

  Deno.test("worker cell: an uncloneable user object fails LOUD, naming `_user`", async () => {
    // A resolveUser that hands back a live object cannot cross postMessage.
    // It must not be trimmed to `{ id, role }` in silence: the call is refused
    // and the message names the identity, not the caller's arguments.
    const live = { id: "u2", role: "member", can: () => true };
    for (const real of [true, false]) {
      await using srv = await testServer({
        cells: [whoW],
        resolveUser: (tok: string) => tok === "t-live" ? live : null,
        ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
      });
      const r = await overWire(srv.port, "who", "t-live") as {
        err?: string;
      };
      assertStringIncludes(
        String(r.err),
        "`_user`",
        `${real ? "real worker" : "in-isolate"}: ${JSON.stringify(r)}`,
      );
    }
  });
}
