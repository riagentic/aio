// The boundary matrix is the load-bearing structural rule, and it is enforced
// by a REGEX over source text. A regex sees one spelling at a time, so the
// question this file exists to answer is: does it see every spelling that
// actually reaches a module?
//
// Two do. `../db/mod.ts` is the obvious one. `aio/db` is the other — deno.json
// maps it to `./src/db/mod.ts`, so it is the same import wearing the public
// name, and for a long time the gate could not see it at all. src/ uses none
// today; that is a fact this test keeps true rather than one it observed once.
//
// The gate reads relative paths (`src/`, `deno.json`), so a fixture tree with
// a cwd of its own is a complete, hermetic subject.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const GATE = join(REPO, "scripts", "check-boundaries.ts");

/** Run the real gate over a throwaway src/ tree. Returns its verdict. */
async function gateOn(
  files: Record<string, string>,
): Promise<{ ok: boolean; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: "aio-bounds-" });
  try {
    // The gate resolves `aio/*` through the import map, so the fixture needs
    // the repo's real one — that mapping IS half of what is under test.
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

// `air` may not import `db` — a rule with no exception, so it makes a clean
// subject. Both files below are the SAME violation, differently spelled.
const RELATIVE = `import { createDB } from "../db/mod.ts";\n`;
const BARE = `import { createDB } from "aio/db";\n`;

Deno.test("boundaries: a relative cross-folder import is refused", async () => {
  const r = await gateOn({ "src/air/x.ts": RELATIVE, "src/db/mod.ts": "" });
  assertEquals(r.ok, false, r.out);
  assertStringIncludes(r.out, "air may not import db");
});

Deno.test("boundaries: the same import spelled `aio/db` is refused too", async () => {
  const r = await gateOn({ "src/air/x.ts": BARE, "src/db/mod.ts": "" });
  assertEquals(r.ok, false, r.out);
  assertStringIncludes(r.out, "air may not import db");
});

Deno.test("boundaries: an import that is only PROSE is not an import", async () => {
  // A docstring showing the public spelling, and a scaffold that emits an app
  // as a template literal, are text ABOUT imports. src/am/am-cmd-create.ts is
  // full of the second kind; if the gate counted them, the matrix would be
  // enforcing the shape of the apps this framework generates.
  const r = await gateOn({
    "src/air/x.ts": [
      `/** Usage: import { createDB } from "aio/db"; */`,
      `// import { createDB } from "../db/mod.ts";`,
      `const scaffold = \`import { createDB } from "aio/db";\`;`,
      `export const x = scaffold;`,
    ].join("\n"),
    "src/db/mod.ts": "",
  });
  // Not `r.ok` — a four-file fixture cannot exercise the real matrix, so rule
  // 3 rightly reports every declared edge as dead. The claim under test is the
  // narrow one: none of those three lines was read as an import.
  assertEquals(
    r.out.includes("air may not import db"),
    false,
    `prose counted as an import:\n${r.out}`,
  );
});
