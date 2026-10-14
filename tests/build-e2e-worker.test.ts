// Browser workers in the ARTIFACTS — the compiled binary run from a foreign
// cwd, the `web` folder served under a sub-path, the packaged Electron app.
//
// `new Worker(new URL("./w.ts", import.meta.url))` loaded in dev and from no
// build at all (the Worker's `error` event, no message). The build now writes
// one bundle per worker beside `app.js`; what is proven here is that every
// target CARRIES them and its page can start them: a module worker with a
// bare import, a classic worker and the worker it starts, a shared worker,
// and — as before — a file in a deno.json `assets` mount. Every one under a
// STRICT Content-Security-Policy (`default-src 'self'`): the app's own in the
// binary and in the Electron window, the same policy sent by the host for the
// `web` folder — a worker beside the bundle is 'self' in all three.
// (`browser-worker-mount-chromium.test.ts` holds dev and `--prod`.)
//
// Opt-in like every artifact test (AIO_BUILD_E2E=1; the Electron leg also
// AIO_BUILD_ELECTRON=1, on the contained test display).
import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs";
import { extname, join } from "@std/path";
import {
  buildFlags,
  childEnv,
  freePort,
  kill,
  makeApp,
  placedBinary,
  REPO_ROOT,
  waitForHttp,
} from "./e2e-app-harness.ts";
import { browserOsFlags, findBrowser } from "./e2e-harness.ts";
import { cdpConnect } from "../src/media/cdp.ts";
import { isWorkerBundle } from "../src/server/app-files.ts";
import {
  contentSecurityPolicy,
  frameAncestors,
} from "../src/server/security-headers.ts";
import { desktopEnv, unpackDesktop } from "../src/build/smoke.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { stopChild } from "./stop-child.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";
import { WORKER_ANSWERS, writeWorkerApp } from "./worker-app-fixture.ts";
import { browserHomeEnv } from "../src/testing/chromium.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";
const ELECTRON = GATE && Deno.env.get("AIO_BUILD_ELECTRON") === "1";
const BROWSER = findBrowser();

async function waitFor<T>(
  what: () => string,
  fn: () =>
    | Promise<T | null | undefined | false>
    | T
    | null
    | undefined
    | false,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v !== null && v !== undefined && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${what()}`);
}

/** The worker app as a project a build can run in: the scaffold's deno.json
 *  (aio from this checkout), the fixture's sources, the mount declared. */
async function workerProject(): Promise<string> {
  const dir = await makeApp("counter", "build-e2e-worker-");
  await writeWorkerApp(dir);
  await Deno.writeTextFile(
    join(dir, "src/app.ts"),
    `import "./cells.ts";\nimport { aio } from "aio";\n` +
      `await aio.run({ persist: false, security: { csp: "strict" } });\n`,
  );
  const cfgPath = join(dir, "deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
  cfg.assets = { "/workers": "./workers" };
  await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
  // The worker's own npm import, installed as an app's author installs it.
  await fixtureNodeModules(dir);
  return dir;
}

/** A headless Chromium and `answers(url)`: what the page at `url` shows once
 *  every worker has reported. */
async function chromium(foreign: string) {
  const profile = await tempDir("aio-worker-chromium-");
  const browser = new Deno.Command(BROWSER!, {
    args: [
      ...browserOsFlags,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--password-store=basic",
      "--use-mock-keychain",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    cwd: foreign,
    env: { ...browserHomeEnv(profile), ...testDisplayEnv() },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  let cdp: Awaited<ReturnType<typeof cdpConnect>> | null = null;
  const close = async () => {
    await cdp?.close();
    await stopChild(browser, { quiet: true });
    await dropTempDir(profile);
  };
  try {
    const wsUrl = await waitFor(() => "devtools", async () => {
      const p = Number(
        (await Deno.readTextFile(`${profile}/DevToolsActivePort`))
          .split("\n")[0],
      );
      const targets = await (await fetch(`http://127.0.0.1:${p}/json`))
        .json() as { type: string; webSocketDebuggerUrl: string }[];
      return targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    });
    cdp = await cdpConnect(wsUrl);
  } catch (e) {
    await close();
    throw e;
  }
  const c = cdp;
  const answers = async (url: string): Promise<Record<string, string>> => {
    await c.call("Page.navigate", { url });
    let last = "";
    return await waitFor(
      () => `every worker at ${url} (page shows ${last})`,
      async () => {
        const r = await c.call("Runtime.evaluate", {
          expression: `document.getElementById("r")?.textContent ?? ""`,
          returnByValue: true,
        }) as { result?: { value?: string } };
        last = r.result?.value ?? "";
        const seen = JSON.parse(last || "{}") as Record<string, string>;
        return Object.keys(WORKER_ANSWERS).every((k) => k in seen)
          ? seen
          : null;
      },
    );
  };
  return { answers, close };
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

