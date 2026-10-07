// Every `ui` key an app configures reaches the Electron launch.
//
// `aio.run` handed the lifecycle a hand-picked FIVE-key copy of `ui`
// (width, height, showStatus, viewport, head). The lifecycle then read
// `ui.chrome`, `ui.theme`, `ui.layout`, `ui.lang` — and later `ui.tray` — from
// an object that never carried them, so the dev Electron window drew the OS
// frame whatever the app asked for, and an app that configured a tray got
// `const TRAY = null` in its generated main. Measured on a real Electron: the
// window closed and the app quit with `closeToTray: true`.
//
// This test replaces the Electron binary with a script that CAPTURES the
// generated main (`$ELECTRON_PATH` is the documented override), boots an app
// with every head-shaped key set, and reads them back out of the script the
// launch actually produced — the instrument, not the config.
import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { EXE, writeProgram } from "./fake-program-helper.ts";
import { spec } from "./module-spec-helper.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

Deno.test({
  name:
    "electron launch: chrome, head and tray reach the generated main (the picked ui copy carries every key)",
  sanitizeOps: false, // aio-ok: a child deno process, waited for and killed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const dir = await tempDir("aio-elaunch");
    const captured = join(dir, "captured-main.cjs");
    // The fake electron: keep the main script, stay alive briefly so the
    // launch reads as healthy, exit 0 so the app shuts itself down.
    // (A program that hands its arguments to a script the real deno runs —
    // it was a shell script, which Windows cannot run.)
    const fake = join(dir, `electron${EXE}`);
    await Deno.writeTextFile(
      join(dir, "electron.ts"),
      `Deno.copyFileSync(Deno.args[0], ${JSON.stringify(captured)});\n` +
        `await new Promise((r) => setTimeout(r, 4000));\n`,
    );
    await writeProgram(
      fake,
      `#!/bin/sh\nexec "${Deno.execPath()}" run -A --no-config "${
        join(dir, "electron.ts")
      }" "$@"\n`,
    );
    // A one-cell app with every head-shaped key set.
    const app = join(dir, "app");
    await Deno.mkdir(join(app, "src"), { recursive: true });
    const head = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
    const imports: Record<string, string> = {};
    for (
      const [k, v] of Object.entries(head.imports as Record<string, string>)
    ) {
      imports[k] = v.startsWith("./") ? `${spec(ROOT)}/${v.slice(2)}` : v;
    }
    await Deno.writeTextFile(
      join(app, "deno.json"),
      JSON.stringify({
        compilerOptions: head.compilerOptions,
        imports,
        nodeModulesDir: head.nodeModulesDir,
      }),
    );
    await Deno.writeTextFile(
      join(app, "src", "cell.ts"),
      `import { cell } from "aio";\nexport const c = cell("c", { state: { n: 0 }, methods: { pause(s) { s.n++; } } });\n`,
    );
    await Deno.writeTextFile(
      join(app, "src", "App.tsx"),
      `import { c } from "./cell.ts";\nexport default function App() { return <p>{c.n}</p>; }\n`,
    );
    await Deno.writeTextFile(
      join(app, "src", "app.ts"),
      `import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run({ ui: { title: "Carried", chrome: "none", theme: "auto", layout: false, lang: "de", head: "<meta name=\\"carried-head\\">", tray: { tooltip: "Carried tray", closeToTray: true, menu: [{ label: "Pause", method: "c:pause" }] } } });\n`,
    );
    const port = freePort();
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "src/app.ts", "--client=electron", `--port=${port}`],
      cwd: app,
      env: {
        ELECTRON_PATH: fake,
        AIO_APPS_DIR: join(dir, "home"),
        DISPLAY: Deno.env.get("DISPLAY") ?? ":0",
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let script = "";
    try {
      for (let i = 0; i < 300 && !script; i++) {
        await new Promise((r) => setTimeout(r, 100));
        script = await Deno.readTextFile(captured).catch(() => "");
      }
      assert(
        script,
        "the fake electron never received a main script — did the launch happen?",
      );
      assertStringIncludes(
        script,
        '"closeToTray":true',
        "ui.tray reached the shell",
      );
      assertStringIncludes(script, '"label":"Pause"');
      assertStringIncludes(script, '"tooltip":"Carried tray"');
      assertStringIncludes(
        script,
        "b.frame = false",
        'ui.chrome: "none" reached the window shape',
      );
      assertStringIncludes(script, "carried-head", "ui.head reached the shell");
      // NOT asserted here: theme, layout and lang. In a DEV launch the page is
      // the server's (aio-server.ts renders them from config.ui directly);
      // only the packaged aio:// shell templates them into the main. They
      // travel in the same object as the five above, so the copy that
      // carries tray and chrome carries them too.
    } finally {
      try {
        child.kill("SIGTERM");
      } catch {
        /* aio-ok: already gone — the fake electron's exit shut it down */
      }
      const out = await child.output();
      const text = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      if (!script) {
        console.error(text.slice(-1500));
      }
    }
  },
});
