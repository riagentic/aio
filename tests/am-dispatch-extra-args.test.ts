// `am dispatch` (the trojan route) with MORE arguments than the method takes.
//
// `inc(s)` handed `5` dropped it under a clean `{"ok":true}`: the reply's
// `extra` note fired only when the method REQUIRED at least one argument, and
// was judged against `fn.length`, which stops at a default — so
// `add(s, a, b = 1)` handed two was warned about falsely. The count is now
// what the method DECLARES (defaults counted, a rest parameter takes any).
// Warned, never refused: the call still runs.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";

const c = cell("extraargs", {
  state: { n: 0, log: [] as unknown[] },
  methods: {
    inc(s: { n: number }) {
      s.n += 1;
    },
    addTwo(s: { log: unknown[] }, a: number, b: number) {
      s.log.push(a + b);
    },
    addOpt(s: { log: unknown[] }, a: number, b = 1) {
      s.log.push(a + b);
    },
    addAll(s: { log: unknown[] }, ...xs: number[]) {
      s.log.push(xs.length);
    },
  },
});

Deno.test("am dispatch: arguments beyond what the method declares are named in the reply", async () => {
  const port = freePort();
  const dir = await tempDir("aio-extraargs-");
  const app = await aio.run({
    cells: [c],
    appId: `extraargs-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
  } as never);
  const call = async (method: string, args: unknown[]) => {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ type: `extraargs:${method}`, payload: { args } }),
    });
    return await r.json() as { ok: boolean; extra?: string };
  };
  try {
    const inc = await call("inc", [5]);
    assertEquals(inc.ok, true, "warned, never refused");
    assert(inc.extra, `inc(s) handed 5 said nothing: ${JSON.stringify(inc)}`);
    assertStringIncludes(inc.extra, "takes 0 arguments and this call passed 1");
    assertStringIncludes(inc.extra, "DROPPED");

    const two = await call("addTwo", [1, 2, 3]);
    assertStringIncludes(two.extra ?? "", "takes 2 arguments");

    for (
      const [m, args] of [["addOpt", [1, 2]], ["addAll", [1, 2, 3]]] as const
    ) {
      const r = await call(m, [...args]);
      assertEquals(r.ok, true);
      assertEquals(
        r.extra,
        undefined,
        `${m}: a declared default/rest is not extra`,
      );
    }
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
