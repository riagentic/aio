// `docs/ui/air-forms.md`'s Standard Schema example called `form.parsed()`,
// which is TS2722 ("Cannot invoke an object which is possibly 'undefined'"):
// `FormState.parsed` is declared OPTIONAL, because `FormState` is frozen public
// surface and a required member would break anyone who builds one by hand. The
// type cannot move, so the doc does: `form.parsed!()`.
//
// The docs-snippets gate skips this block (it imports `zod`, a bare specifier
// it cannot resolve), which is how it shipped. This test checks the doc's own
// block with `zod` swapped for a type-only stand-in.
import { assert, assertEquals } from "@std/assert";

Deno.test("air-forms: the documented parsed() call type-checks", async () => {
  const md = await Deno.readTextFile(
    new URL("../docs/ui/air-forms.md", import.meta.url),
  );
  const block = [...md.matchAll(/```tsx\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .find((b) => b.includes("parsed"));
  assert(block, "the Standard Schema example is still in the doc");
  assert(block.includes('import { z } from "zod";'));

  const repo = new URL("..", import.meta.url).pathname;
  const program = [
    'import { useForm } from "aio/air";',
    "declare const api: { signup(v: unknown): Promise<void> };",
    // A Standard Schema v1 shape is all `useForm` needs from the value; `z`
    // only has to satisfy the doc's own calls and its `z.infer` type.
    "// deno-lint-ignore no-explicit-any",
    "declare const z: any;",
    "declare namespace z { type infer<T> = unknown; }",
    block.replace('import { z } from "zod";', ""),
    "export {};",
  ].join("\n");

  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/deno.jsonc`,
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "aio",
          lib: ["deno.ns", "dom"],
        },
        imports: {
          "aio/jsx-runtime": `${repo}src/jsx-runtime.ts`,
          "aio/air": `${repo}src/air.ts`,
          "aio": `${repo}mod.ts`,
        },
      }),
    );
    await Deno.writeTextFile(`${dir}/snippet.tsx`, program);
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["check", "-c", `${dir}/deno.jsonc`, `${dir}/snippet.tsx`],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(
      code,
      0,
      `deno check failed:\n${new TextDecoder().decode(stderr)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
