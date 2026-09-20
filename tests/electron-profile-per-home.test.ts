// Two homes of one app are two instances — and two Chromium profiles.
//
// aio lets a second instance run beside the first when its home differs (the
// lock key is `lockKey(appId, home)` → `<appId>@<hash8(home)>`). The Electron
// userData directory was keyed by the app TITLE alone, so both windows shared
// ONE Chromium profile: one cache, one Local Storage, one IndexedDB. A field
// report measured the consequence — the second instance answered
// `net::ERR_CACHE_READ_FAILURE` on a script and rendered a blank window; with
// the profile pointed elsewhere, 0 failures in 1674 requests on the same
// machine.
//
// The generator half is a unit test (`electron.test.ts`); this is the WIRING:
// a real boot with a non-default home, its Electron binary replaced by a
// script that captures the generated main, read back out of what the launch
// actually produced.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { electronProfileName } from "../src/electron/electron-shared.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test({
  name:
    "electron launch: a non-default home opens its OWN Chromium profile (keyed like the lock)",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false, // aio-ok: a child deno process, waited for and killed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const dir = await tempDir("aio-elprofile");
    const captured = join(dir, "captured-main.cjs");
    const fake = join(dir, "electron");
    await Deno.writeTextFile(
      fake,
      `#!/bin/sh\ncp "$1" "${captured}"\nsleep 4\nexit 0\n`,
    );
    await Deno.chmod(fake, 0o755);

    const app = join(dir, "app");
    // The app's home: NOT where `AIO_APPS_DIR` would put it — a second copy of
    // one app, exactly the shape the report ran.
    const otherHome = join(dir, "second-home");
    await Deno.mkdir(join(app, "src"), { recursive: true });
    const head = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
    const imports: Record<string, string> = {};
    for (
      const [k, v] of Object.entries(head.imports as Record<string, string>)
    ) {
      imports[k] = v.startsWith("./") ? `${ROOT}/${v.slice(2)}` : v;
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
      `import { cell } from "aio";\nexport const c = cell("c", { state: { n: 0 }, methods: { bump(s) { s.n++; } } });\n`,
    );
    await Deno.writeTextFile(
      join(app, "src", "App.tsx"),
      `import { c } from "./cell.ts";\nexport default function App() { return <p>{c.n}</p>; }\n`,
    );
    await Deno.writeTextFile(
      join(app, "src", "app.ts"),
      `import "./cell.ts";\nimport { aio } from "aio";\n` +
        `await aio.run({ appId: "profiled", appDir: ${
          JSON.stringify(otherHome)
        }, ui: { title: "Profiled App" } });\n`,
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
      const want = electronProfileName("profiled", "Profiled App", otherHome);
      assert(
        want.includes("@"),
        `a non-default home must be tagged, got "${want}"`,
      );
      assertStringIncludes(
        script,
        `app.name = ${JSON.stringify(want)}`,
        "the window must open the profile this HOME owns, not the title's",
      );
    } finally {
      try {
        child.kill("SIGTERM");
      } catch {
        /* aio-ok: already gone — the fake electron's exit shut it down */
      }
      const out = await child.output();
      const text = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      if (!script) console.error(text.slice(-1500));
    }
  },
});
