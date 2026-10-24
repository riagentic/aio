// The wine rig (scripts/wine-pipe.ts) mounts a bare copy of src/ + the
// fixtures, with no deno.json: a mapped specifier there (`@std/path`, added
// to runner.ts in 1.0.19) failed "not a dependency" before the first case,
// and the rig proved nothing for six releases. Every import in the fixtures,
// and in the src/ modules they load, must resolve without an import map.
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const DIR = fromFileUrl(new URL("./fixtures/wine-pipe/", import.meta.url));
const SELF_CONTAINED = /^(\.{1,2}\/|node:|jsr:|npm:|https?:|file:)/;

Deno.test("wine rig: its fixtures and what they load import nothing an import map has to resolve", async () => {
  const mapped: string[] = [];
  for await (const e of Deno.readDir(DIR)) {
    if (!/\.(ts|js)$/.test(e.name)) continue;
    const info = new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", join(DIR, e.name)],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    const graph = JSON.parse(new TextDecoder().decode(info.stdout)) as {
      modules: { specifier: string; dependencies?: { specifier: string }[] }[];
    };
    for (const m of graph.modules) {
      for (const d of m.dependencies ?? []) {
        if (!SELF_CONTAINED.test(d.specifier)) {
          mapped.push(`${m.specifier.split("/aio/").pop()}: ${d.specifier}`);
        }
      }
    }
  }
  assertEquals(mapped, [], "a specifier only deno.json's import map resolves");
});
