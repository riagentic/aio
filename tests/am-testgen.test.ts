// `am testgen` — a typed test client, without the script.
//
// `ui.App["tab-settings"]` is a string key whose typo is a runtime `undefined`
// (llama.master §11, §18). The GENERATOR already answered that: types come
// from what actually renders, so `ui.App.SaveButton.click()` autocompletes and
// a renamed button breaks the test at compile time.
//
// What did not exist was a way to RUN it — importing happy-dom, constructing a
// document, importing the App and its cells, and remembering to re-run. That
// ceremony is why an app which HAD the feature available kept using string
// keys, which is this round's meta-finding for the tenth time.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { DEFAULT_TESTGEN_OUT } from "../src/am/am-cmd-testgen.ts";

const REPO = new URL("..", import.meta.url).pathname;

async function am(
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}src/am.ts`, ...args],
    cwd,
    env: { AIO_APPS_DIR: `${cwd}/.aio-home` },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
}

async function makeApp(dir: string, appTsx: string): Promise<void> {
  await Deno.mkdir(`${dir}/src`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      title: "tgapp",
      version: "0.1",
      imports: {
        "aio": `${REPO}mod.ts`,
        "aio/air": `${REPO}src/air.ts`,
        "aio/testing": `${REPO}src/cell-test.ts`,
        "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
        "happy-dom": "npm:happy-dom@^17",
      },
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
    }),
  );
  await Deno.writeTextFile(`${dir}/src/App.tsx`, appTsx);
}

Deno.test("am testgen writes a typed client naming the real elements", async () => {
  const dir = await tempDir("am-testgen-");
  try {
    await makeApp(
      dir,
      `export default function App() {\n` +
        `  return (\n` +
        `    <div class="root">\n` +
        `      <button type="button">Save</button>\n` +
        `      <input aria-label="Title" />\n` +
        `      <span t="tab-settings">settings</span>\n` +
        `    </div>\n` +
        `  );\n` +
        `}\n`,
    );
    const r = await am(["testgen"], dir);
    assertEquals(r.code, 0, r.out + r.err);
    const gen = await Deno.readTextFile(`${dir}/${DEFAULT_TESTGEN_OUT}`);
    // The names a test would address, typed — including the `t=` handle whose
    // typo was the whole complaint.
    assertStringIncludes(gen, "SaveButton");
    assertStringIncludes(gen, "TitleInput");
    assertStringIncludes(gen, "tab-settings");
    assertStringIncludes(gen, "TypedTestUI");
    // …and it says so, rather than writing a file in silence.
    assert(
      (r.out + r.err).includes(DEFAULT_TESTGEN_OUT),
      `it must name the file it wrote: ${r.out}${r.err}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("--out puts it where you ask, creating the directory", async () => {
  const dir = await tempDir("am-testgen-out-");
  try {
    await makeApp(
      dir,
      `export default function App() { return <button type="button">Go</button>; }\n`,
    );
    const r = await am(["testgen", "--out=generated/deep/ui.ts"], dir);
    assertEquals(r.code, 0, r.out + r.err);
    const gen = await Deno.readTextFile(`${dir}/generated/deep/ui.ts`);
    assertStringIncludes(gen, "GoButton");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("no UI entry is LOUD, never a silent empty file", async () => {
  // "Wrote 0 types" and "there is no UI" are the same file on disk, and only
  // one of them is a problem. The same call `am check` makes.
  const dir = await tempDir("am-testgen-none-");
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ title: "serveronly", version: "0.1" }),
    );
    const r = await am(["testgen"], dir);
    assertEquals(r.code, 1);
    assert(
      (r.out + r.err).includes("no UI entry"),
      `${r.out}${r.err}`,
    );
    assertEquals(
      await Deno.stat(`${dir}/${DEFAULT_TESTGEN_OUT}`).then(() => true).catch(
        () => false,
      ),
      false,
      "a failed run must not leave a file behind",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am help teaches what it is FOR, not just that it exists", async () => {
  const help = await Deno.readTextFile(
    new URL("../src/am/am-help-text.ts", import.meta.url),
  );
  assertStringIncludes(help, "testgen");
  assert(
    /testgen[\s\S]{0,400}COMPILE time/.test(help),
    "the help has to name the CONSEQUENCE — a typo caught at compile time " +
      "instead of a runtime undefined — or an agent greps for its own word " +
      "and never finds this",
  );
});
