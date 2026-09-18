// Android APKs, RUN — on an emulator, driven through the WebView's own DevTools.
//
// Every other Android test here reads the generated project or fakes `adb`.
// None of them had ever run an APK, and the first real run found three defects
// that had shipped in every beta: the standalone APK threw on EVERY dispatch
// (`import.meta.url` is undefined in its classic-script bundle), the client
// APK could never leave its connect page (the WebView refused the navigation),
// and a rotation reloaded the app. This file is the run, kept.
//
// Opt-in (`AIO_ANDROID_E2E=1`, `deno task test:android`): it needs the Android
// SDK and an AVD, boots the emulator headless when none is running (and stops
// only one it started), and takes a few minutes. On success it records
// `android (emulator)` in the physical proof matrix.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cdpConnect, cdpTargets } from "../src/am/am-cdp.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const GATED = Deno.env.get("AIO_ANDROID_E2E") === "1";
const REPO = new URL("../", import.meta.url).pathname;
const SDK = Deno.env.get("ANDROID_HOME") ?? Deno.env.get("ANDROID_SDK_ROOT") ??
  join(Deno.env.get("HOME") ?? "", "Android", "Sdk");
const ADB = join(SDK, "platform-tools", "adb");

async function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ ok: boolean; out: string }> {
  const r = await new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    ok: r.success,
    out: (dec.decode(r.stdout) + dec.decode(r.stderr)).replaceAll("\r", ""),
  };
}
const adb = (...args: string[]) => sh(ADB, args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns non-null, or fail naming `what`. */
async function until<T>(
  what: string,
  fn: () => Promise<T | null>,
  ms = 30_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

/** A running emulator — the attached one, or one booted here (returned so the
 *  caller stops only what it started). */
async function ensureEmulator(): Promise<{ serial: string; started: boolean }> {
  const attached = (await adb("devices")).out.match(
    /^(emulator-\d+)\s+device$/m,
  );
  if (attached) return { serial: attached[1]!, started: false };
  const emu = join(SDK, "emulator", "emulator");
  const avd = Deno.env.get("AIO_AVD") ??
    (await sh(emu, ["-list-avds"])).out.split("\n").map((l) => l.trim())
      .find((l) => /^[\w.-]+$/.test(l));
  assert(avd, `no AVD to boot — create one, or set AIO_AVD`);
  new Deno.Command(emu, {
    args: [
      "-avd",
      avd,
      "-no-window",
      "-no-audio",
      "-no-snapshot-save",
      "-no-boot-anim",
      "-gpu",
      "swiftshader_indirect",
    ],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn().unref();
  const serial = await until(
    "the emulator to attach",
    async () =>
      (await adb("devices")).out.match(/^(emulator-\d+)\s+device$/m)?.[1] ??
        null,
    120_000,
  );
  await until(
    "the emulator to finish booting",
    async () =>
      (await adb("shell", "getprop", "sys.boot_completed")).out.trim() === "1"
        ? true
        : null,
    240_000,
  );
  return { serial, started: true };
}

/** A key press reaches the app only when a system dialog (a loaded emulator's
 *  "System UI isn't responding") is not holding focus. */
async function clearSystemDialogs(): Promise<void> {
  await adb("shell", "input", "keyevent", "224"); // wake
  await adb(
    "shell",
    "am",
    "broadcast",
    "-a",
    "android.intent.action.CLOSE_SYSTEM_DIALOGS",
  );
}

async function launch(pkg: string, clear = false): Promise<void> {
  await adb("shell", "am", "force-stop", pkg);
  if (clear) await adb("shell", "pm", "clear", pkg);
  await clearSystemDialogs();
  const r = await adb(
    "shell",
    "monkey",
    "-p",
    pkg,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  );
  assert(r.ok, `launch ${pkg}: ${r.out}`);
}

/** Evaluate `expr` in the app's WebView page. A fresh local port per call,
 *  removed after: a navigation replaces the page target, and `fetch` keeps
 *  its connection alive — a reused port kept tunnelling to the PREVIOUS app,
 *  so the target list came from one app and the socket went to another. */
async function onPage(pkg: string, expr: string): Promise<unknown> {
  const pid = (await adb("shell", "pidof", pkg)).out.trim();
  if (!pid) throw new Error(`${pkg} is not running`);
  const port = freePort();
  await adb(
    "forward",
    `tcp:${port}`,
    `localabstract:webview_devtools_remote_${pid}`,
  );
  try {
    const page = (await cdpTargets(port, 3000)).find((t) => t.type === "page");
    if (!page) throw new Error("no page target yet");
    const cdp = await cdpConnect(page.webSocketDebuggerUrl, 5000);
    try {
      const r = await cdp.call("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      }) as {
        result?: { value?: unknown };
        exceptionDetails?: { text?: string };
      };
      if (r.exceptionDetails) {
        throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails)}`);
      }
      return r.result?.value;
    } finally {
      cdp.close();
    }
  } finally {
    await adb("forward", "--remove", `tcp:${port}`);
  }
}

const COUNT = "document.body.innerText.split('\\n')[1]";
const PLUS = "document.querySelectorAll('button')[2].click(), 1";

/** The counter example, importing THIS checkout, plus a route that reads the
 *  server's own state (so a tap is proven to reach the server, not the DOM). */
async function counterApp(dir: string): Promise<void> {
  const src = join(REPO, "examples", "counter");
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  for (const f of ["App.tsx", "cell.ts"]) {
    await Deno.copyFile(join(src, "src", f), join(dir, "src", f));
  }
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `import { counter } from "./cell.ts";
import { aio } from "aio";
await aio.run({
  ui: { theme: "auto" },
  routes: { "/count": () => new Response(String(counter.count)) },
});
`,
  );
  const cfg = JSON.parse(await Deno.readTextFile(join(src, "deno.json")));
  for (const [k, v] of Object.entries(cfg.imports as Record<string, string>)) {
    if (v.startsWith("../../")) cfg.imports[k] = join(REPO, v.slice(6));
  }
  cfg.title = "aio-android-e2e";
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(cfg, null, 2),
  );
}

async function build(dir: string, remote: boolean): Promise<string> {
  const r = await sh(
    Deno.execPath(),
    [
      "run",
      "-A",
      join(REPO, "src", "build.ts"),
      "--android",
      ...(remote ? ["--remote"] : []),
    ],
    { cwd: dir, env: { ANDROID_HOME: SDK } },
  );
  assert(r.ok, `build failed:\n${r.out.slice(-3000)}`);
  const apk = [...Deno.readDirSync(join(dir, "dist"))]
    .map((e) => e.name)
    .find((n) =>
      n.endsWith(remote ? "-client.apk" : ".apk") &&
      (remote || !n.endsWith("-client.apk"))
    );
  assert(apk, `no APK in dist/:\n${r.out.slice(-1500)}`);
  return join(dir, "dist", apk);
}

async function install(apk: string): Promise<string> {
  const r = await adb("install", "-r", apk);
  assert(r.ok && r.out.includes("Success"), `install: ${r.out}`);
  const aapt = [...Deno.readDirSync(join(SDK, "build-tools"))].map((e) =>
    e.name
  )
    .sort().reverse().map((v) => join(SDK, "build-tools", v, "aapt2"))
    .find((p) => {
      try {
        return Deno.statSync(p).isFile;
      } catch {
        return false;
      }
    });
  assert(aapt, "no aapt2 in build-tools");
  return (await sh(aapt, ["dump", "packagename", apk])).out.trim();
}

Deno.test({
  name:
    "android e2e: the standalone APK and the client APK, run on an emulator",
  ignore: !GATED,
  // aio-ok: the emulator is spawned detached and outlives the test on purpose
  sanitizeOps: false,
  // aio-ok: same — its unref'd child handle is the emulator, not a leak
  sanitizeResources: false,
  async fn(t) {
    const emu = await ensureEmulator();
    const dir = await tempDir("aio-android-e2e-");
    let server: Deno.ChildProcess | null = null;
    let standalone = "";
    try {
      await counterApp(dir);

      await t.step(
        "standalone: renders, a tap dispatches, state survives a kill",
        async () => {
          const pkg = standalone = await install(await build(dir, false));
          await adb("logcat", "-c");
          await launch(pkg, true);
          const ev = (e: string) => onPage(pkg, e);
          assertEquals(
            await until("the counter", async () => (await ev(COUNT)) ?? null),
            "0",
          );
          await ev(PLUS);
          await ev(PLUS);
          await until(
            "the count to reach 2",
            async () => (await ev(COUNT)) === "2" ? 2 : null,
          );
          const log = (await adb("logcat", "-d")).out;
          assert(!log.includes("REDUCE_ERROR"), "a tap threw in the reducer");
          // Saved, then give the WebView time to commit localStorage to disk: it
          // writes lazily, and a kill within ~1s of a change loses it (todo.md).
          await until(
            "the state to be stored",
            async () =>
              String(await ev("localStorage.getItem('aio:app')")).includes(
                  '"count":2',
                )
                ? true
                : null,
          );
          await sleep(3000);
          await launch(pkg);
          assertEquals(
            await until(
              "the restored counter",
              async () => (await ev(COUNT)) ?? null,
            ),
            "2",
            "the count did not survive the app being killed",
          );
        },
      );

      await t.step(
        "standalone: a rotation resizes the page, it does not reload it",
        async () => {
          const pkg = standalone;
          const ev = (e: string) => onPage(pkg, e);
          await ev("window.__aioE2eMarker = 7, 1");
          await adb("shell", "wm", "user-rotation", "lock", "1");
          try {
            await until(
              "landscape",
              async () =>
                (await ev("innerWidth > innerHeight")) === true ? true : null,
            );
            assertEquals(
              await ev("window.__aioE2eMarker"),
              7,
              "rotation reloaded the app",
            );
          } finally {
            await adb("shell", "wm", "user-rotation", "lock", "0");
          }
        },
      );

      await t.step(
        "client: connects by itself, a tap reaches the server, Back and a dead server reach the form",
        async () => {
          const port = freePort();
          const cfgPath = join(dir, "deno.json");
          const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
          cfg.build = { ...cfg.build, server: `http://10.0.2.2:${port}` };
          await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
          const pkg = await install(await build(dir, true));
          const ev = (e: string) => onPage(pkg, e);

          server = new Deno.Command(Deno.execPath(), {
            args: [
              "run",
              "-A",
              "src/app.ts",
              `--port=${port}`,
              "--client=server-only",
            ],
            cwd: dir,
            env: { AIO_APPS_DIR: join(dir, ".home") },
            stdin: "null",
            stdout: "null",
            stderr: "null",
          }).spawn();
          const count = async () => {
            const r = await fetch(`http://127.0.0.1:${port}/count`);
            return r.ok ? await r.text() : (await r.body?.cancel(), null);
          };
          assertEquals(await until("the server", count, 60_000), "0");

          await launch(pkg, true);
          await until(
            "the client to open its server",
            async () =>
              (await ev("location.host")) === `10.0.2.2:${port}` ? true : null,
          );
          await until(
            "the server page to render",
            async () => (await ev(COUNT)) === "0" ? true : null,
          );
          await ev(PLUS);
          await until(
            "the tap to reach the SERVER",
            async () => (await count()) === "1" ? true : null,
          );

          // Back from the server's first page: the connect form, prefilled.
          await clearSystemDialogs();
          await adb("shell", "input", "keyevent", "4");
          assertEquals(
            await until(
              "the connect form",
              async () =>
                (await ev("location.hash")) === "#change"
                  ? await ev("document.getElementById('addr').value")
                  : null,
            ),
            `http://10.0.2.2:${port}`,
          );

          // The server gone: the form, SAYING so — not Chromium's error page.
          server.kill("SIGTERM");
          await server.status;
          server = null;
          await launch(pkg);
          const err = await until(
            "the unreachable message",
            async () =>
              (await ev("location.hash")) === "#unreachable"
                ? String(await ev("document.getElementById('err').textContent"))
                : null,
          );
          assertStringIncludes(err, "Could not reach");
        },
      );

      const api = (await adb("shell", "getprop", "ro.build.version.sdk")).out
        .trim();
      const { recordProof } = await import("../scripts/proof.ts");
      await recordProof(
        "android",
        "emulator",
        `API ${api}: standalone (dispatch, persistence, rotation) + client (connect, server dispatch, Back, unreachable)`,
      );
    } finally {
      if (server) {
        (server as Deno.ChildProcess).kill("SIGTERM");
        await (server as Deno.ChildProcess).status;
      }
      if (emu.started) await adb("-s", emu.serial, "emu", "kill");
      await dropTempDir(dir);
    }
  },
});
