// `deno task compile` embeds an app's own server Workers. `deno compile`
// cannot see `new Worker(new URL("./x.ts", import.meta.url))` (not an import):
// measured on Deno 2.9, a worker not named *.server.ts compiled green and
// answered "Module not found" from the binary. Now discovered and --include'd.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  assetIncludes,
  serverWorkerFiles,
  workerUrlSpecs,
} from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("workerUrlSpecs: literal specs found; computed ones by line; comments and strings ignored", () => {
  const src = [
    `const a = new Worker(new URL("./a.ts", import.meta.url), { type: "module" });`,
    `const b = new Worker( new URL( './b.ts' , import.meta.url ) );`,
    "const c = new Worker(new URL(`./c.ts`, import.meta.url));",
    "const d = new Worker(new URL(`./${name}.ts`, import.meta.url));",
    `const e = new Worker(new URL(spec, import.meta.url));`,
    `// new Worker(new URL("./commented.ts", import.meta.url))`,
    `const s = 'new Worker(new URL("./in-string.ts", import.meta.url))';`,
    `const f = new Worker("plain.js");`,
  ].join("\n");
  assertEquals(workerUrlSpecs(src), {
    specs: ["./a.ts", "./b.ts", "./c.ts"],
    computed: [4, 5],
  });
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await tempDir("compile-workers-");
  for (const [rel, body] of Object.entries(files)) {
    await Deno.mkdir(join(root, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, rel), body);
  }
  return root;
}

const start = (spec: string) =>
  `new Worker(new URL("${spec}", import.meta.url), { type: "module" });\n`;

Deno.test("serverWorkerFiles: the graph's workers and the workers they start; never a component's, a missing file or one outside the project", async () => {
  const root = await project({
    "src/app.ts": start("./plain-worker.ts") + start("./jobs/deep.ts") +
      start("./gone.ts") + start("../../outside.ts"),
    "src/plain-worker.ts": "self.onmessage = () => {};\n",
    "src/jobs/deep.ts": start("./nested.ts"),
    "src/jobs/nested.ts": "self.onmessage = () => {};\n",
    "src/App.tsx": start("./browser-worker.ts"),
    "src/browser-worker.ts": "self.onmessage = () => {};\n",
  });
  try {
    assertEquals(
      await serverWorkerFiles(root, ["src/app.ts", "src/App.tsx"]),
      ["src/plain-worker.ts", "src/jobs/deep.ts", "src/jobs/nested.ts"],
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("assetIncludes(root, entry): a server worker the entry starts is --include'd", async () => {
  const root = await project({
    "deno.json": "{}\n",
    "src/app.ts": start("./render-worker.ts"),
    "src/render-worker.ts": "self.onmessage = () => {};\n",
  });
  try {
    const args = await assetIncludes(root, "src/app.ts");
    assertEquals(
      args.filter((a) => a !== "--include"),
      ["src/render-worker.ts", "deno.json"],
    );
  } finally {
    await dropTempDir(root);
  }
});
