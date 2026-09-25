// serverfns-owner-close.test.ts — a namespace an app registered never falls to
// an app that was ALREADY live when its owner closed.
//
// Ownership has to end with the owner (the module that registered it is
// cached, so a restarted app never registers it again —
// tests/two-apps-process-registries.test.ts pins that the next app serves
// it). It ended by making the namespace UNOWNED, i.e. served by every app:
// app A registers `vault` behind its user auth, open app B runs beside it,
// and the moment A closed, B answered vault.* to anonymous clients. Now it
// passes only to an app that boots after the close; a live one refuses it,
// and says so in its own log.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio, cell, serverFns } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { enc } from "../src/protocol/envelope.ts";

type App = { close(): Promise<void>; port: number };
const tag = () => crypto.randomUUID().slice(0, 8);

const boot = (
  id: string,
  dir: string,
  // deno-lint-ignore no-explicit-any
  extra: Record<string, any> = {},
) =>
  aio.run({
    cells: [
      cell(`c${tag()}`, {
        state: { n: 0 },
        methods: {
          inc(s: { n: number }) {
            s.n++;
          },
        },
      }),
    ],
    appId: id,
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port: freePort(),
    ...extra,
  } as never) as unknown as Promise<App>;

async function sfnCall(
  port: number,
  ns: string,
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws`,
    headers ? { headers } as never : undefined,
  );
  try {
    return await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("sfn timed out")), 5000);
      ws.onopen = () =>
        ws.send(enc("sfn", { cid: "c1", ns, name: "read", args: [] }));
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

const logsOf = async (dir: string) => {
  let all = "";
  for (const f of ["app.log", "warning.log", "debug.log"]) {
    all += await Deno.readTextFile(join(dir, "logs", f)).catch(() => "");
  }
  return all;
};

Deno.test("serverFns: when the owning app closes, an app already live beside it never serves its namespace — the next app to boot does", async () => {
  const [da, db, dc] = [
    await tempDir("aio-sfo-a-"),
    await tempDir("aio-sfo-b-"),
    await tempDir("aio-sfo-c-"),
  ];
  const ns = `vault${tag()}`;
  const token = "alice-token-1234567890";
  const idA = `sfoa-${tag()}`;
  const idB = `sfob-${tag()}`;
  const idC = `sfoc-${tag()}`;
  const A = await boot(idA, da, {
    users: { [token]: { id: "alice", role: "admin" } },
    // Registered AS app A (onStart runs in its scope).
    onStart: () => {
      serverFns(ns, { read: () => "A-SECRET" });
    },
  });
  const B = await boot(idB, db);
  let C: App | undefined;
  try {
    const onA = await sfnCall(A.port, ns, { authorization: `Bearer ${token}` });
    assertEquals(onA.value, "A-SECRET", JSON.stringify(onA));
    await A.close();
    const onB = await sfnCall(B.port, ns);
    assertEquals(
      onB.ok,
      false,
      `B, live when A closed, served A's namespace: ${JSON.stringify(onB)}`,
    );
    assert(!JSON.stringify(onB).includes("A-SECRET"));
    assertStringIncludes(String(onB.error), "not registered");
    // An app booted AFTER the close takes it over (a restart's shape).
    C = await boot(idC, dc);
    assertEquals((await sfnCall(C.port, ns)).value, "A-SECRET");
    // …and B still does not.
    assertEquals((await sfnCall(B.port, ns)).ok, false);
  } finally {
    await C?.close();
    await B.close();
    await A.close();
  }
  // Fail loud: the refusal is said in B's own log (flushed by its close),
  // naming B and why.
  const said = await logsOf(db);
  assertStringIncludes(
    said,
    `serverFns(${JSON.stringify(ns)}) is not served by app ${
      JSON.stringify(idB)
    }`,
  );
  assertStringIncludes(said, "booted AFTER that close");
  // …and the takeover by a DIFFERENT app is said in C's log, naming both.
  const took = await logsOf(dc);
  assertStringIncludes(
    took,
    `serverFns(${JSON.stringify(ns)}) was registered by app ${
      JSON.stringify(idA)
    }, which closed; ${JSON.stringify(idC)} booted next and now serves it`,
  );
  await dropTempDir(da);
  await dropTempDir(db);
  await dropTempDir(dc);
});
