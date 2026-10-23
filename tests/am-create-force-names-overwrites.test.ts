// `am create <existing-dir>` refused with "pick another name or pass --force"
// — and `--force` silently REPLACES the template's files. An agent that took
// the hint scaffolded over its own src/cell.ts. The refusal now names exactly
// which of the user's files `--force` would overwrite.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = fromFileUrl(new URL("../src/am.ts", import.meta.url));

async function create(cwd: string, name: string) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", AM, "create", name, "--json"],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  return { code: out.code, text };
}

Deno.test("am create into a non-empty dir names what --force would overwrite", async () => {
  const cwd = await tempDir("aio-create-force-");
  try {
    await Deno.mkdir(join(cwd, "mine/src"), { recursive: true });
    await Deno.writeTextFile(join(cwd, "mine/src/cell.ts"), "// my work\n");
    await Deno.writeTextFile(join(cwd, "mine/notes.txt"), "x\n");
    const r = await create(cwd, "mine");
    assertEquals(r.code, 1, r.text);
    assertStringIncludes(r.text, "OVERWRITES src/cell.ts");
    assert(!r.text.includes("notes.txt"), r.text); // not a template file

    await Deno.mkdir(join(cwd, "other"));
    await Deno.writeTextFile(join(cwd, "other/notes.txt"), "x\n");
    const o = await create(cwd, "other");
    assertEquals(o.code, 1, o.text);
    assertStringIncludes(o.text, "holds none of the template's files");
  } finally {
    await dropTempDir(cwd);
  }
});
