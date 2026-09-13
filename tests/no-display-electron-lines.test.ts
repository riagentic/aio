// Foreground Electron dev with no display — the two lines must be true
// (report 9b §5).
//
// Under `env -u DISPLAY -u WAYLAND_DISPLAY deno task dev` a scaffolded
// Electron app printed:
//   INFO  · electron installed but its binary is missing (postinstall
//           skipped) — … `deno task dev --client=electron` … (they auto-install)
//   WARN  … no desktop session … The server is up at http://localhost:53850
// Both were false. The dev Electron app is UDS-only: nothing listened on that
// port (`curl` → 000) while `curl --unix-socket …/x.http.sock` answered 200.
// And `deno task dev` IS `--client=electron`: with no display no window
// launches, the install lives in the window launch (findElectronBin), and the
// binary was still missing when the run was killed.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { noDesktopSessionWarning } from "../src/server/aio-lifecycle.ts";
import { electronBinaryMissingLine, lint } from "../src/server/lint.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("no-display warning: a zero-port app names its sockets and the way to a URL, never a dead URL", () => {
  const w = noDesktopSessionWarning(
    { socketPath: "/r/x.sock", httpSocketPath: "/r/x.http.sock" },
    "http://localhost:53850",
  );
  assert(!w.includes("localhost:53850"), w);
  assert(!w.includes("http://localhost"), w);
  assertStringIncludes(w, "binds NO TCP port");
  assertStringIncludes(w, "curl --unix-socket /r/x.http.sock http://x/");
  assertStringIncludes(w, "/r/x.sock");
  assertStringIncludes(w, "--client=browser");
  assertStringIncludes(w, "am start --client=browser");
});

Deno.test("no-display warning: an app that really binds a port still gets its URL", () => {
  const w = noDesktopSessionWarning(
    { port: 53850 },
    "http://localhost:53850",
  );
  assertStringIncludes(w, "The server is up at http://localhost:53850");
});

Deno.test("binary-missing line: with no desktop session it does not promise an install this run", () => {
  const line = electronBinaryMissingLine(false);
  assert(!line.includes("(they auto-install)"), line);
  assert(!line.includes("deno task dev --client=electron"), line);
  assertStringIncludes(line, "NOTHING auto-installs it this run");
  assertStringIncludes(line, "deno task install:electron");
  assertStringIncludes(
    electronBinaryMissingLine(true),
    "auto-installs it when it launches the window",
  );
});

Deno.test("binary-missing line: lint raises it to WARN, worded for the session it runs in", async () => {
  const dir = await tempDir("no-display-lint-");
  const cwd = Deno.cwd();
  const saved = {
    DISPLAY: Deno.env.get("DISPLAY"),
    WAYLAND_DISPLAY: Deno.env.get("WAYLAND_DISPLAY"),
  };
  try {
    // The package without its binary: what a skipped postinstall leaves.
    await Deno.mkdir(join(dir, "node_modules", "electron"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() { return null; }\n",
    );
    Deno.chdir(dir);
    Deno.env.delete("DISPLAY");
    Deno.env.delete("WAYLAND_DISPLAY");
    const r = await lint({ n: 0 }, {}, dir, false, false, true);
    const missing = (xs: string[]) =>
      xs.filter((x) => x.includes("binary is missing"));
    if (Deno.build.os === "linux") {
      assertEquals(missing(r.warn), [electronBinaryMissingLine(false)]);
    } else {
      assertEquals(missing(r.warn), [electronBinaryMissingLine(true)]);
    }
    assertEquals(missing(r.hint), [], "no longer an INFO hint");
  } finally {
    Deno.chdir(cwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await dropTempDir(dir);
  }
});

Deno.test({
  name:
    "no-display warning: a real Electron dev boot without DISPLAY names the socket, not a port",
  ignore: Deno.build.os !== "linux", // hasDesktopSession answers from env on linux only
  async fn() {
    const dir = await tempDir("no-display-boot-");
    // Guard rail: were the no-display branch ever skipped, the launch would
    // hit this stand-in, never a real Electron on someone's desktop.
    const fake = join(dir, "electron");
    await Deno.writeTextFile(fake, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(fake, 0o755);
    const app = join(dir, "app");
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
      `import { cell } from "aio";\nexport const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });\n`,
    );
    await Deno.writeTextFile(
      join(app, "src", "App.tsx"),
      `import { c } from "./cell.ts";\nexport default function App() { return <p>{c.n}</p>; }\n`,
    );
    await Deno.writeTextFile(
      join(app, "src", "app.ts"),
      `import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run({});\n`,
    );
    const env: Record<string, string> = {
      ELECTRON_PATH: fake,
      AIO_APPS_DIR: join(dir, "home"),
    };
    for (const k of ["HOME", "PATH", "DENO_DIR", "XDG_CACHE_HOME", "TMPDIR"]) {
      const v = Deno.env.get(k);
      if (v !== undefined) env[k] = v;
    }
    const child = new Deno.Command(Deno.execPath(), {
      // No `--port`: an explicit port makes the app bind TCP, where the URL
      // form is the true one. The report's run was the default — UDS only.
      args: ["run", "-A", "src/app.ts", "--client=electron"],
      cwd: app,
      clearEnv: true, // no DISPLAY / WAYLAND_DISPLAY reaches the app
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const dec = new TextDecoder();
    let text = "";
    const pump = async (s: ReadableStream<Uint8Array>) => {
      for await (const chunk of s) text += dec.decode(chunk);
    };
    const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = Date.now() + 60_000;
      while (!text.includes("no desktop session") && Date.now() < deadline) {
        await new Promise((r) => {
          timer = setTimeout(r, 100);
        });
      }
      // The rest of the warning arrives in the same write; give it a beat.
      await new Promise((r) => {
        timer = setTimeout(r, 300);
      });
      const at = text.indexOf("no desktop session");
      assert(
        at >= 0,
        `no-display warning never printed:\n${text.slice(-2000)}`,
      );
      const warning = text.slice(at, text.indexOf("\n", at) + 1 || undefined);
      assertStringIncludes(warning, "binds NO TCP port");
      assertStringIncludes(warning, ".http.sock");
      assertStringIncludes(warning, "--client=browser");
      assert(!warning.includes("http://localhost"), warning);
    } finally {
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* aio-ok: already exited — the output below says why */
      }
      await child.status;
      await pumps;
      await dropTempDir(dir);
    }
  },
});
