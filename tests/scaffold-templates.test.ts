// `--template=canvas` and `--template=assets`.
//
// _"A template encodes tribal knowledge that documentation cannot make anyone
// read, and it cannot break an existing app."_ (report 6 §10.6). These two
// encode the knowledge two OTHER reports produced: the shape that makes a
// canvas app testable (report 6 §6), and the pair of declarations an `assets`
// mount needs (report 6 §7).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { scaffold, TEMPLATES } from "../src/am/am-cmd-create.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const files = (t: "counter" | "todo" | "canvas" | "assets") =>
  scaffold(`probe-${t}`, t, true, "browser");

Deno.test("every template is scaffoldable, and every file says something", () => {
  // A name in the list that produces nothing is worse than no name: the
  // command succeeds and the project does not run.
  assertEquals(
    TEMPLATES.length,
    5,
    "the list itself must be non-empty, or the loop below proves nothing",
  );
  let checked = 0;
  for (const t of TEMPLATES) {
    const f = scaffold(`probe-${t}`, t, true, "browser");
    assert(Object.keys(f).length >= 4, `${t} scaffolded ${Object.keys(f)}`);
    // What each file must SAY, not merely that it is non-empty — a single
    // space passes "length > 0" and produces a project that does not run.
    assertStringIncludes(f["deno.json"] ?? "", `"title": "probe-${t}"`);
    assertStringIncludes(f["deno.json"] ?? "", '"tasks"');
    assertStringIncludes(f["README.md"] ?? "", `probe-${t}`);
    for (const name of Object.keys(f)) {
      if (!/\.tsx?$/.test(name)) continue;
      // Every scaffolded module either imports something or exports
      // something; a file that does neither is not source, it is filler.
      assert(
        /\b(import|export)\b/.test(f[name]!),
        `${t}: ${name} neither imports nor exports anything`,
      );
      checked++;
    }
  }
  assert(checked >= TEMPLATES.length, `only ${checked} modules were checked`);
});

Deno.test("canvas: the DECISION is pure, and the test covers it without a GPU", () => {
  // The whole point of the template. Under happy-dom there is no WebGL
  // context, so anything that needs one cannot be tested at all — which is why
  // the decisions come out of the imperative shell.
  const f = files("canvas");
  const cell = f["src/cell.ts"]!;
  assert(cell.includes("export function step("), "the pure function exists");
  // API USE, not the word: the file's own comments say "canvas" precisely
  // because they are explaining that it does not touch one.
  const code = cell.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  assert(
    !/getContext\(|document\.|HTMLCanvas|requestAnimationFrame/.test(code),
    "the decision must not touch a canvas, or it cannot be tested",
  );
  const test = f["tests/cell.test.ts"]!;
  assert(test.includes("step("), "…and the test calls it directly");
  assert(
    !/getContext\(/.test(test),
    "a canvas in the test is a test that cannot run under happy-dom",
  );
  // The UI is the shell, and it is allowed to be untestable.
  assert(f["src/App.tsx"]!.includes("getContext"), "the shell draws");
});

Deno.test("assets: the mount and the directory ship TOGETHER", () => {
  // A mount with no directory is a 404; a directory with no mount is a 404
  // that looks like a build problem. Either alone is worse than neither.
  const f = files("assets");
  const json = JSON.parse(f["deno.json"]!);
  assertEquals(json.assets, { "/media": "./media" });
  assert(f["media/hello.txt"], "the directory the mount points at must exist");
  // …and the UI actually fetches through the mount, so the first run proves it.
  assert(f["src/App.tsx"]!.includes("/media/hello.txt"));
});

Deno.test("the other templates carry no `assets` key", () => {
  // A template that quietly declares a mount nobody asked for would embed a
  // directory in every binary built from it.
  for (const t of ["counter", "todo"] as const) {
    assertEquals(JSON.parse(files(t)["deno.json"]!).assets, undefined);
    assertEquals(files(t)["media/hello.txt"], undefined);
  }
});

Deno.test("deno.json gets the REAL template, not a hardcoded one", () => {
  // `denoJson(name, source, target, "counter", css)` was passed a literal, so
  // every template's tasks were the counter's. Nothing noticed because the two
  // templates that existed agreed.
  const todo = JSON.parse(files("todo")["deno.json"]!);
  const cli = JSON.parse(
    scaffold("probe-cli", "cli", true, "cli")["deno.json"]!,
  );
  assert(todo.tasks, "tasks exist");
  // The cli template's dev task is its own (`serve`), which is the one place
  // the template genuinely changes the file.
  assert(
    String(cli.tasks.dev).includes("serve"),
    `the cli template's dev task is its own: ${cli.tasks.dev}`,
  );
});

Deno.test({
  name: "every scaffolded source still PARSES, for the new templates too",
  // esbuild runs through a native child that is SHARED by every test file in
  // this process. Calling `esbuild.stop()` here would tear it down under
  // whichever other file is mid-build — measured: four tests in three files
  // failed that way in the full suite and passed alone. So the child is left
  // running and the sanitizers are told why.
  sanitizeOps: false, // aio-ok: esbuild's shared service child
  sanitizeResources: false, // aio-ok: same
  async fn() {
    // These are TypeScript inside a TypeScript template literal; a mis-escaped
    // backtick ships a broken file the scaffold calls a success.
    const esbuild = await import("esbuild");
    try {
      for (const t of TEMPLATES) {
        const f = scaffold(`p-${t}`, t, true, "browser");
        for (const [name, text] of Object.entries(f)) {
          if (!/\.tsx?$/.test(name)) continue;
          await esbuild.transform(text, {
            loader: name.endsWith(".tsx") ? "tsx" : "ts",
            jsx: "automatic",
          }).catch((e) => {
            throw new Error(`${t}/${name}: ${e}`);
          });
        }
      }
    } finally {
    }
  },
});

Deno.test({
  name: "every scaffolded template TYPE-CHECKS against this framework",
  // Slower than the rest of the file (a `deno check` per template), and worth
  // it: the parse gate above catches a mis-escaped backtick and says nothing
  // about a `ref` callback whose parameter type is wrong. That exact error
  // shipped in the canvas template and was found by scaffolding one by hand —
  // which is not a gate.
  sanitizeOps: false, // aio-ok: `deno check` child
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const repo = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    for (const t of TEMPLATES) {
      const dir = await tempDir(`aio-tpl-${t}-`);
      try {
        const f = scaffold(`tplprobe-${t}`, t, true, "browser");
        for (const [name, body] of Object.entries(f)) {
          const path = `${dir}/${name}`;
          await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
            recursive: true,
          }).catch(() => {});
          await Deno.writeTextFile(path, body);
        }
        // The scaffold's own import map points at `dep/aio`; this test has a
        // repo instead, so it links the two the way `am link` does.
        await Deno.mkdir(`${dir}/dep`, { recursive: true });
        await Deno.symlink(repo, `${dir}/dep/aio`);

        const out = await new Deno.Command(Deno.execPath(), {
          args: ["check", "src/"],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
        if (!out.success) {
          throw new Error(
            `--template=${t} scaffolds source that does not type-check:\n` +
              new TextDecoder().decode(out.stderr).split("\n").slice(0, 20)
                .join("\n"),
          );
        }
      } finally {
        await dropTempDir(dir);
      }
    }
  },
});
