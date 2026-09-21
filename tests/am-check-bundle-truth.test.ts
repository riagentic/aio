// `am check` — a green `deno check` must stop preceding a failing bundle.
//
// From a field report (report 4 §1 — the ONLY thing that report calls a defect).
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

const AIO_IMPORTS = (): Record<string, string> => ({
  "aio": `${REPO}mod.ts`,
  "aio/air": `${REPO}src/air.ts`,
  "aio/server": `${REPO}src/server-entry.ts`,
  "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
});

// What the scaffold writes. `lib` matters here: without it `deno check` on a
// .tsx entry reports hundreds of DOM errors, so a "premise, measured" assertion
// below would pass for the wrong reason.
const JSX_OPTS = {
  jsx: "react-jsx",
  jsxImportSource: "aio",
  lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
};

/** A minimal app in the layout the scaffold produces. `drop` removes keys from
 *  the import map, which is how an app that Deno itself cannot start is made.
 *  `configName` is the config FILENAME — Deno accepts `deno.jsonc` too, so
 *  every gate that reads the config must accept it as well. */
async function makeApp(
  dir: string,
  appTsx: string,
  extra = "",
  drop: string[] = [],
  configName = "deno.json",
): Promise<void> {
  await Deno.mkdir(`${dir}/src`, { recursive: true });
  const imports = AIO_IMPORTS();
  for (const k of drop) delete imports[k];
  const body = JSON.stringify({
    title: "checkapp",
    version: "0.1",
    imports,
    compilerOptions: JSX_OPTS,
  });
  await Deno.writeTextFile(
    `${dir}/${configName}`,
    // A real .jsonc: the comment is the whole reason the extension exists, and
    // a reader that only tolerates the NAME still breaks on the content.
    configName.endsWith(".jsonc")
      ? `// the app's config\n${body.replace("{", "{\n  // title below\n")}\n`
      : body,
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

Deno.test('am check: a name "aio" exports but the browser bundle lacks FAILS the check', async () => {
  // report 9b §3: `self` type-checked through mod.ts and only failed in
  // esbuild, because `am check` walked the graph without bundling it. `VERSION`
  // stays server-only, so it keeps this test red if the prod-graph bundle is
  // ever dropped from `am check` again.
  const dir = await tempDir("am-check-barrel-gap-");
  try {
    await makeApp(
      dir,
      `import { v } from "./cell.ts";\n` +
        `export default function App() { return <div class="root">{v}</div>; }\n`,
      `import { VERSION } from "aio";\nexport const v = VERSION;\n`,
    );
    const r = await amCheck(dir, ["--json"]);
    assertEquals(
      r.code,
      1,
      `a graph esbuild refuses exited 0:\n${r.out}${r.err}`,
    );
    assertStringIncludes(r.out, "VERSION");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am check: the `aio` mapping missing from deno.json FAILS the check", async () => {
  // THE gate that could not fire. `buildBrowserImportMap` injects `aio`,
  // `aio/ui`, `aio/jsx-runtime` … unconditionally (aio serves them from
  // `/__aio/*`), so the graph walk resolved every specifier and `am check`
  // printed "client graph OK" for an app whose very first command —
  // `deno run src/app.ts` — dies with
  // `Import "aio" not a dependency and not in import map`. Every later
  // "check passed" from this command was worth nothing while that held.
  const dir = await tempDir("am-check-no-aio-map-");
  try {
    await makeApp(
      dir,
      `import { v } from "./cell.ts";\n` +
        `export default function App() { return <div class="root">{v}</div>; }\n`,
      `import { cell } from "aio";\nexport const v = typeof cell;\n`,
      ["aio"],
    );
    // The app really is unstartable — the premise, measured, not assumed.
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["check", `${dir}/src/cell.ts`],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(run.code, 1, "premise broken: Deno resolved `aio` without it");

    const r = await amCheck(dir, ["--json"]);
    assertEquals(
      r.code,
      1,
      `am check was GREEN for an app Deno cannot resolve:\n${r.out}${r.err}`,
    );
    const j = JSON.parse(r.out) as {
      errors: { message: string; fix: string; line?: number }[];
    };
    const e = j.errors.find((e) => e.message.includes('"aio" is missing'));
    assert(e, `the missing mapping was not named: ${r.out}`);
    assertEquals(e!.line, 1, "the import's own line");
    // Named BY NAME, with the line that fixes it — inferred from the app's own
    // aio source, never a guess.
    assertStringIncludes(e!.fix, `"aio": "${REPO}mod.ts"`);
  } finally {
    await dropTempDir(dir);
  }
});

// ── "I could not read the config" is not "the config declares nothing" ───────
//
// `readAppDenoImports` answered `{}` to both questions, and `{}` is — by the
// contract in `GraphValidateOptions.appImports` — a REAL, CHECKED answer. So
// an app whose config Deno reads perfectly well got three fabricated BLOCKING
// errors ("`aio` is missing from this app's deno.json `imports`") naming
// imports that are right there in the file, from a command an agent runs to
// decide whether an app is healthy. `deno check` on the same tree exits 0.
//
// The framework does not log artificial, false or unreal errors
// (`.katana/principle.md`). These three cases pin that.

Deno.test("am check: a deno.jsonc app passes — Deno reads it, so aio must too", async () => {
  const dir = await tempDir("am-check-jsonc-");
  try {
    await makeApp(
      dir,
      `import { useLocal } from "aio/air";\n` +
        `import { v } from "./cell.ts";\n` +
        `export default function App() {\n` +
        `  return <div class="root">{typeof useLocal}{v}</div>;\n` +
        `}\n`,
      `import { cell } from "aio";\nexport const v = typeof cell;\n`,
      [],
      "deno.jsonc",
    );
    // The premise, measured: Deno itself resolves this app.
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["check", `${dir}/src/App.tsx`],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      run.code,
      0,
      `premise broken: deno check failed on the .jsonc app:\n${
        new TextDecoder().decode(run.stderr)
      }`,
    );

    const r = await amCheck(dir, ["--json"]);
    const j = JSON.parse(r.out) as {
      checked: boolean;
      errors: { message: string }[];
    };
    assertEquals(
      j.errors.filter((e) => e.message.includes("is missing from this app")),
      [],
      `fabricated "missing from deno.json" errors for imports the config ` +
        `declares — the config is a .jsonc and was not read:\n${r.out}`,
    );
    assertEquals(r.code, 0, `${r.out}${r.err}`);
    assertEquals(j.checked, true, "the check must actually have run");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am check: a deno.jsonc app with a REALLY missing import still FAILS", async () => {
  // The other half, and the one that matters more: reading .jsonc must not be
  // a way to make the gate vacuous. Same app, same extension, `aio/air`
  // deleted from the map — and it is still named.
  const dir = await tempDir("am-check-jsonc-gap-");
  try {
    await makeApp(
      dir,
      `import { useLocal } from "aio/air";\n` +
        `export default function App() {\n` +
        `  return <div class="root">{typeof useLocal}</div>;\n` +
        `}\n`,
      "",
      ["aio/air"],
      "deno.jsonc",
    );
    // The app really is unstartable — measured, not assumed.
    const run = await new Deno.Command(Deno.execPath(), {
      args: ["check", `${dir}/src/App.tsx`],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      run.code,
      1,
      "premise broken: Deno resolved `aio/air` without a mapping",
    );

    const r = await amCheck(dir, ["--json"]);
    assertEquals(
      r.code,
      1,
      `am check was GREEN for a .jsonc app Deno cannot resolve:\n${r.out}${r.err}`,
    );
    const j = JSON.parse(r.out) as {
      errors: { message: string; fix: string }[];
    };
    const e = j.errors.find((e) => e.message.includes('"aio/air" is missing'));
    assert(e, `the missing mapping was not named: ${r.out}`);
    // Inferred from the app's OWN aio source, read out of the .jsonc.
    assertStringIncludes(e!.fix, `"aio/air": "${REPO}src/air.ts"`);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am check: a workspace member inherits the root's import map", async () => {
  // Deno workspaces: the ROOT's import map applies to every member. A member
  // two levels down whose own config declares no `imports` resolves `aio`
  // perfectly well — and got three blocking errors saying it does not, because
  // only the member's config was read.
  const root = await tempDir("am-check-ws-");
  try {
    const app = `${root}/packages/app`;
    await Deno.mkdir(`${app}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({
        workspace: ["./packages/app"],
        imports: AIO_IMPORTS(),
        compilerOptions: JSX_OPTS,
      }),
    );
    await Deno.writeTextFile(
      `${app}/deno.json`,
      JSON.stringify({
        name: "@ws/app",
        version: "0.1.0",
        compilerOptions: JSX_OPTS,
      }),
    );
    await Deno.writeTextFile(
      `${app}/src/cell.ts`,
      `import { cell } from "aio";\nexport const v = typeof cell;\n`,
    );
    await Deno.writeTextFile(
      `${app}/src/App.tsx`,
      `import { useLocal } from "aio/air";\n` +
        `import { v } from "./cell.ts";\n` +
        `export default function App() {\n` +
        `  return <div class="root">{typeof useLocal}{v}</div>;\n` +
        `}\n`,
    );
    await Deno.writeTextFile(`${app}/src/app.ts`, "export const x = 1;\n");

    const run = await new Deno.Command(Deno.execPath(), {
      args: ["check", `${app}/src/App.tsx`],
      cwd: app,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      run.code,
      0,
      `premise broken: deno check failed in the workspace member:\n${
        new TextDecoder().decode(run.stderr)
      }`,
    );

    const r = await amCheck(app, ["--json"]);
    const j = JSON.parse(r.out) as { errors: { message: string }[] };
    assertEquals(
      j.errors.filter((e) => e.message.includes("is missing from this app")),
      [],
      `fabricated "missing from deno.json" errors for a workspace member ` +
        `whose root declares them:\n${r.out}`,
    );
    assertEquals(r.code, 0, `${r.out}${r.err}`);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("am check: an unreadable config SKIPS the import gate and SAYS so", async () => {
  // The remaining honest case: no config anywhere. Silence here would be the
  // same bug one layer down — the gate looked at nothing, so it says it looked
  // at nothing instead of inventing three findings or quietly passing.
  const dir = await tempDir("am-check-no-config-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/src/App.tsx`,
      `export default function App() { return <div class="root">hi</div>; }\n`,
    );
    const r = await amCheck(dir, ["--json"]);
    const fabricated = r.out.includes("is missing from this app");
    assertEquals(
      fabricated,
      false,
      `"could not read the config" was reported as "the config is empty":\n${r.out}`,
    );
    assertStringIncludes(r.err, "SKIPPED");
    assertStringIncludes(r.err, "deno.jsonc");
  } finally {
    await dropTempDir(dir);
  }
});
