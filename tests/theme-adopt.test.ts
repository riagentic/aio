// `am theme adopt` — the safe way to build ON aio's look.
//
// An app that styles on top of a FRAMEWORK-owned stylesheet has its appearance
// depending on a file it does not control and has never read: an upgrade can
// move its UI with no compile error and no failing test. Adopting removes the
// dependency rather than promising to be careful with it — the rules become a
// file in the app's repo. These tests pin the three things that makes true.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { appThemeCss } from "../src/build/app-theme.ts";
import { generateHTML } from "../src/server/server-html-gen.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;

async function fixture(
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "aio-adopt-" });
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, rel), body);
  }
  return {
    dir,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

const DENO_JSON = JSON.stringify({ title: "shop", version: "0.1.0" });

async function adopt(dir: string, extra: string[] = []) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", AM, "theme", "adopt", ...extra],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    text: new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr),
  };
}

Deno.test("adopt writes the EXACT stylesheet the server would have emitted", async () => {
  const f = await fixture({
    "deno.json": DENO_JSON,
    "src/app.ts": "export {};\n",
  });
  try {
    const r = await adopt(f.dir);
    assertEquals(r.code, 0, r.text);
    const css = await Deno.readTextFile(join(f.dir, "src", "aio-theme.css"));
    // Byte-identical to the generator's output — an adopt that produced a
    // SIMILAR stylesheet would be a second copy of the theme, drifting from
    // the first the day either changes.
    const body = css.slice(css.indexOf("@layer aio {\n:root{"));
    assertEquals(body, appThemeCss("shop"));
    // …and it says what it is, where it came from, and that it is now the
    // app's. A 10 KB unexplained file in someone's repo is its own bug.
    assertStringIncludes(css, "THIS FILE IS YOURS");
    assertStringIncludes(css, "am theme adopt");
    // Reached, or adopting silently changed nothing. `@import` must be FIRST
    // or the browser drops it.
    const style = await Deno.readTextFile(join(f.dir, "src", "style.css"));
    assert(
      style.trimStart().startsWith('@import "./aio-theme.css";'),
      `the @import must lead style.css:\n${style}`,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("adopt composes with ui.theme:auto — exactly ONE theme exists", async () => {
  const f = await fixture({
    "deno.json": DENO_JSON,
    "src/app.ts": "export {};\n",
  });
  try {
    assertEquals((await adopt(f.dir)).code, 0);
    // The app now HAS a stylesheet, which is precisely the condition
    // `ui.theme: "auto"` steps aside for — so the framework stops emitting
    // its copy and the adopted file is the only one. No new switch, and no
    // way to end up with two.
    const shell = generateHTML(
      "shop",
      true,
      /* hasCSS (adopt created style.css) */ true,
      "{}",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "shop",
    );
    assert(
      !shell.includes(":where(main)"),
      "the framework still emitted its own theme next to the adopted one",
    );
    assertStringIncludes(shell, "style.css");
  } finally {
    await f.cleanup();
  }
});

Deno.test("adopt refuses to overwrite the file it already gave you", async () => {
  const f = await fixture({
    "deno.json": DENO_JSON,
    "src/app.ts": "export {};\n",
  });
  try {
    assertEquals((await adopt(f.dir)).code, 0);
    const themePath = join(f.dir, "src", "aio-theme.css");
    await Deno.writeTextFile(themePath, "/* MY EDITS */\n");

    const again = await adopt(f.dir);
    assertEquals(again.code, 1, "a second adopt must not silently clobber");
    assertStringIncludes(again.text, "it is YOURS now");
    assertEquals(await Deno.readTextFile(themePath), "/* MY EDITS */\n");

    // --force is the deliberate way through, and it says what it replaced.
    const forced = await adopt(f.dir, ["--force"]);
    assertEquals(forced.code, 0, forced.text);
    assertStringIncludes(
      await Deno.readTextFile(themePath),
      "THIS FILE IS YOURS",
    );
    // The import is not duplicated on a re-adopt.
    const style = await Deno.readTextFile(join(f.dir, "src", "style.css"));
    assertEquals(
      style.split('@import "./aio-theme.css";').length - 1,
      1,
      `the @import must appear exactly once:\n${style}`,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("adopt keeps an EXISTING style.css and leads it with the import", async () => {
  const f = await fixture({
    "deno.json": DENO_JSON,
    "src/app.ts": "export {};\n",
    "src/style.css": "body { background: rebeccapurple }\n",
  });
  try {
    assertEquals((await adopt(f.dir)).code, 0);
    const style = await Deno.readTextFile(join(f.dir, "src", "style.css"));
    assert(style.trimStart().startsWith('@import "./aio-theme.css";'));
    assertStringIncludes(style, "rebeccapurple"); // the app's own rules survive
  } finally {
    await f.cleanup();
  }
});
