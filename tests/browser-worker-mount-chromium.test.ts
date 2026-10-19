// A browser `Worker`, run by a REAL Chromium against the dev server and
// against a `--prod` build of the same app.
//
// `new Worker(new URL("./w.ts", import.meta.url))` ran in dev (the dev
// server transpiled the `.ts` it was asked for) and did NOT load from a
// build, which serves no source and bundled nothing a Worker constructor
// names — the Worker's `error` event was all the page was told. With a bare
// import in the worker it failed in dev too. Now the build bundles each such
// worker beside `app.js` and the dev server bundles it on request, so the
// same line runs in both — module, classic (and the worker IT starts) and
// shared — under a strict Content-Security-Policy, with nothing warned.
// What worked before still does: a file the app built itself, in an `assets`
// mount, started by plain path — the mount declared in deno.json only, which
// the dev server did not read. And what was green before is green now: a
// worker that CANNOT be bundled does not fail the build (it never did — the
// worker simply did not run), and a prebuilt `.js` named by URL literal is
// the same request it was, never re-bundled.
//
// Runs when a chromium/chrome binary is on the box; skipped (visibly)
// otherwise.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { browserHomeEnv, dropBrowserProfile } from "../src/testing/chromium.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { isWorkerBundle } from "../src/server/app-files.ts";
import { stopChild } from "./stop-child.ts";
import { BROWSER, browserOsFlags, freePort, waitFor } from "./e2e-harness.ts";
import { WORKER_ANSWERS, writeWorkerApp } from "./worker-app-fixture.ts";

const ROOT = new URL("../", import.meta.url).href;
const ENTRY = `import "./cells.ts";
import { aio } from "aio";
await aio.run({ persist: false, security: { csp: "strict" } });`;

/** Run `deno <args>` in `dir`; resolves with everything it printed once
 *  `until` says so (the server is then stopped) or it exits by itself. */
async function run(
  dir: string,
  args: string[],
  until?: (out: string) => boolean,
): Promise<string> {
  const proc = new Deno.Command(Deno.execPath(), {
    args,
    cwd: dir,
    env: { AIO_APPS_DIR: join(dir, "home"), ...testDisplayEnv() },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let out = "";
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const c of s) out += dec.decode(c, { stream: true });
  };
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  let exited = false;
  const status = proc.status.then((s) => {
    exited = true;
    return s;
  });
  try {
    if (until) {
      await waitFor("", () => until(out) || exited ? true : null, 120_000)
        .catch(() => {
          throw new Error(`timeout: deno ${args.join(" ")} printed:\n${out}`);
        });
    } else {
      assertEquals((await status).code, 0, out);
    }
  } finally {
    if (!exited) await stopChild(proc, { quiet: true });
    await status;
    await drained;
  }
  return out;
}

/** Serve the app (dev, or the build with `--prod`), open it in Chromium, and
 *  answer what the server printed once both workers have reported. */
async function served(
  dir: string,
  prod: boolean,
  keys: string[] = Object.keys(WORKER_ANSWERS),
  /** Also wait for this: a dev warning lands after the graph check, which
   *  can come after every probe has answered (Windows, measured). */
  until: (out: string) => boolean = () => true,
): Promise<string> {
  const port = freePort();
  const profile = await tempDir("aio-worker-prof-");
  let browser: Deno.ChildProcess | undefined;
  try {
    return await run(dir, [
      "run",
      "-A",
      "--unstable-kv",
      "src/app.ts",
      "--client=server-only",
      `--port=${port}`,
      ...(prod ? ["--prod"] : []),
    ], (out) => {
      if (!browser && /\bstarted\b.*port=/.test(out)) {
        browser = new Deno.Command(BROWSER!, {
          args: [
            ...browserOsFlags,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--password-store=basic",
            "--use-mock-keychain",
            `--user-data-dir=${profile}`,
            `http://localhost:${port}/`,
          ],
          env: { ...browserHomeEnv(profile), ...testDisplayEnv() },
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
      }
      return keys.every((k) => out.includes(`PROBE ${k}=`)) && until(out);
    });
  } finally {
    if (browser) await stopChild(browser, { quiet: true });
    await dropBrowserProfile(profile);
  }
}

/** The worker app as a project in `dir`. */
async function project(dir: string): Promise<void> {
  await writeWorkerApp(dir);
  await Deno.writeTextFile(join(dir, "src/app.ts"), ENTRY);
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      title: "Worker Probe",
      appId: `worker-${crypto.randomUUID().slice(0, 8)}`,
      version: "0.0.1",
      nodeModulesDir: "auto",
      unstable: ["kv"],
      assets: { "/workers": "./workers" },
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "aio",
        lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      },
      imports: {
        "aio": `${ROOT}mod.ts`,
        "aio/air": `${ROOT}src/air.ts`,
        "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@^1",
      },
    }),
  );
}

