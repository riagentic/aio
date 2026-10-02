// A serverFn — and its namespace's `access` predicate — can key a login
// throttle on the CALLER'S address: `serverRequest().ip`, the same value an
// HTTP route's `ctx.ip` carries, resolved through `trustProxyHeader` (its
// rightmost hop) only when that option is set. A field report (a crypto
// wallet app) fell back to a GLOBAL failure window because it believed a
// serverFn could not see who was calling from where.
import { assertEquals } from "@std/assert";
import { aio, cell, serverFns, serverRequest } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { enc } from "../src/protocol/envelope.ts";

async function sfn(
  port: number,
  ns: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers } as never);
  try {
    return await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("sfn timed out")), 5000);
      ws.onopen = () =>
        ws.send(enc("sfn", { cid: "c1", ns, name: "whereFrom", args: [] }));
      ws.onmessage = (e) => {
        const f = JSON.parse(String(e.data));
        if (f.t === "sfnr") {
          clearTimeout(t);
          res(f.d);
        }
      };
      ws.onclose = (e) => {
        clearTimeout(t);
        rej(new Error(`closed ${e.code} ${e.reason}`));
      };
    });
  } finally {
    const closed = new Promise((r) => ws.addEventListener("close", r));
    ws.close();
    await closed;
  }
}

/** What the fn body and the access predicate saw for one forwarded call. */
async function seen(trustProxyHeader?: string) {
  const dir = await tempDir("aio-sfn-ip-");
  const port = freePort();
  const ns = `ip${crypto.randomUUID().slice(0, 8)}`;
  let inAccess: string | undefined;
  const app = await aio.run({
    cells: [cell(`c${ns}`, { state: { n: 0 } })],
    appId: `test-sfn-ip-${ns}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    baseDir: dir,
    port,
    ...(trustProxyHeader ? { trustProxyHeader } : {}),
    watch: false,
    onStart: () => {
      serverFns(ns, { whereFrom: () => serverRequest()?.ip }, {
        access: () => {
          inAccess = serverRequest()?.ip;
          return true;
        },
      });
    },
  });
  try {
    const r = await sfn(port, ns, {
      "x-forwarded-for": "198.51.100.9, 203.0.113.7",
    });
    return { inFn: r.value, inAccess };
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
}

Deno.test("serverFn + access predicate: serverRequest().ip is the trusted proxy's rightmost hop", async () => {
  assertEquals(await seen("x-forwarded-for"), {
    inFn: "203.0.113.7",
    inAccess: "203.0.113.7",
  });
});

Deno.test("serverFn + access predicate: without trustProxyHeader a forwarded header is ignored (no spoofing)", async () => {
  assertEquals(await seen(), { inFn: "127.0.0.1", inAccess: "127.0.0.1" });
});
