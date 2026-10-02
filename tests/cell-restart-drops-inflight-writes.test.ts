// `app.cells.disable(x)` then `enable(x)` — a restart — while an async method
// of `x` awaits. The reset destroyed the state that call was working on, but
// its later writes landed in the FRESH state and its caller was told it
// succeeded. A write made WHILE disabled is refused and its caller rejected;
// the same call must not be accepted just because the cell came back first.
import { assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let release!: () => void;
const c = cell("restartinflight", {
  state: { v: 0, log: [] as string[] },
  methods: {
    async slow(s, v: number) {
      await new Promise<void>((r) => release = r);
      s.v = v;
      s.log.push("stale");
      return "done";
    },
    async fresh(s) {
      await 0;
      s.log.push("fresh");
    },
  },
});

Deno.test("restart mid-call: the old call's writes never reach the new state", async () => {
  const dir = await tempDir("restart-inflight-");
  const app = await aio.run({
    watch: false,
    cells: [c],
    appId: "restartinflight",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    appDir: dir,
  });
  try {
    const p = c.slow(5).then((v) => `ok:${v}`, (e) => `err:${e.message}`);
    await sleep(5);
    app.cells!.disable("restartinflight");
    app.cells!.enable("restartinflight");
    release();
    const out = await p;
    assertEquals(
      out,
      "err:[restartinflight] cell disabled while slow() was running",
    );
    assertEquals(c.v, 0, "the destroyed incarnation's write landed");
    assertEquals(c.log, []);
    // A call started AFTER the restart is untouched.
    await c.fresh();
    assertEquals(c.log, ["fresh"]);
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