Deno.test({
  name:
    "browser Worker (chromium): a worker named by URL literal runs in dev and in a build — module, classic, nested, shared, with a bare import — and so does one in a deno.json assets mount",
  ignore: BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): an external browser and a server child, both stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the children outlive the check
  async fn() {
    const dir = await tempDir("aio-worker-app-");
    try {
      await project(dir);
      const answered = (out: string, where: string) => {
        assertEquals(Object.keys(WORKER_ANSWERS).length, 4);
        for (const [k, v] of Object.entries(WORKER_ANSWERS)) {
          assertStringIncludes(out, `PROBE ${k}=${v}`, `${where}: ${k}`);
        }
        assert(
          !out.includes("started as a Worker"),
          `${where} warned:\n${out}`,
        );
      };

      answered(await served(dir, false), "dev");

      const build = await run(dir, [
        "run",
        "-A",
        fromFileUrl(new URL("src/build.ts", ROOT)),
      ]);
      assert(!build.includes("started as a Worker"), build);
      // One file per worker and format, beside the bundle that names them.
      const staged = [...Deno.readDirSync(join(dir, "dist"))]
        .map((e) => e.name).filter(isWorkerBundle).sort();
      assertEquals(staged.map((n) => n.slice(0, -11)), [
        "worker-classic-",
        "worker-shared-",
        "worker-w-",
      ]);
      const app = await Deno.readTextFile(join(dir, "dist/app.js"));
      for (const name of staged) {
        if (!name.startsWith("worker-w-")) assertStringIncludes(app, name);
      }

      answered(await served(dir, true), "--prod");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "browser Worker (chromium): one worker that cannot be bundled does not fail the build — the good ones run, it is as it was, the warning is printed once; a prebuilt .js by URL literal is the request it was",
  ignore: BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): an external browser and a server child, both stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the children outlive the check
  async fn() {
    const dir = await tempDir("aio-worker-bad-");
    try {
      await project(dir);
      // `bad`: its import names no file. `pre`: a classic script the app
      // wrote as JS — a global the script it imports reads, and an
      // `importScripts` relative to ITSELF. Both worked exactly one way
      // before workers were bundled, and must work that way now.
      await Deno.writeTextFile(
        join(dir, "src/bad.ts"),
        `import { nope } from "./not-there.ts";\npostMessage(nope);`,
      );
      await Deno.mkdir(join(dir, "src/pre"));
      await Deno.writeTextFile(
        join(dir, "src/pre/pre.js"),
        `var G = "g"; importScripts("./lib.js");\n` +
          `self.onmessage = () => self.postMessage(lib() + self.location.pathname);`,
      );
      await Deno.writeTextFile(
        join(dir, "src/pre/lib.js"),
        `function lib() { return "pre:" + G + ":"; }`,
      );
      const app = join(dir, "src/App.tsx");
      await Deno.writeTextFile(
        app,
        (await Deno.readTextFile(app)).replace(
          `run("mount",`,
          `run("bad", new Worker(new URL("./bad.ts", import.meta.url), { type: "module" }));\n` +
            `    run("pre", new Worker(new URL("./pre/pre.js", import.meta.url)));\n` +
            `    run("mount",`,
        ),
      );
      const keys = [...Object.keys(WORKER_ANSWERS), "bad", "pre"];
      const answered = (out: string, where: string) => {
        assertEquals(Object.keys(WORKER_ANSWERS).length, 4);
        for (const [k, v] of Object.entries(WORKER_ANSWERS)) {
          assertStringIncludes(out, `PROBE ${k}=${v}`, `${where}: ${k}`);
        }
        // As before: the worker's `error` event, and the page up.
        assertStringIncludes(out, "PROBE bad=error", where);
        // The same request, the same script: its own URL, its own globals.
        assertStringIncludes(out, "PROBE pre=pre:g:/pre/pre.js", where);
      };
      const SAID = "the worker src/bad.ts cannot be bundled";

      const dev = await served(dir, false, keys, (o) => o.includes(SAID));
      answered(dev, "dev");
      assertEquals(dev.split(SAID).length - 1, 1, `dev said it:\n${dev}`);

      // A worker bundle of an earlier build that this one does not write.
      await Deno.mkdir(join(dir, "dist"), { recursive: true });
      await Deno.writeTextFile(join(dir, "dist/worker-old-00000000.js"), "");
      const build = await run(dir, [
        "run",
        "-A",
        fromFileUrl(new URL("src/build.ts", ROOT)),
      ]);
      assertEquals(build.split(SAID).length - 1, 1, build);
      assertStringIncludes(build, "not-there.ts");
      assertStringIncludes(build, "does not run in the built app");
      const staged = [...Deno.readDirSync(join(dir, "dist"))]
        .map((e) => e.name).filter(isWorkerBundle).sort();
      assertEquals(staged.map((n) => n.slice(0, -11)), [
        "worker-classic-",
        "worker-shared-",
        "worker-w-",
      ]);
      const bundle = await Deno.readTextFile(join(dir, "dist/app.js"));
      assertStringIncludes(bundle, `new URL("./bad.ts",import.meta.url)`);
      assertStringIncludes(bundle, `new URL("./pre/pre.js",import.meta.url)`);

      answered(await served(dir, true, keys), "--prod");
    } finally {
      await dropTempDir(dir);
    }
  },
});
