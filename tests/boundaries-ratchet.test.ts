// The boundary gate has three rules, and only the first had a test that
// proved it bites (`tests/boundaries-both-spellings.test.ts`). The other two
// are the ones that decide whether the matrix is a fence or a suggestion:
//
//   2. a folder may not reach a forbidden folder THROUGH a root entry file
//      (`src/*.ts` are conduits — an importer inherits their whole reach);
//   3. an edge the matrix allows that NO import uses is an error, so a
//      permission never outlives its last importer (the matrix self-ratchets).
//
// The gate reads relative paths (`src/`, `deno.json`), so a fixture tree with
// a cwd of its own is a complete, hermetic subject — same as its sibling.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const GATE = join(REPO, "scripts", "check-boundaries.ts");

async function gateOn(
  files: Record<string, string>,
): Promise<{ ok: boolean; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: "aio-bounds-" });
  try {
    await Deno.copyFile(join(REPO, "deno.json"), join(dir, "deno.json"));
    for (const [rel, body] of Object.entries(files)) {
      const path = join(dir, rel);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, body);
    }
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", GATE],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return { ok: code === 0, out: dec.decode(stdout) + dec.decode(stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("boundaries: laundering — reaching a forbidden folder through a root entry file is refused by name", async () => {
  // `ui` may import `air` only. `src/conduit.ts` is a root file (unrestricted)
  // that imports `db`; `ui` importing the conduit inherits that reach.
  const r = await gateOn({
    "src/ui/x.ts": `import { c } from "../conduit.ts";\n`,
    "src/conduit.ts": `export { createDB as c } from "./db/mod.ts";\n`,
    "src/db/mod.ts": `export const createDB = 1;\n`,
  });
  assertEquals(r.ok, false, r.out);
  assertStringIncludes(r.out, "IMPORT LAUNDERING");
  assertStringIncludes(r.out, "ui may not import db");
});

Deno.test("boundaries: a root entry file reached for an ALLOWED folder is fine", async () => {
  const r = await gateOn({
    "src/ui/x.ts": `import { h } from "../conduit.ts";\n`,
    "src/conduit.ts": `export { h } from "./air/h.ts";\n`,
    "src/air/h.ts": `export const h = 1;\n`,
  });
  // Every OTHER declared edge is unused in this fixture, so the verdict is
  // still red — the point here is that no laundering line is among them.
  assertEquals(r.out.includes("IMPORT LAUNDERING"), false, r.out);
});

Deno.test("boundaries: a declared edge with no importer is refused (self-ratchet)", async () => {
  // One real import (ui → air), so that edge is used; every other edge in the
  // matrix is not, and each one is named.
  const r = await gateOn({
    "src/ui/x.ts": `import { h } from "../air/h.ts";\n`,
    "src/air/h.ts": `export const h = 1;\n`,
  });
  assertEquals(r.ok, false, r.out);
  assertStringIncludes(
    r.out,
    `ALLOWED["state"] permits "diagnostics" but nothing imports it`,
  );
  assertEquals(
    r.out.includes(`ALLOWED["ui"] permits "air" but nothing imports it`),
    false,
    "the one edge that IS used is not reported",
  );
});

Deno.test("boundaries: a removed edge's use is refused — `ui` → `state` is not in the matrix", async () => {
  const r = await gateOn({
    "src/ui/x.ts": `import { s } from "../state/s.ts";\n`,
    "src/state/s.ts": `export const s = 1;\n`,
  });
  assertEquals(r.ok, false, r.out);
  assertStringIncludes(r.out, "ui may not import state");
});
