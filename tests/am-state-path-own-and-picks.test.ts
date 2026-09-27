// Bug hunt r4 — `am state` / `am expect` path resolution.
//
// docs/clients/app-manager.md: "`am expect` FAILS on a path that is not there,
// for every op except `absent` … a typo in the path is never a PASS."
//
// 1. A brace pick whose keys are all/partly missing resolves as FOUND (an
//    empty / partial object), so `am expect 'counter.{cnt}' exists` PASSES on
//    a typo, and `absent` FAILS on it.
// 2. `resolvePath` reads INHERITED properties (`constructor`, `toString`,
//    `map`), so a path that is not in the state is "found": `am expect
//    counter.constructor absent` FAILS, and `am state counter.toString --json`
//    prints `undefined` (not a JSON document) and exits 0.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { resolvePath } from "../src/am/am-utils.ts";
import { cmdExpect, cmdState } from "../src/am/am-cmd-state.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";
import { freePort } from "../src/testing/server-test.ts";

const STATE = { counter: { count: 1 }, items: [1, 2] };

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/** Run an am command against a fake control server; exit code + stdout. */
async function run(
  fn: (flags: GlobalFlags) => Promise<void>,
): Promise<{ code: number; logs: string[] }> {
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const p = new URL(req.url).pathname;
      const json = (d: unknown) =>
        new Response(JSON.stringify(d), {
          headers: { "content-type": "application/json" },
        });
      if (p === "/__aio/health") return json({ status: "healthy" });
      if (p === "/__aio/trojan/state") return json(STATE);
      return new Response("not found", { status: 404 });
    },
  );
  const logs: string[] = [];
  const l = console.log, e = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const realExit = Deno.exit;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  let code = 0;
  try {
    await fn({ json: true, port, app: `zz-r4-path-${Deno.pid}` });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    code = err.code;
  } finally {
    Deno.exit = realExit;
    console.log = l;
    console.error = e;
    await server.shutdown();
  }
  return { code, logs };
}

Deno.test("resolvePath: a brace pick of keys that are not there is NOT found", () => {
  // `counter.{cnt}` — a typo of `count`. Nothing at that path exists.
  assertEquals(resolvePath(STATE, "counter.{cnt}").found, false);
});

Deno.test("am expect: a typo inside a brace pick is never a PASS", async () => {
  const exists = await run((f) => cmdExpect(["counter.{cnt}", "exists"], f));
  assertEquals(exists.code, 1, `PASSED on a typo: ${exists.logs.join("\n")}`);
  const absent = await run((f) => cmdExpect(["counter.{cnt}", "absent"], f));
  assertEquals(absent.code, 0, `absent FAILED: ${absent.logs.join("\n")}`);
});

Deno.test("resolvePath: inherited properties are not state", () => {
  for (const p of ["counter.constructor", "counter.toString", "items.map"]) {
    assertEquals(resolvePath(STATE, p).found, false, `${p} resolved`);
  }
});

Deno.test("am expect: `absent` passes on a key the state does not own", async () => {
  const r = await run((f) => cmdExpect(["counter.constructor", "absent"], f));
  assertEquals(r.code, 0, r.logs.join("\n"));
});

Deno.test("am state --json: a not-found path is exit 1 with a JSON error, never `undefined`", async () => {
  const r = await run((f) => cmdState(["counter.toString"], f));
  assertNotEquals(r.logs.length, 0, "the command printed its JSON error");
  for (const line of r.logs) {
    let ok = true;
    try {
      JSON.parse(line);
    } catch {
      ok = false;
    }
    assert(ok, `--json printed a non-JSON line: ${JSON.stringify(line)}`);
  }
  assertEquals(r.code, 1, `exit ${r.code}, out: ${r.logs.join("\n")}`);
});
