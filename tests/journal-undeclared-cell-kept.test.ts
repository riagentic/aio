// A journalled write to a cell the NEXT build does not declare must survive a
// SIGKILL as it survives a clean stop.
//
// A stored cell this build no longer declares is "PRESERVED in the store,
// untouched" (boot says so) — re-declare it and it comes back as-is. That
// held for what the store already had, but not for the journal tail: its
// lines for that cell were "replayed" as a no-op dispatch to an unregistered
// cell, counted recovered, and compacted away by the first save. The write
// the killed run acked was gone for good, and re-declaring the cell brought
// back the value from BEFORE it; a clean stop of the same run brought back
// the value AFTER it. The lines are held now (`journalHeldCellsKey`), named,
// and replayed once a build declares the cell — exactly once.
import { assertEquals, assertMatch } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fromFileUrl } from "@std/path";
import { spec } from "./module-spec-helper.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

const CHILD = `
import { aio, cell } from "${spec(MOD)}";
const DIR = Deno.env.get("DIR");
const PHASE = Deno.env.get("PHASE");
const a = cell("a", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
const old = cell("old", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
const app = await aio.run({
  cells: PHASE === "without" ? [a] : [a, old],
  appId: "journal-undeclared-cell",
  client: "server-only",
  journal: true,
  persistDebounceMs: 999999,
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
if (PHASE === "kill" || PHASE === "clean") {
  await old.inc();
  await old.inc();
  await a.inc();
  if (PHASE === "kill") Deno.kill(Deno.pid, "SIGKILL");
  await app.close();
  Deno.exit(0);
}
if (PHASE === "without") {
  await app.close(); // boots without "old", persists, compacts the journal
  Deno.exit(0);
}
if (PHASE === "incKill") {
  await old.inc();
  Deno.kill(Deno.pid, "SIGKILL");
}
Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify({ a: a.n, old: old.n }));
await app.close();
Deno.exit(0);
`;

async function run(dir: string, phase: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (!phase.toLowerCase().includes("kill") && !out.success) {
    throw new Error(`${phase}: ${text}`);
  }
  return text;
}

async function read(dir: string): Promise<unknown> {
  await run(dir, "read");
  return JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
}

Deno.test("journal: a write to a cell the next build does not declare survives a SIGKILL as it survives a clean stop", async () => {
  const outcome = async (stop: "kill" | "clean") => {
    const dir = await tempDir(`journal-undeclared-cell-${stop}-`);
    try {
      await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
      await run(dir, stop);
      const without = await run(dir, "without");
      await run(dir, "without"); // a second boot without it holds them still
      return { state: await read(dir), without };
    } finally {
      await dropTempDir(dir);
    }
  };
  const clean = await outcome("clean");
  assertEquals(
    clean.state,
    { a: 1, old: 2 },
    "clean-stop baseline: the undeclared cell's data is preserved",
  );
  const killed = await outcome("kill");
  assertEquals(
    killed.state,
    clean.state,
    "after a SIGKILL the journalled writes to the (temporarily) undeclared " +
      "cell must not be dropped by the boot that does not declare it",
  );
  assertMatch(
    killed.without,
    /"old" is not declared by this build — 2 journalled lines .* are KEPT/,
    "the boot that cannot apply them says so",
  );
});

Deno.test("journal: held lines of a re-declared cell replay once, then the cell is journalled as any other", async () => {
  const dir = await tempDir("journal-undeclared-cell-once-");
  try {
    await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
    await run(dir, "kill");
    await run(dir, "without");
    assertEquals(await read(dir), { a: 1, old: 2 }, "replayed on re-declare");
    assertEquals(await read(dir), { a: 1, old: 2 }, "and never again");
    await run(dir, "incKill");
    assertEquals(
      await read(dir),
      { a: 1, old: 3 },
      "a crash after the release replays only the new line",
    );
  } finally {
    await dropTempDir(dir);
  }
});
