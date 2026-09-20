// A journal written before lines carried a version stamp (`v`), replayed on a
// boot that MIGRATED the cell those lines write.
//
// The stamp is how replay tells a line the running build's methods may run
// from one they may not. An unstamped line cannot say: it may have run under
// the old version (the snapshot's — then re-running it through the new method
// on migrated state is a guess, the "+5 units replayed as +5 cents" class) or
// under the new one (a build that migrated in memory and crashed before its
// first snapshot — then replaying it is right). Neither answer is provable, so
// replay keeps its old behaviour — but it used to do so SILENTLY. It says so
// now, naming the cell and the lines.
import { assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const V1 = `const w = cell("w", {
  state: { units: 0 },
  methods: { add(s, v) { s.units += v; } },
});`;
const V2 = `const w = cell("w", {
  version: 2,
  state: { cents: 0 },
  onMigrate: (s, from) => {
    if (from < 2) { s.cents = (s.units ?? 0) * 100; delete s.units; }
    return s;
  },
  methods: { add(s, v) { s.cents += v; } },
});`;

const child = (cellSrc: string) => `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
${cellSrc}
const app = await aio.run({
  cells: [w],
  appId: "journal-unstamped-probe",
  client: "server-only",
  journal: true,
  persistDebounceMs: Number(Deno.env.get("DEBOUNCE")),
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
if (Deno.env.get("PHASE") === "read") {
  await app.close();
  Deno.exit(0);
}
await w.add(1);
await new Promise((r) => setTimeout(r, 1000));
await w.add(5);
Deno.kill(Deno.pid, "SIGKILL");
`;

async function run(dir: string, src: string, phase: string, debounce: number) {
  await Deno.writeTextFile(`${dir}/app.ts`, src);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
      DEBOUNCE: String(debounce),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

async function findJournal(dir: string): Promise<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isFile && e.name === "journal") return p;
    if (e.isDirectory) {
      const found = await findJournal(p).catch(() => "");
      if (found) return found;
    }
  }
  throw new Error(`no journal under ${dir}`);
}

Deno.test("journal replay: unstamped lines for a cell this boot migrated are said, not replayed silently", async () => {
  const dir = await tempDir("aio-journal-unstamped-");
  try {
    await run(dir, child(V1), "kill", 100);
    // As a build from before the stamp wrote it: the same lines, no `v`.
    const path = await findJournal(dir);
    const lines = (await Deno.readTextFile(path)).split("\n").filter(Boolean)
      .map((l) => {
        const e = JSON.parse(l);
        delete e.v;
        return JSON.stringify(e);
      });
    await Deno.writeTextFile(path, lines.join("\n") + "\n");
    const log = await run(dir, child(V2), "read", 999999);
    assertStringIncludes(log, "carry no version stamp");
    assertStringIncludes(log, `"w"`);
  } finally {
    await dropTempDir(dir);
  }
});
