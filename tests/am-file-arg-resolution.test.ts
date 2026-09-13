// A FILE argument to `am` means what a shell user means by it.
//
// Measured in a fresh `am create` app, from the project root: `am where
// src/ui/Card.tsx` answered, and `am preview src/ui/Card.tsx` said "no such
// file …/src/src/ui/Card.tsx" — preview resolved from the entry's directory,
// where from the project root. The path a shell tab-completes failed in one
// verb and worked in the other, and the brief had to teach an agent the odd
// spelling (`ui/Card.tsx`). One rule now (`resolveFileArg`): the cwd first,
// then the fallbacks in order, first that exists wins.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { resolveFileArg } from "../src/am/am-project.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;

async function app(): Promise<string> {
  const dir = await tempDir("am-file-arg-");
  await Deno.mkdir(`${dir}/src/ui`, { recursive: true });
  await Deno.writeTextFile(`${dir}/deno.json`, "{}\n");
  await Deno.writeTextFile(`${dir}/src/app.ts`, "await 1;\n");
  // No JSX, so the component needs no app-side jsx config to import.
  await Deno.writeTextFile(
    `${dir}/src/ui/Card.ts`,
    `import { h } from "${REPO}src/air/vdom.ts";\n` +
      `export function Card(p: { title: string }) {\n` +
      `  return h("h2", { t: "title" }, p.title);\n}\n`,
  );
  return dir;
}

Deno.test("resolveFileArg: cwd first, then each base, first that exists", async () => {
  const dir = await app();
  try {
    const src = join(dir, "src");
    // The shell's path, from the project root.
    assertEquals(
      resolveFileArg("src/ui/Card.ts", [dir, src], dir),
      { ok: true, path: join(src, "ui/Card.ts") },
    );
    // The app-directory spelling still works (it was the only one that did).
    assertEquals(
      resolveFileArg("ui/Card.ts", [dir, src], dir),
      { ok: true, path: join(src, "ui/Card.ts") },
    );
    // From inside src/, the cwd-relative path.
    assertEquals(
      resolveFileArg("ui/Card.ts", [dir], src),
      { ok: true, path: join(src, "ui/Card.ts") },
    );
    // Nothing exists: every place looked is named, once each.
    const miss = resolveFileArg("nope.tsx", [dir, dir, src], dir);
    assert(!miss.ok);
    assertEquals(miss.tried, [join(dir, "nope.tsx"), join(src, "nope.tsx")]);
    // An absolute path is itself, or a miss.
    assertEquals(resolveFileArg(join(src, "app.ts"), [], "/"), {
      ok: true,
      path: join(src, "app.ts"),
    });
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am preview src/ui/Card.ts from the project root renders", async () => {
  const dir = await app();
  try {
    const run = async (file: string) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          `${REPO}deno.json`,
          `${REPO}src/am.ts`,
          "preview",
          file,
          "--export=Card",
          `--props={"title":"Inbox"}`,
          "--json",
        ],
        cwd: dir,
        env: {
          AIO_APPS_DIR: `${dir}/.aio-home`,
          AIO_AM_NO_DELEGATE: "1",
          NO_COLOR: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      return { code: o.code, text: d.decode(o.stdout) + d.decode(o.stderr) };
    };
    for (const spelling of ["src/ui/Card.ts", "ui/Card.ts"]) {
      const r = await run(spelling);
      assertEquals(r.code, 0, `am preview ${spelling}: ${r.text}`);
      assertStringIncludes(r.text, "Inbox");
    }
    const miss = await run("src/ui/Nope.ts");
    assertEquals(miss.code, 1);
    assertStringIncludes(miss.text, "looked for");
  } finally {
    await dropTempDir(dir);
  }
});
