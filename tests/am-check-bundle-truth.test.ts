// `am check` — a green `deno check` must stop preceding a failing bundle.
//
// From a field report (composer §1 — the ONLY thing that report calls a defect).
// `"aio"` resolves to `mod.ts` for the type-checker and to `browser-air.ts` for
// the browser bundle: TypeScript checks the UNION, the bundle gets the
// INTERSECTION. So anything server-only imported into a cell type-checks
// cleanly and then fails to build.
//
// The failure itself is good — the graph validator names file, line, column and
// fix at dev boot. What was wrong is WHEN it arrives: after `deno task check`,
// the tool the author trusts and the one CI runs, has already said the code is
// fine. That report's author was pushed into a stringly-typed workaround to get
// past a green check that was lying.
//
// So the fix is not a better error. It is that `deno task check` stops being
// green, and the scaffolded task now runs both halves — the same treatment
// `lint` already gets, where one task runs `deno lint` AND `aiol`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { standardTasks } from "../src/am/am-cmd-create.ts";

const REPO = new URL("..", import.meta.url).pathname;

async function amCheck(
  dir: string,
  args: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}src/am.ts`, "check", ...args],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
}

/** A minimal app in the layout the scaffold produces. */
async function makeApp(dir: string, appTsx: string, extra = ""): Promise<void> {
  await Deno.mkdir(`${dir}/src`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      title: "checkapp",
      version: "0.1",
      imports: {
        "aio": `${REPO}mod.ts`,
        "aio/air": `${REPO}src/air.ts`,
        "aio/server": `${REPO}src/server-entry.ts`,
        "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
      },
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
    }),
  );
  await Deno.writeTextFile(`${dir}/src/App.tsx`, appTsx);
  await Deno.writeTextFile(`${dir}/src/app.ts`, "export const x = 1;\n");
  if (extra) await Deno.writeTextFile(`${dir}/src/cell.ts`, extra);
}

Deno.test("am check: a clean client graph passes", async () => {
  const dir = await tempDir("am-check-ok-");
  try {
    await makeApp(
      dir,
      `export default function App() { return <div class="root">hi</div>; }\n`,
    );
    const r = await amCheck(dir, ["--json"]);
    assertEquals(r.code, 0, r.out + r.err);
    const j = JSON.parse(r.out) as { checked: boolean; errors: unknown[] };
    assertEquals(j.checked, true, "the check must actually have run");
    assertEquals(j.errors, [], "a clean app reported errors");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am check: a server-only import that type-checks FAILS the check", async () => {
  const dir = await tempDir("am-check-bad-");
  try {
    // The exact shape from the report: a static server-only import reachable
    // from the UI entry. `deno check` is happy with it; the bundle is not.
    await makeApp(
      dir,
      `import { boom } from "./cell.ts";\n` +
        `export default function App() { return <div class="root">{boom()}</div>; }\n`,
      `import { readFileSync } from "node:fs";\n` +
        `export const boom = () => String(readFileSync);\n`,
    );
    const r = await amCheck(dir, ["--json"]);
    assertEquals(
      r.code,
      1,
      `a graph that cannot bundle exited 0 — this is the green check that was ` +
        `lying:\n${r.out}${r.err}`,
    );
    const j = JSON.parse(r.out) as {
      checked: boolean;
      errors: { file: string; message: string; fix: string }[];
    };
    assertEquals(j.checked, true);
    assertEquals(
      j.errors.length,
      1,
      `expected exactly the node:fs import to be reported, got ${
        JSON.stringify(j.errors)
      }`,
    );
    // What it SAYS is the reason it is worth producing: a count proves the
    // gate fired, not that anyone can act on it.
    assertStringIncludes(j.errors[0]!.message, "node:fs");
    assertStringIncludes(j.errors[0]!.fix, "browser");
    // The finding has to be locatable and actionable, not just present.
    assert(
      j.errors.some((e) => e.file.endsWith("cell.ts") && e.fix.length > 20),
      `the finding must name the file and say what to do: ${
        JSON.stringify(j.errors)
      }`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am check: no UI entry is reported LOUDLY, never as a silent pass", async () => {
  const dir = await tempDir("am-check-none-");
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ title: "serveronly", version: "0.1" }),
    );
    const r = await amCheck(dir);
    // Exit 0 is right — a server-only app genuinely has no client graph — but
    // "checked nothing" must not be indistinguishable from "checked and
    // clean". Reproducing this command's own bug one layer up would be a poor
    // joke.
    assertEquals(r.code, 0);
    assertStringIncludes(r.err, "NOTHING CHECKED");
    assertStringIncludes(r.err, "am check path/App.tsx");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am check: the scaffolded `check` task runs BOTH halves", async () => {
  // The command existing changes nothing on its own — the report's complaint is
  // about the task everyone actually runs, and the one CI runs.
  const tasks = standardTasks(true, "browser") as Record<string, string>;
  assertStringIncludes(tasks.check ?? "", "deno check");
  assertStringIncludes(
    tasks.check ?? "",
    "am",
    "`deno task check` still type-checks only — a task named `check` that " +
      "misses the failure mode the framework is known for is the defect, not " +
      "the missing command",
  );
  assertStringIncludes(tasks.check ?? "", "check");
});
