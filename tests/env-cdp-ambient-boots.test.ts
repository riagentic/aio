// An ambient `AIO_CDP` must never be what stops a server-only app from
// booting.
//
// 1.0.15 refused the env spelling "exactly like `--cdp`" on a non-Electron
// client. The flag is typed for one run; the variable sits in a CI job, a
// compose file or a shell profile — put there for some Electron app — and
// from then on every server-only app, and every `testServer`, under that
// environment failed its boot with a teachable error about a window it never
// had. It is ignored there now (warned once, no port, no `cdp` line).
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetParsedCli, cdpPort } from "../src/server/aio-cli.ts";

Deno.test("AIO_CDP=1 in the environment: a server-only app boots, and no debugging port exists", async () => {
  const prev = Deno.env.get("AIO_CDP");
  Deno.env.set("AIO_CDP", "1");
  _resetParsedCli();
  try {
    const c = cell("cdp_env_boot", { state: { n: 0 }, methods: {} });
    await using srv = await testServer({ cells: [c] }); // threw: "AIO_CDP only applies when client is electron"
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    await res.body?.cancel();
    assertEquals(res.status < 500, true);
    assertEquals(cdpPort(), undefined, "a port was still chosen for it");
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_CDP");
    else Deno.env.set("AIO_CDP", prev);
    _resetParsedCli();
  }
});
