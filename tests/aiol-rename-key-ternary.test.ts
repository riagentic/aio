// A key rename touches the KEY, never a same-named variable in its value.
//
// `fixRenameRunKey` (killExisting → takeover) and `fixUiKeyToVisible`
// (ui → visible) read every depth-1 `identifier :` as a key, so a ternary's
// branch — `killExisting: dev ? killExisting : false` — was renamed too, to a
// variable that does not exist. Both now ask THE key decider
// (`topLevelKeyOffsets`, aiol/scan.ts): a key stands at a property start.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fixRenameRunKey, fixUiKeyToVisible } from "../aiol/fixes.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function rewrite(
  src: string,
  fix: (path: string) => () => Promise<boolean>,
): Promise<string> {
  const dir = await tempDir("aiol-key-ternary-");
  try {
    const p = join(dir, "app.ts");
    await Deno.writeTextFile(p, src);
    await fix(p)();
    return await Deno.readTextFile(p);
  } finally {
    await dropTempDir(dir);
  }
}

const runKey = (p: string) => fixRenameRunKey(p, "killExisting", "takeover");

Deno.test("fixRenameRunKey: a variable in the ternary's true branch stays", async () => {
  const src = `import { aio } from "aio";
const killExisting = true;
aio.run({ killExisting: dev ? killExisting : false });
`;
  assertEquals(
    await rewrite(src, runKey),
    src.replace("killExisting: dev", "takeover: dev"),
  );
});

Deno.test("fixRenameRunKey: a variable in the ternary's false branch stays", async () => {
  const src = `import { aio } from "aio";
const killExisting = Deno.args.includes("--fresh");
aio.run({ port: 8080, killExisting: Deno.env.get("CI") ? false : killExisting });
`;
  assertEquals(
    await rewrite(src, runKey),
    src.replace("killExisting: Deno", "takeover: Deno"),
  );
});

Deno.test("fixRenameRunKey: a key after a comment is still the key", async () => {
  const src = `import { aio } from "aio";
aio.run({
  port: 1, // why
  /* and */ killExisting: true,
});
`;
  assertEquals(
    await rewrite(src, runKey),
    src.replace("killExisting: true", "takeover: true"),
  );
});

Deno.test("fixUiKeyToVisible: a `ui` variable in the ternary stays", async () => {
  const src = `import { cell } from "aio";
const ui = "all";
export const c = cell("c", { state: {}, ui: Deno.env.get("LOCK") ? ui : "owner" });
`;
  assertEquals(
    await rewrite(src, (p) => fixUiKeyToVisible(p)),
    src.replace("ui: Deno", "visible: Deno"),
  );
});
