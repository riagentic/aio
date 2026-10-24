// `String()` with no argument is the empty string. A sweep that turned
// `console.warn(msg)` into `log.warn(msg, { detail: String() })` left eight log
// sites carrying a `detail` that could never say anything — the shape of a
// caught value that was meant to be there and is not. Pin that no code in
// `src/` calls `String()` bare (comments and string text are masked out).
import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl } from "@std/path";
import { codeText } from "../src/diagnostics/code-mask.ts";

const SRC = fromFileUrl(new URL("../src", import.meta.url));

Deno.test("no bare String() call in src/", async () => {
  const hits: string[] = [];
  for await (const e of walk(SRC, { exts: [".ts", ".tsx"] })) {
    if (!e.isFile) continue;
    const src = await Deno.readTextFile(e.path);
    const code = codeText(src, e.path.endsWith(".tsx"));
    for (const m of code.matchAll(/(?<![\w$.])String\(\s*\)/g)) {
      const line = code.slice(0, m.index).split("\n").length;
      hits.push(`${e.path.slice(SRC.length + 1)}:${line}`);
    }
  }
  assertEquals(hits, [], 'String() is always "" — pass the value or drop it');
});