Deno.test({
  name:
    "artifact: browser workers run from the compiled binary (foreign cwd) and from a `web` build under /repo/",
  ignore: !GATE || BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): external browser, the binary and a static server, all stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the children outlive the check
  async fn() {
    const dir = await workerProject();
    const foreign = await tempDir("foreign-cwd-worker-");
    let page: Awaited<ReturnType<typeof chromium>> | undefined;
    let server: Deno.ChildProcess | undefined;
    let site: Deno.HttpServer | undefined;
    try {
      page = await chromium(foreign);

      // ── the compiled binary, from a foreign cwd ──
      const b = await buildFlags(dir, "--compile");
      assertEquals(b.code, 0, `compile failed:\n${b.out}\n${b.err}`);
      assert(
        !(b.out + b.err).includes("started as a Worker"),
        `the build warned about a worker it bundles:\n${b.out}\n${b.err}`,
      );
      // Windows starts a program by its extension. (The copy keeps the mode.)
      const bin = join(
        foreign,
        Deno.build.os === "windows" ? "app-bin.exe" : "app-bin",
      );
      await Deno.copyFile(placedBinary(dir), bin);
      const port = freePort();
      const home = join(foreign, "home");
      server = new Deno.Command(bin, {
        args: ["--client=server-only", `--port=${port}`],
        cwd: foreign,
        env: childEnv({ AIO_APPS_DIR: home, HOME: home }),
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      await waitForHttp(`http://127.0.0.1:${port}/`, 60_000);
      assertEquals(
        await page.answers(`http://127.0.0.1:${port}/`),
        WORKER_ANSWERS,
        "the compiled binary",
      );
      await kill(server);
      server = undefined;

      // ── the web build, under a sub-path ──
      const w = await buildFlags(dir, "--web");
      assertEquals(w.code, 0, `web build failed:\n${w.out}\n${w.err}`);
      const webDir = [...Deno.readDirSync(join(dir, "dist"))]
        .find((e) => e.isDirectory && e.name.endsWith("-web"))!;
      const root = join(foreign, "site");
      await copy(join(dir, "dist", webDir.name), root);
      const staged = [...Deno.readDirSync(root)].map((e) => e.name)
        .filter(isWorkerBundle);
      assertEquals(staged.length, 3, staged.join(" "));
      const sw = await Deno.readTextFile(join(root, "sw.js"));
      for (const name of staged) {
        assert(sw.includes(`"./${name}":"sha256-`), `${name} not pinned`);
      }
      const sitePort = freePort();
      site = Deno.serve(
        { hostname: "127.0.0.1", port: sitePort, onListen: () => {} },
        async (req) => {
          let path = decodeURIComponent(new URL(req.url).pathname);
          if (!path.startsWith("/repo/")) {
            return new Response("not found", { status: 404 });
          }
          path = path.slice("/repo".length);
          if (path.endsWith("/")) path += "index.html";
          try {
            return new Response(await Deno.readFile(join(root, path)), {
              headers: {
                "content-type": TYPES[extname(path)] ??
                  "application/octet-stream",
                "content-security-policy": contentSecurityPolicy(
                  { csp: "strict" },
                  frameAncestors(),
                )!,
              },
            });
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
            return new Response("not found", { status: 404 });
          }
        },
      );
      assertEquals(
        await page.answers(`http://127.0.0.1:${sitePort}/repo/`),
        WORKER_ANSWERS,
        "the web build under /repo/",
      );
    } finally {
      if (server) await kill(server);
      await page?.close();
      await site?.shutdown();
      await Deno.remove(dir, { recursive: true });
      await dropTempDir(foreign);
    }
  },
});

/** Run `cmd` as the Electron app on the test display and answer what its
 *  workers reported (the `probe` cell prints each as `PROBE k=v`). */
async function electronAnswers(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<Record<string, string>> {
  const home = await tempDir("worker-electron-home-");
  const proc = new Deno.Command(cmd, {
    args,
    cwd,
    env: childEnv({
      ...testDisplayEnv(),
      ...env,
      AIO_APPS_DIR: home,
      // Electron's profile (userData) — never the developer's ~/.config.
      XDG_CONFIG_HOME: join(home, "config"),
      APPIMAGE_EXTRACT_AND_RUN: "1",
      TMPDIR: home,
    }),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let out = "";
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) out += new TextDecoder().decode(c);
  };
  drain(proc.stdout).catch(() => {});
  drain(proc.stderr).catch(() => {});
  const seen = () =>
    Object.fromEntries(
      [...out.matchAll(/PROBE (\w+)=(\S+)/g)].map((m) => [m[1]!, m[2]!]),
    );
  try {
    await waitFor(
      () =>
        `every worker (saw ${JSON.stringify(seen())}):\n${out.slice(-6000)}`,
      () => Object.keys(WORKER_ANSWERS).every((k) => k in seen()),
      120_000,
    );
    return seen();
  } finally {
    // Windows has no process group to signal: the tree, by its root's pid,
    // while the root is still there to walk from.
    if (Deno.build.os === "windows") {
      await new Deno.Command("taskkill", {
        args: ["/T", "/F", "/PID", String(proc.pid)],
        stdout: "null",
        stderr: "null",
      }).output();
    }
    await kill(proc);
    await dropTempDir(home);
  }
}

Deno.test({
  name:
    "artifact: browser workers run in an Electron window — dev, and the packaged app (foreign cwd, no source tree)",
  ignore: !ELECTRON || Deno.build.os !== "linux" || !testDisplayEnv().DISPLAY,
  sanitizeOps: false, // aio-ok(sanitizers): a real Electron child owns sockets and timers; teardown kills it
  sanitizeResources: false, // aio-ok(sanitizers): same
  async fn() {
    const dir = await workerProject();
    const foreign = await tempDir("foreign-cwd-worker-electron-");
    try {
      // ── dev: the window asks the dev server for each worker, bundled ──
      assertEquals(
        await electronAnswers(
          "deno",
          ["run", "-A", "src/app.ts", "--client=electron"],
          dir,
          {
            ELECTRON_PATH: join(
              REPO_ROOT,
              "node_modules/electron/dist/electron",
            ),
          },
        ),
        WORKER_ANSWERS,
        "dev",
      );

      // ── the package: once as written, once with NO mount declared ──
      // With a mount (or a route) the window has the app's handler behind
      // it; without one the handler is not started at all, and the package's
      // own dist/ is everything the window can read.
      const packaged = async (as: string) => {
        const r = await buildFlags(dir, "--compile", "--electron");
        assertEquals(r.code, 0, `electron build failed:\n${r.out}\n${r.err}`);
        const image = [...Deno.readDirSync(join(dir, "dist"))]
          .map((e) => e.name).find((n) =>
            n.toLowerCase().endsWith(".appimage")
          );
        assert(image, "no AppImage in dist/");
        const to = join(foreign, as);
        await Deno.copyFile(join(dir, "dist", image), to);
        await Deno.chmod(to, 0o755);
        return to;
      };
      const withMount = await packaged("mount.AppImage");
      const cfgPath = join(dir, "deno.json");
      const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
      delete cfg.assets;
      await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
      const diskOnly = await packaged("disk.AppImage");
      // Only what each package carries can answer.
      await Deno.rename(join(dir, "src"), join(dir, "src.moved"));
      await Deno.rename(join(dir, "workers"), join(dir, "workers.moved"));
      assertEquals(
        await electronAnswers(withMount, ["--client=electron"], foreign),
        WORKER_ANSWERS,
        "packaged, with the assets mount",
      );
      assertEquals(
        await electronAnswers(diskOnly, ["--client=electron"], foreign),
        // No mount declared: nothing serves workers/w.js, here as anywhere.
        { ...WORKER_ANSWERS, mount: "error" },
        "packaged, page and workers off the package's dist/ alone",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
      await dropTempDir(foreign);
    }
  },
});

Deno.test({
  name:
    "artifact: browser workers run in the packaged Electron app on Windows — from the .zip and from the one-click .exe's install (foreign cwd, no source tree)",
  ignore: !ELECTRON || Deno.build.os !== "windows", // the .zip and the one-click .exe are the Windows packages
  sanitizeOps: false, // aio-ok(sanitizers): a real Electron child owns sockets and timers; teardown kills it
  sanitizeResources: false, // aio-ok(sanitizers): same
  async fn() {
    const dir = await workerProject();
    const foreign = await tempDir("foreign-cwd-worker-win-");
    try {
      const r = await buildFlags(dir, "--compile", "--electron");
      assertEquals(r.code, 0, `electron build failed:\n${r.out}\n${r.err}`);
      const built = [...Deno.readDirSync(join(dir, "dist"))].map((e) => e.name);
      const zip = built.find((n) => /-win-[^.]+\.zip$/i.test(n));
      const oneClick = built.find((n) => /-win-[^.]+\.exe$/i.test(n));
      assert(zip && oneClick, `dist/ holds ${built.join(", ")}`);
      const fromZip = await unpackDesktop(
        join(dir, "dist", zip),
        join(foreign, "zip"),
      );
      // The one-click .exe, INSTALLED and not started (it would start the
      // app detached and exit): what it put there is what a double-click
      // runs. Its install goes under the throwaway profile.
      const box = join(foreign, "box");
      const profile = desktopEnv("windows", box);
      const sfx = join(foreign, oneClick);
      await Deno.copyFile(join(dir, "dist", oneClick), sfx);
      const installed = await new Deno.Command(sfx, {
        args: ["--aio-sfx-install"],
        cwd: foreign,
        env: childEnv(profile),
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        installed.code,
        0,
        new TextDecoder().decode(installed.stderr),
      );
      const apps = join(profile.LOCALAPPDATA!, "aio-sfx");
      const [app] = [...Deno.readDirSync(apps)];
      const [arch] = [...Deno.readDirSync(join(apps, app!.name))];
      const home = join(apps, app!.name, arch!.name);
      const exe = [...Deno.readDirSync(home)].find((e) =>
        e.isFile && e.name.endsWith(".exe")
      );
      assert(exe, `no program in ${home}`);
      // Only what each package carries can answer.
      await Deno.rename(join(dir, "src"), join(dir, "src.moved"));
      await Deno.rename(join(dir, "workers"), join(dir, "workers.moved"));
      for (
        const [what, program] of [
          ["the .zip", fromZip],
          ["the one-click .exe's install", join(home, exe.name)],
        ] as const
      ) {
        assertEquals(
          await electronAnswers(
            program,
            ["--client=electron"],
            foreign,
            profile,
          ),
          WORKER_ANSWERS,
          what,
        );
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
      await dropTempDir(foreign);
    }
  },
});

Deno.test({
  name:
    "artifact: browser workers run in the packaged Electron app on macOS — from the bundle in the .app.tar.gz (foreign cwd, no source tree)",
  ignore: !ELECTRON || Deno.build.os !== "darwin", // the .app bundle is the macOS package
  sanitizeOps: false, // aio-ok(sanitizers): a real Electron child owns sockets and timers; teardown kills it
  sanitizeResources: false, // aio-ok(sanitizers): same
  async fn() {
    const dir = await workerProject();
    const foreign = await tempDir("foreign-cwd-worker-mac-");
    try {
      const r = await buildFlags(dir, "--compile", "--electron");
      assertEquals(r.code, 0, `electron build failed:\n${r.out}\n${r.err}`);
      const built = [...Deno.readDirSync(join(dir, "dist"))].map((e) => e.name);
      // The bundle as it ships: the same file an installed copy updates from,
      // and what the .dmg holds.
      const tarball = built.find((n) => n.endsWith(".app.tar.gz"));
      assert(tarball, `dist/ holds ${built.join(", ")}`);
      const program = await unpackDesktop(
        join(dir, "dist", tarball),
        join(foreign, "app"),
      );
      // Only what the package carries can answer.
      await Deno.rename(join(dir, "src"), join(dir, "src.moved"));
      await Deno.rename(join(dir, "workers"), join(dir, "workers.moved"));
      assertEquals(
        await electronAnswers(
          program,
          ["--client=electron"],
          foreign,
          desktopEnv("darwin", join(foreign, "box")),
        ),
        WORKER_ANSWERS,
        "the .app bundle",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
      await dropTempDir(foreign);
    }
  },
});
