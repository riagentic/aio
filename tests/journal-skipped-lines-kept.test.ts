// A journal line boot could not replay is kept for a person, not compacted
// away by the first save.
//
// Found by a version differential (data written by 1.0.19, booted on this
// tree with a bumped cell `version`): boot warned "19 actions COULD NOT be
// replayed … an entry that cannot be replayed is still in the file at the
// next boot" — and the first save after boot compacted every one of them out
// of the journal. The skipped lines were the ONLY copy of acked writes; the
// warning pointed at a file that no longer held them (and the unstamped-line
// error told the operator to `am timeline --from=` that same file).
import { permissiveUmask } from "./permissive-umask.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fromFileUrl } from "@std/path";
import { spec } from "./module-spec-helper.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

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
import { aio, cell } from "${spec(MOD)}";
const DIR = Deno.env.get("DIR");
${cellSrc}
const app = await aio.run({
  cells: [w],
  appId: "journal-skipped-kept",
  client: "server-only",
  journal: true,
  persistDebounceMs: Number(Deno.env.get("DEBOUNCE")),
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
const phase = Deno.env.get("PHASE");
if (phase === "after") {
  // An ordinary write after boot: its save compacts the journal.
  await w.add(7);
  await new Promise((r) => setTimeout(r, 400));
  await app.close();
  Deno.exit(0);
}
await w.add(1);
await new Promise((r) => setTimeout(r, 1000));
await w.add(4242);
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
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase !== "kill" && !out.success) {
    throw new Error(`${phase} child failed:\n${text}`);
  }
  return text;
}

Deno.test("journal: lines boot could not replay survive the first save, in a copy the warning names", async () => {
  await permissiveUmask(async () => {
    const dir = await tempDir("aio-journal-skipped-kept-");
    try {
      await run(dir, child(V1), "kill", 100);
      const log = await run(dir, child(V2), "after", 50);
      assertStringIncludes(log, "COULD NOT be replayed");
      const data = `${dir}/data`;
      const live = await Deno.readTextFile(`${data}/journal`);
      assert(!live.includes("4242"), "the save compacted the live journal");
      const kept: string[] = [];
      for await (const e of Deno.readDir(data)) {
        if (e.name.startsWith("journal.unreplayed-")) kept.push(e.name);
      }
      assertEquals(kept.length, 1, `a copy is kept: ${kept}`);
      const copy = await Deno.readTextFile(`${data}/${kept[0]}`);
      assertStringIncludes(copy, "4242", "the skipped write is in the copy");
      assertStringIncludes(log, kept[0]!, "the warning names the copy");
      if (Deno.build.os !== "windows") {
        assertEquals(
          (await Deno.stat(`${data}/${kept[0]}`)).mode! & 0o777,
          0o600,
          "the copy holds payloads: owner-only like the journal",
        );
      }
    } finally {
      await dropTempDir(dir);
    }
  });
});
