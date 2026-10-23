// `app.cells.disable` resets the cell, and that reset must survive a restart
// like any other write.
//
// The reset (`cell:__destroy`) was left out of the journal and out of a sync
// cell's fold as "framework lifecycle". So:
//   • `journal: true`: `["a"]` saved, disable + enable, `add("after")`,
//     SIGKILL → the boot replayed `add` over the un-reset snapshot and came
//     back `["a","after"]` — a state the app never had;
//   • a `sync: true` cell: disable, then a CLEAN stop → the boot rebuilt it
//     from its op-log and the reset data was back.
// A breaker trip keeps the data (circuit-breaker-keeps-data.test.ts) — only
// the explicit disable resets, and that is what is checked here — and the
// SHUTDOWN's own `__destroy` (teardown) must never be taken for one.
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

const child = (sync: boolean, journal: boolean) => `
import { aio, cell } from "${spec(MOD)}";
const DIR = Deno.env.get("DIR");
const c = cell("dr", {
  ${sync ? "sync: true, version: 1," : ""}
  state: { items: [] },
  methods: { add(s, x) { s.items.push(x); } },
});
const app = await aio.run({
  cells: [c],
  appId: "disable-reset-durable",
  client: "server-only",
  journal: ${journal},
  persistDebounceMs: 50,
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
const phase = Deno.env.get("PHASE");
if (phase === "read") {
  Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify(app.getState().dr));
  await app.close();
  Deno.exit(0);
}
await c.add("a");
await new Promise((r) => setTimeout(r, 600)); // "a" is saved
if (!Deno.env.get("NO_DISABLE")) {
  app.cells.disable("dr");
  app.cells.enable("dr");
}
if (Deno.env.get("AFTER")) await c.add("after");
Deno.writeTextFileSync(DIR + "/live.json", JSON.stringify(app.getState().dr));
if (phase === "kill") Deno.kill(Deno.pid, "SIGKILL");
await new Promise((r) => setTimeout(r, 600));
await app.close();
Deno.exit(0);
`;

async function run(
  dir: string,
  phase: string,
  after: boolean,
  disable = true,
) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
      ...(after ? { AFTER: "1" } : {}),
      ...(disable ? {} : { NO_DISABLE: "1" }),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (phase !== "kill" && !out.success) {
    throw new Error(`${phase}: ${new TextDecoder().decode(out.stderr)}`);
  }
}

for (
  const [sync, journal, stop, after] of [
    [false, true, "kill", true],
    [true, false, "clean", false],
    [true, true, "kill", false],
  ] as const
) {
  Deno.test(`disable's reset survives a restart (${sync ? "sync" : "kv"} cell, journal ${journal}, ${stop} stop)`, async () => {
    const dir = await tempDir("aio-disable-reset-");
    try {
      await Deno.writeTextFile(`${dir}/app.ts`, child(sync, journal));
      await run(dir, stop, after);
      const live = JSON.parse(await Deno.readTextFile(`${dir}/live.json`));
      assertEquals(live.items, after ? ["after"] : []);
      await run(dir, "read", false);
      const back = JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
      assertEquals(back, live, "the restart restores the state it stopped on");
    } finally {
      await dropTempDir(dir);
    }
  });
}

for (const sync of [false, true]) {
  Deno.test(`a clean stop's teardown is not a reset (${sync ? "sync" : "kv"} cell, journal)`, async () => {
    const dir = await tempDir("aio-disable-reset-");
    try {
      await Deno.writeTextFile(`${dir}/app.ts`, child(sync, true));
      await run(dir, "clean", true, false);
      await run(dir, "read", false);
      const back = JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
      assertEquals(back.items, ["a", "after"]);
    } finally {
      await dropTempDir(dir);
    }
  });
}
