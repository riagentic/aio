// A static `schedules:` entry survives `app.cells.disable(cell)` + `enable`.
//
// Disabling a cell cancels the schedules it ISSUED and every id starting with
// `<cell>:` — and that prefix sweep included the APP's own static entries.
// Nothing re-arms a static on enable, so `{ id: "<cell>:tick" }` was gone for
// good after one disable/enable, while the same entry under a bare id ("tick")
// survived. The cell did not issue it, and a tick into a disabled cell is
// already refused (the schedule outlives the refusal), so the static stays.
import { assert } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ctr = cell("sdectr", {
  state: { pre: 0, bare: 0 },
  methods: {
    bumpPre(s) {
      s.pre++;
    },
    bumpBare(s) {
      s.bare++;
    },
  },
});

Deno.test("static schedule: a '<cell>:id' entry keeps ticking after disable + enable", async () => {
  const dir = await tempDir("sde-");
  const app = await aio.run({
    watch: false,
    cells: [ctr],
    appId: "sdectr",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    appDir: dir,
    schedules: [
      { id: "sdectr:tick", every: 10, action: ctr.bumpPre.action() },
      { id: "tick", every: 10, action: ctr.bumpBare.action() },
    ],
  });
  try {
    await wait(60);
    assert(ctr.pre > 0 && ctr.bare > 0, "both armed");
    app.cells!.disable("sdectr");
    await wait(40);
    app.cells!.enable("sdectr");
    const pre0 = ctr.pre, bare0 = ctr.bare;
    await wait(150);
    assert(ctr.bare - bare0 > 0, "the bare-id static ticks on");
    assert(ctr.pre - pre0 > 0, "the prefixed static ticks on");
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
