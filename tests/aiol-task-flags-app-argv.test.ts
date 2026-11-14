// The task-flag migration reads and rewrites the APP's argv only.
//
// `--cert=` → `--tls-cert=` was applied anywhere in a task that ran the app,
// but a flag BEFORE the entry is deno's: `deno run --cert=ca.pem -A
// src/app.ts` loads a CA certificate (corporate TLS proxies), and the rename
// broke `deno task dev`. A chained task's OTHER segment (`deno run gen.ts
// --key=x && deno run -A src/app.ts`) is another program's argv. The report
// (checks.ts) and the fix share one decider (`taskAppArgSpans`), so neither
// sees those flags.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { lintProject } from "../aiol/mod.ts";
import { fixTaskFlags, taskAppArgSpans } from "../aiol/fixes.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP =
  `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "fixme", cells: { counter } });\n`;
const CELL =
  `import { cell } from "aio";\nexport const counter = cell("counter", {\n  state: { count: 0 },\n  methods: { increment(s: { count: number }) { s.count++; } },\n});\n`;

async function lintAndFix(dev: string) {
  const dir = await tempDir("aiol-task-argv-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src/app.ts"), APP);
    await Deno.writeTextFile(join(dir, "src/cell.ts"), CELL);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify(
        {
          title: "fixme",
          version: "0.1.0",
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
          imports: { aio: "jsr:@riagentic/aio@1.0.0" },
          tasks: { dev },
        },
        null,
        2,
      ),
    );
    const report = await lintProject(dir);
    for (const i of report.issues.filter((i) => i.safeFix)) {
      await i.safeFix!(dir);
    }
    const out = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    return {
      reported: report.issues.some((i) => i.message.includes('task "dev"')),
      dev: out.tasks.dev as string,
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("task flags: deno's own --cert= before the entry is left alone", async () => {
  const dev = "deno run --cert=./corp-ca.pem -A src/app.ts";
  const r = await lintAndFix(dev);
  assert(!r.reported, "deno's --cert= was reported as a renamed aio flag");
  assertEquals(r.dev, dev);
});

Deno.test("task flags: a separate-value deno flag before the entry is deno's", async () => {
  const dev = "deno run --cert ./corp-ca.pem -A src/app.ts --key=k.pem";
  const r = await lintAndFix(dev);
  assert(r.reported);
  assertEquals(
    r.dev,
    "deno run --cert ./corp-ca.pem -A src/app.ts --tls-key=k.pem",
  );
});

Deno.test("task flags: a chained task rewrites only the app's segment", async () => {
  const r = await lintAndFix(
    "deno run gen.ts --key=x && deno run -A src/app.ts --cert=c.pem --kill-existing",
  );
  assert(r.reported);
  assertEquals(
    r.dev,
    "deno run gen.ts --key=x && deno run -A src/app.ts --tls-cert=c.pem --takeover",
  );
});

Deno.test("task flags: the chained OTHER segment alone is not reported", async () => {
  const dev = "deno run gen.ts --key=x && deno run -A src/app.ts";
  const r = await lintAndFix(dev);
  assert(!r.reported, "another program's --key= was reported");
  assertEquals(r.dev, dev);
});

Deno.test("task flags: the entry passed as an ARGUMENT to another script is not the app", () => {
  assertEquals(
    taskAppArgSpans(
      "deno run -A tools/wrap.ts src/app.ts --key=x",
      "src/app.ts",
    ),
    [],
  );
  const cmd = "deno run -A src/app.ts --key=x; echo done";
  const spans = taskAppArgSpans(cmd, "src/app.ts");
  assertEquals(spans.map(([a, b]) => cmd.slice(a, b)), [" --key=x"]);
});

Deno.test("task flags: fixTaskFlags on its own honours the same scope", async () => {
  const dir = await tempDir("aiol-task-argv-");
  try {
    const dev = "deno run --cert=./corp-ca.pem -A src/app.ts --headless";
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ tasks: { dev } }, null, 2),
    );
    await fixTaskFlags("src/app.ts")(dir);
    const out = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    assertEquals(
      out.tasks.dev,
      "deno run --cert=./corp-ca.pem -A src/app.ts --client=server-only",
    );
  } finally {
    await dropTempDir(dir);
  }
});
