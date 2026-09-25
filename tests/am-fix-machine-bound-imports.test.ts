// `am fix` advises on an import map that pins the compiled binary to THIS
// machine (an absolute path or `file:` URL value — Deno 2.9 loads it from that
// disk path at run time, so the artifact dies with `Module not found` anywhere
// else). The same words the build warns with; advised, never rewritten.
// Driven through the real `am fix --dry-run --json`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));

async function portableCheck(
  imports: Record<string, string>,
): Promise<{ outcome: string; note: string } | undefined> {
  const dir = await tempDir("aio-fix-abs-map-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        name: "absmap",
        tasks: { dev: "deno run -A src/app.ts" },
        imports,
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      `import { aio } from "aio";\nawait aio.run({ ui: {} });\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        join(REPO, "src", "am.ts"),
        "fix",
        "--dry-run",
        "--json",
      ],
      cwd: dir,
      env: { ...Deno.env.toObject(), AIO_APPS_DIR: dir },
      stdout: "piped",
      stderr: "null",
    }).output();
    const r = JSON.parse(new TextDecoder().decode(out.stdout)) as {
      results: { name: string; outcome: string; note: string }[];
    };
    return r.results.find((x) => x.name === "portable import map");
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("am fix: an absolute-path import map is advised with the relative fix", async () => {
  const r = await portableCheck({ aio: "/opt/aio/mod.ts" });
  assert(r, "no portable-import-map check in the report");
  assertEquals(r.outcome, "advise");
  for (
    const s of [
      'imports["aio"]',
      '"/opt/aio/mod.ts"',
      "./dep/aio/",
      "THIS machine",
    ]
  ) {
    assertStringIncludes(r.note, s);
  }
});

Deno.test("am fix: a relative import map (what am create writes) is ok", async () => {
  const r = await portableCheck({
    aio: "./dep/aio/mod.ts",
    immer: "npm:immer@^10",
  });
  assertEquals(r?.outcome, "ok");
});
