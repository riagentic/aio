// docs/basics/concepts.md:170-186 — "Writes batch per await-gap, not per
// assignment … The method above writes four fields and produces two actions,
// not four. The trigger action (`cell:save`) appears in time-travel alongside
// them." docs/state/methods.md:328-330 — async writes dispatch method-tagged
// actions, so every batch names the method that produced it.
import { assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("docs promise: four fields across two await-gaps commit as two method-tagged actions", async () => {
  const dir = await tempDir("docs-promise-await-gap-");
  const seen: string[] = [];
  const saver = cell("gapsaver", {
    state: { status: "", error: "x", data: 0, done: false },
    methods: {
      async save(s) {
        s.status = "saving"; // ┐ one gap
        s.error = ""; //        ┘
        await new Promise((r) => setTimeout(r, 5));
        await new Promise((r) => setTimeout(r, 5)); // nothing written between
        s.done = true; // ┐ another gap
        s.data = 1; //    ┘
      },
    },
  });
  const app = await aio.run({
    cells: [saver],
    appId: "docs-promise-await-gap",
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    appDir: dir,
    beforeReduce: (a: unknown) => {
      const t = (a as { type: string }).type;
      if (t.startsWith("gapsaver:")) seen.push(t);
      return a;
    },
  });
  try {
    seen.length = 0;
    await saver.save();
    assertEquals(seen, [
      "gapsaver:save", // the trigger action
      "gapsaver:__setSave", // status + error
      "gapsaver:__setSave", // done + data
    ]);
    assertEquals(
      {
        status: saver.status,
        error: saver.error,
        done: saver.done,
        data: saver.data,
      },
      { status: "saving", error: "", done: true, data: 1 },
    );
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});
