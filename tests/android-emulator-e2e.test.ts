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
// only one it started), and takes several minutes. On success it records
// `android (emulator)` in the physical proof matrix.
//
// A PHONE instead: plug it in with USB debugging on and name it —
// `AIO_ANDROID_SERIAL=<serial from adb devices> deno task test:android`. The
// same steps run on it (its server is reached through `adb reverse`; the
// airplane-mode step is the emulator's, since USB survives airplane mode) and
// the row recorded is `android (device)`.
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { cdpConnect, cdpTargets } from "../src/am/am-cdp.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";
import { WORKER_ANSWERS, writeWorkerApp } from "./worker-app-fixture.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const GATED = Deno.env.get("AIO_ANDROID_E2E") === "1";
const REPO = fromFileUrl(new URL("../", import.meta.url));
const SDK = Deno.env.get("ANDROID_HOME") ?? Deno.env.get("ANDROID_SDK_ROOT") ??
  join(Deno.env.get("HOME") ?? "", "Android", "Sdk");
const ADB = join(SDK, "platform-tools", "adb");
/** `AIO_ANDROID_SERIAL` — run on this device (a phone) instead of an emulator. */
const WANT_SERIAL = Deno.env.get("AIO_ANDROID_SERIAL");
/** The device every `adb` call below talks to — set once it is known. */
let SERIAL = "";

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
const adb = (...args: string[]) =>
  sh(ADB, SERIAL ? ["-s", SERIAL, ...args] : args);
const isEmulator = () => SERIAL.startsWith("emulator-");
/** The address the device reaches this machine's loopback at: the emulator's
 *  own alias, or — a phone — its own loopback through `adb reverse`. */
const hostAddr = () => isEmulator() ? "10.0.2.2" : "127.0.0.1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns non-null, or fail naming `what`. */
async function until<T>(
  what: string,
  fn: () => Promise<T | null>,
  ms = 30_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  // Told apart in the failure: "answered, not yet" (the app is up, in the
  // wrong state) and "threw" (the app or its devtools socket is not there).
  let notYet = 0, threw = 0;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null) return v;
      notYet++;
    } catch (e) {
      last = e;
      threw++;
    }
    await sleep(500);
  }
  throw new Error(
    `timed out waiting for ${what} (${notYet} polls answered "not yet", ` +
      `${threw} threw)${last ? `: ${last}` : ""}`,
  );
}

/** A running emulator — the attached one, or one booted here (returned so the
 *  caller stops only what it started). */
async function ensureEmulator(): Promise<{ serial: string; started: boolean }> {
  if (WANT_SERIAL) {
    assert(
      (await adb("devices")).out.split("\n").some((l) =>
        l.split(/\s+/)[0] === WANT_SERIAL && l.trim().endsWith("device")
      ),
      `AIO_ANDROID_SERIAL=${WANT_SERIAL} is not an attached, authorised device ` +
        `(adb devices)`,
    );
    return { serial: WANT_SERIAL, started: false };
  }
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
  // Ten minutes: on a machine that is also running a suite the boot took
  // 4 min 30 s, twice (load 13–16, 2026-10-13) — past the four minutes this
  // gave it, and the emulator this run had started was left running, since
  // nobody had been told it was ours. It is stopped here when the wait fails.
  try {
    await until(
      "the emulator to finish booting",
      async () =>
        (await adb("shell", "getprop", "sys.boot_completed")).out.trim() ===
            "1"
          ? true
          : null,
      600_000,
    );
  } catch (e) {
    await adb("emu", "kill");
    throw e;
  }
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

/** Is `pkg` the activity in front right now? */
async function resumed(pkg: string): Promise<boolean> {
  const out = (await adb("shell", "dumpsys", "activity", "activities")).out;
  return out.split("\n").some((l) =>
    /topResumedActivity|mResumedActivity/.test(l) && l.includes(`${pkg}/`)
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

/** Bring `pkg` to the front WITHOUT stopping it — a tap on its launcher icon. */
async function reopen(pkg: string): Promise<void> {
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
  assert(r.ok, `reopen ${pkg}: ${r.out}`);
}

/** What is on screen, read by the OS's own accessibility dump — the way into
 *  a RELEASE build, whose WebView has no DevTools. Each node: its text and
 *  the centre of its bounds. */
async function screen(): Promise<{ text: string; x: number; y: number }[]> {
  const xml = (await adb("exec-out", "uiautomator", "dump", "/dev/tty")).out;
  return [...xml.matchAll(
    /text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g,
  )].map((m) => ({
    text: m[1]!,
    x: (Number(m[2]) + Number(m[4])) >> 1,
    y: (Number(m[3]) + Number(m[5])) >> 1,
  }));
}

/** A server for the client APK: the app's own entry, headless, its output
 *  kept — a server that dies is then a failure that says why. */
function startServer(
  dir: string,
  args: string[],
  /** The server's data root, under `dir` — another one is another identity
   *  (its own key, its own certificate root). */
  home = ".home",
): { proc: Deno.ChildProcess; log: () => string; stop: () => Promise<void> } {
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/app.ts", "--client=server-only", ...args],
    cwd: dir,
    env: { AIO_APPS_DIR: join(dir, home) },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let text = "";
  const dec = new TextDecoder();
  const pump = (r: ReadableStream<Uint8Array>) =>
    r.pipeTo(
      new WritableStream({
        write(c) {
          text += dec.decode(c).replaceAll("\r", "");
        },
      }),
    );
  const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  let exited = false;
  const status = proc.status.then(() => exited = true);
  return {
    proc,
    log: () => text,
    stop: async () => {
      if (!exited) proc.kill("SIGTERM");
      await status;
      await pumps;
    },
  };
}

/** A DevTools session on the app's WebView page. A fresh local port per call,
 *  removed after: a navigation replaces the page target, and `fetch` keeps
 *  its connection alive — a reused port kept tunnelling to the PREVIOUS app,
 *  so the target list came from one app and the socket went to another. */
async function withPage<T>(
  pkg: string,
  use: (cdp: Awaited<ReturnType<typeof cdpConnect>>) => Promise<T>,
): Promise<T> {
  const pid = (await adb("shell", "pidof", pkg)).out.trim();
  if (!pid) throw new Error(`${pkg} is not running`);
  const port = freePort();
  await adb(
    "forward",
    `tcp:${port}`,
    `localabstract:webview_devtools_remote_${pid}`,
  );
  try {
    // Polled, listing AND connecting: neither evaluates anything, so both are
    // safe to ask again — and on a loaded machine one listing took over its
    // 3 s, one connect over its 5 s. A call made outside `until` (a tap) then
    // failed its step with a bare "TimeoutError", naming nothing. Listed
    // afresh each time: a navigation replaces the page target.
    const cdp = await until(
      `a DevTools connection to ${pkg}'s page`,
      async () => {
        const page = (await cdpTargets(port, 3000)).find((t) =>
          t.type === "page"
        );
        return page ? await cdpConnect(page.webSocketDebuggerUrl, 5000) : null;
      },
      20_000,
    );
    try {
      return await use(cdp);
    } finally {
      cdp.close();
    }
  } finally {
    await adb("forward", "--remove", `tcp:${port}`);
  }
}

/** Evaluate `expr` in the app's WebView page — `gesture`: as a user's own tap
 *  (what a file input's `click()` needs before it opens a picker). */
function onPage(pkg: string, expr: string, gesture = false): Promise<unknown> {
  return withPage(pkg, async (cdp) => {
    const r = await cdp.call("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: gesture,
    }) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    };
    if (r.exceptionDetails) {
      throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails)}`);
    }
    return r.result?.value;
  });
}

/** Does `pkg`'s page see `prefers-color-scheme: dark` with the system's night
 *  mode set to `night`? The system setting is put back. */
async function seesDark(pkg: string, night: boolean): Promise<boolean> {
  const mode = (on: boolean) =>
    adb("shell", "cmd", "uimode", "night", on ? "yes" : "no");
  const was = (await adb("shell", "cmd", "uimode", "night")).out.includes(
    "yes",
  );
  try {
    await mode(night);
    await launch(pkg);
    return await until("the page's colour scheme", async () => {
      const v = await onPage(
        pkg,
        `matchMedia("(prefers-color-scheme: dark)").matches`,
      );
      return typeof v === "boolean" ? v : null;
    });
  } finally {
    await mode(was);
  }
}

/** Set deno.json `android.colorScheme` of the app in `dir`. */
async function colorScheme(dir: string, scheme: string): Promise<void> {
  const cfgPath = join(dir, "deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
  cfg.android = { ...cfg.android, colorScheme: scheme };
  await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
}

const COUNT = "document.body.innerText.split('\\n')[1]";
const PLUS = "document.querySelectorAll('button')[2].click(), 1";
/** The app's saved state, read the way only its own page can: with the
 *  per-launch key the APK hands its origin. */
const STORED = "AioNativeStore.read(__aioNativeStoreKey, 'aio:app')";
/** A third-party page the app embeds: it tries every way into the native
 *  store — keyless / guessed-key calls, the 1.0.12 method names — and reports
 *  what it saw to `/saw`. */
const FOREIGN_FRAME_PROBE = `
const S = typeof AioNativeStore === "object" ? AioNativeStore : {};
const t = (f) => { try { f(); return "answered"; } catch { return "threw"; } };
fetch("/saw?" + encodeURIComponent(JSON.stringify({
  fetch: typeof AioNativeFetch,
  store: typeof AioNativeStore,
  key: typeof window.__aioNativeStoreKey,
  read: t(() => S.read("", "aio:app")),
  write: t(() => S.write("0".repeat(64), "aio:app", '{"count":99}')),
  exists: t(() => S.exists("", "aio:app")),
  where: t(() => S.where("")),
  get: t(() => S.get("aio:app")),
  set: t(() => S.set("aio:app", '{"count":99}')),
})));`;

/** The counter example, importing THIS checkout, plus a route that reads the
 *  server's own state (so a tap is proven to reach the server, not the DOM).
 *  `run` is spliced into its `aio.run({...})`; `title` names the app (and so
 *  its applicationId). */
async function counterApp(
  dir: string,
  opts: { title?: string; run?: string } = {},
): Promise<void> {
  const src = join(REPO, "examples", "counter");
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  for (const f of ["App.tsx", "cell.ts"]) {
    await Deno.copyFile(join(src, "src", f), join(dir, "src", f));
  }
  // Android Back as navigation: the count stands for "screens deep". Back
  // steps down while it is above 0 (handled), and does Android's default at
  // 0. Registered at module scope, so it is live before any tap.
  await Deno.writeTextFile(
    join(dir, "src", "App.tsx"),
    (await Deno.readTextFile(join(dir, "src", "App.tsx"))) +
      `\nimport { onBackButton } from "aio/air";
onBackButton(() => {
  if (counter.count <= 0) return false;
  counter.decrement();
  return true;
});
`,
  );
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `import { counter } from "./cell.ts";
import { aio } from "aio";
await aio.run({
  ui: { theme: "auto", lang: "ar", dir: "rtl" },
  routes: {
    "/count": () => new Response(String(counter.count)),
    "/export": () =>
      new Response("aio-e2e export", {
        headers: {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="aio-e2e-export.txt"',
        },
      }),
  },
  onStart() {},
  ${opts.run ?? ""}
});
`,
  );
  const cfg = JSON.parse(await Deno.readTextFile(join(src, "deno.json")));
  for (const [k, v] of Object.entries(cfg.imports as Record<string, string>)) {
    if (v.startsWith("../../")) cfg.imports[k] = join(REPO, v.slice(6));
  }
  cfg.title = opts.title ?? "aio-android-e2e";
  // What `am create` writes; with no key the APK keeps 1.0.19's dark theme.
  cfg.android = { ...cfg.android, colorScheme: "system" };
  // Content a standalone APK has no server to serve: packaged by the build.
  cfg.assets = { "/text": "./text" };
  await Deno.mkdir(join(dir, "text", "en"), { recursive: true });
  await Deno.writeTextFile(join(dir, "text", "en", "a.md"), "# packaged");
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(cfg, null, 2),
  );
}

/** The standalone build's `android/` overlay for the native-fetch step: a
 *  network security config allowing cleartext to 127.0.0.1 ONLY (the test
 *  server behind `adb reverse`), so the WebView's fetch and the native one
 *  both reach it and differ only in who sends the request. The page gets
 *  `nativeFetch` as a global to call over DevTools. Removed before the
 *  client build, whose own cleartext rule a config would override. */
async function nativeFetchOverlay(dir: string): Promise<void> {
  const main = join(dir, "android", "app", "src", "main");
  await Deno.mkdir(join(main, "res", "xml"), { recursive: true });
  await Deno.writeTextFile(
    join(main, "res", "xml", "aio_e2e_nsc.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`,
  );
  const manifest = ANDROID_TEMPLATE["app/src/main/AndroidManifest.xml"]!;
  assertStringIncludes(manifest, 'android:allowBackup="false"');
  await Deno.writeTextFile(
    join(main, "AndroidManifest.xml"),
    manifest.replace(
      'android:allowBackup="false"',
      'android:allowBackup="false"\n    android:networkSecurityConfig="@xml/aio_e2e_nsc"',
    ),
  );
  await Deno.writeTextFile(
    join(dir, "src", "App.tsx"),
    `import { nativeFetch } from "aio/air";
(globalThis as Record<string, unknown>).__nativeFetch = nativeFetch;
`,
    { append: true },
  );
}

/** What the last `build()` printed. */
let buildOut = "";

async function build(
  dir: string,
  remote: boolean,
  extra: { args?: string[]; env?: Record<string, string> } = {},
): Promise<string> {
  const r = await sh(
    Deno.execPath(),
    [
      "run",
      "-A",
      join(REPO, "src", "build.ts"),
      "--android",
      ...(remote ? ["--remote"] : []),
      ...(extra.args ?? []),
    ],
    { cwd: dir, env: { ANDROID_HOME: SDK, ...extra.env } },
  );
  assert(r.ok, `build failed:\n${r.out.slice(-3000)}`);
  buildOut = r.out;
  const apk = [...Deno.readDirSync(join(dir, "dist"))]
    .map((e) => e.name)
    .find((n) =>
      n.endsWith(remote ? "-client.apk" : ".apk") &&
      (remote || !n.endsWith("-client.apk"))
    );
  assert(apk, `no APK in dist/:\n${r.out.slice(-1500)}`);
  return join(dir, "dist", apk);
}

/** The newest build-tools' `tool` (aapt2, apksigner). */
function buildTool(tool: string): string {
  const found = [...Deno.readDirSync(join(SDK, "build-tools"))].map((e) =>
    e.name
  )
    .sort().reverse().map((v) => join(SDK, "build-tools", v, tool))
    .find((p) => {
      try {
        return Deno.statSync(p).isFile;
      } catch {
        return false;
      }
    });
  assert(found, `no ${tool} in build-tools`);
  return found;
}

async function install(apk: string): Promise<string> {
  const r = await adb("install", "-r", apk);
  assert(r.ok && r.out.includes("Success"), `install: ${r.out}`);
  return (await sh(buildTool("aapt2"), ["dump", "packagename", apk])).out
    .trim();
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
    SERIAL = emu.serial;
    let server: ReturnType<typeof startServer> | null = null;
    let standalone = "";
    let standaloneApk = "";
    /** The WebView's user agent, when it is too old to run the bundle. */
    let oldEngine = "";
    // A failed step does not throw: counted, so a red run records no proof.
    let red = 0;
    /** What a run put on a PHONE and must take back: `adb` argument lists,
     *  run in the `finally`. An emulator this run started is thrown away
     *  whole; a phone is somebody's, and the client APK and its `adb reverse`
     *  rule stayed on it (a Saga, Android 14, 2026-10-13). */
    const takeBack: string[][] = [];
    const step = async (name: string, fn: () => Promise<void>) => {
      if (!await t.step(name, fn)) red++;
    };
    try {
      await counterApp(dir);
      await nativeFetchOverlay(dir);

      await step(
        "standalone: renders, a tap dispatches, state survives a kill",
        async () => {
          standaloneApk = await build(dir, false);
          // app.ts never runs on the phone: the build read its options. What
          // can travel is baked in; what cannot is named — and a debug build
          // says it is one.
          assertStringIncludes(
            buildOut,
            "options baked in: ui.theme, ui.lang, ui.dir",
          );
          assertStringIncludes(buildOut, "onStart");
          assertStringIncludes(buildOut, "routes");
          assertStringIncludes(buildOut, "not store-ready");
          const pkg = standalone = await install(standaloneApk);
          await adb("logcat", "-c");
          await launch(pkg, true);
          const ev = (e: string) => onPage(pkg, e);
          // A WebView too old for the bundle (an API 24 system image ships
          // Chrome 69; a real phone of that age updates it from the Play
          // Store): the app installs, starts and SAYS so — it showed a blank
          // page. Nothing else can run there, so that is the whole run.
          const engine = await until(
            "the page's engine",
            async () => (await ev("typeof structuredClone")) ?? null,
          );
          if (engine !== "function") {
            assertStringIncludes(
              String(
                await until(
                  "the too-old notice",
                  async () =>
                    (await ev("document.getElementById('root').textContent")) ||
                    null,
                ),
              ),
              "Update Android System WebView",
            );
            oldEngine = String(await ev("navigator.userAgent"));
            return;
          }
          assertEquals(
            await until("the counter", async () => (await ev(COUNT)) ?? null),
            "0",
          );
          // `ui: { theme: "auto", lang: "ar", dir: "rtl" }` from app.ts, in
          // the packaged shell — none of it reached an APK before the bake.
          assertEquals(
            await ev(
              `[document.documentElement.lang, document.documentElement.dir, ` +
                `!!document.querySelector("style[data-aio-theme-deferred]")].join()`,
            ),
            "ar,rtl,false",
          );
          await ev(PLUS);
          await ev(PLUS);
          await until(
            "the count to reach 2",
            async () => (await ev(COUNT)) === "2" ? 2 : null,
          );
          const log = (await adb("logcat", "-d")).out;
          assert(!log.includes("REDUCE_ERROR"), "a tap threw in the reducer");
          // The state is in the NATIVE store — a standalone APK persists
          // through `AioNativeStore` (fsync + atomic rename), not through the
          // WebView's localStorage, which commits to disk lazily. Its every
          // method takes the per-launch key only the app's own page is handed.
          assertStringIncludes(
            String(await ev(STORED)),
            '"count":2',
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

      if (oldEngine) {
        console.log(
          `[aio] android e2e: this device's WebView is too old for the ` +
            `bundle (${oldEngine}) — the APK installed, started and said so; ` +
            `the remaining steps need a current WebView and were not run, ` +
            `and no proof row is recorded.`,
        );
        return;
      }

      await step(
        "standalone: a change survives a kill in the same instant it was made",
        async () => {
          // THE regression this step exists for. A standalone APK used to
          // persist through the WebView's localStorage, which commits to disk
          // on its own lazy schedule: measured here, a SIGKILL 122 ms after a
          // committed change restored the state from BEFORE it — the change
          // gone, nothing said. (At ~900 ms it survived, which is why the step
          // above, which waits 3 s, was green throughout.) A swipe-away, an
          // OOM kill and a crash are all exactly that kill.
          //
          // No sleep here on purpose: the kill goes in as fast as adb can
          // deliver it after the count is confirmed on screen. The native
          // store (fsync + atomic rename before its method returns) is what
          // makes that survivable — see AioNativeStore in MainActivity.kt.
          const pkg = standalone;
          const ev = (e: string) => onPage(pkg, e);
          await launch(pkg, true);
          await until(
            "a fresh counter",
            async () => (await ev(COUNT)) === "0" ? true : null,
          );
          await ev(PLUS);
          await ev(PLUS);
          await until(
            "the count to reach 2",
            async () => (await ev(COUNT)) === "2" ? 2 : null,
          );
          const t0 = Date.now();
          await adb("shell", "am", "force-stop", pkg); // SIGKILL, no flush
          const killedAfter = Date.now() - t0;
          await launch(pkg);
          assertEquals(
            await until(
              "the restored counter",
              async () => (await ev(COUNT)) ?? null,
            ),
            "2",
            `the change was lost to a kill ${killedAfter}ms after it was made ` +
              `— the app is not writing through the durable native store`,
          );
          assert(
            killedAfter < 1000,
            `this step only proves anything if the kill is FAST; it took ` +
              `${killedAfter}ms, which the lazy localStorage path survived too`,
          );
        },
      );

      await step(
        "standalone: the page is not drawn under the system bars",
        async () => {
          // targetSdk 35 makes every activity edge-to-edge by default, and
          // measured on API 35 before the frame was inset, the page drew
          // UNDER the status bar: an app's own title and the clock on the
          // same pixels. The viewport must therefore be shorter than the
          // screen by at least a status bar (24dp is Android's minimum;
          // measured here: 915 - 838 = 77 CSS px of status + navigation bar).
          const ev = (e: string) => onPage(standalone, e);
          const gap = Number(
            await ev("screen.height - innerHeight"),
          );
          assert(
            gap >= 24,
            `the page fills the whole screen (${gap} CSS px of system bars) ` +
              `— it is drawing under the status/navigation bar`,
          );
        },
      );

      await step(
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

      await step(
        "standalone: nativeFetch reaches an API that refuses any Origin; the page's fetch cannot",
        async () => {
          // Field report (a crypto wallet app): a public JSON-RPC answers 403
          // to any request carrying an Origin, and a standalone APK's every
          // fetch runs in its WebView. This server does the same (with a CORS
          // header, so the page can SEE its 403 rather than a bare TypeError).
          const origins: (string | null)[] = [];
          let frameSaw = "";
          const api = Deno.serve(
            { hostname: "127.0.0.1", port: freePort(), onListen: () => {} },
            async (req) => {
              const path = new URL(req.url).pathname;
              // A third-party page the app embeds: it reports what it sees.
              if (path === "/frame") {
                return new Response(
                  `<script>${FOREIGN_FRAME_PROBE}</script>`,
                  { headers: { "content-type": "text/html" } },
                );
              }
              if (path === "/saw") {
                frameSaw = decodeURIComponent(
                  new URL(req.url).search.slice(1),
                );
                return new Response("");
              }
              origins.push(req.headers.get("origin"));
              const cors = { "access-control-allow-origin": "*" };
              if (req.headers.has("origin")) {
                return new Response("origin refused", {
                  status: 403,
                  headers: cors,
                });
              }
              return Response.json({ ok: true, got: await req.text() }, {
                headers: { ...cors, "set-cookie": "sid=1" },
              });
            },
          );
          const port = api.addr.port;
          const url = JSON.stringify(`http://127.0.0.1:${port}/rpc`);
          await adb("reverse", `tcp:${port}`, `tcp:${port}`);
          try {
            const ev = (e: string) => onPage(standalone, e);
            await launch(standalone);
            await until(
              "the page",
              async () => (await ev(COUNT)) != null ? true : null,
            );
            assertEquals(
              await ev(
                `fetch(${url}).then((r) => "status " + r.status, (e) => "threw " + e)`,
              ),
              "status 403",
              "the page's own fetch",
            );
            const native = await ev(
              `__nativeFetch(${url}, { method: "POST", ` +
                `headers: { "content-type": "application/json" }, ` +
                `body: '{"jsonrpc":"2.0","method":"ping"}' })` +
                `.then(async (r) => ({ status: r.status, ` +
                `cookie: r.headers.get("set-cookie"), json: await r.json() }), ` +
                `(e) => ({ error: String(e) }))`,
            );
            assertEquals(native, {
              status: 200,
              cookie: null,
              json: { ok: true, got: '{"jsonrpc":"2.0","method":"ping"}' },
            });
            assertEquals(origins.length, 2, JSON.stringify(origins));
            assertStringIncludes(String(origins[0]), "appassets");
            assertEquals(origins[1], null, "nativeFetch sent an Origin");
            // A file: URL never reaches the app's own files.
            assertStringIncludes(
              String(
                await ev(
                  `__nativeFetch("file:///data/local/tmp/x").then(() => "read", (e) => String(e))`,
                ),
              ),
              "only http and https",
            );
            // A frame from another origin can use neither bridge. The fetch
            // listener's origin rule keeps it out entirely; the store's
            // addJavascriptInterface reaches every frame, so the frame SEES
            // the store (which also proves this probe can see an injected
            // object) — and every call it makes is refused: it never gets
            // the per-launch key, and the 1.0.12 methods are gone.
            const before = String(await ev(STORED));
            assertStringIncludes(before, '"count":');
            await adb("logcat", "-c");
            await ev(
              `document.body.appendChild(Object.assign(document.createElement("iframe"), ` +
                `{ src: "http://127.0.0.1:${port}/frame" })), 1`,
            );
            const saw = JSON.parse(
              await until(
                "the frame's report",
                () => Promise.resolve(frameSaw || null),
              ),
            );
            assertEquals(saw, {
              fetch: "undefined",
              store: "object",
              key: "undefined",
              read: "threw",
              write: "threw",
              exists: "threw",
              where: "threw",
              get: "threw",
              set: "threw",
            }, "a foreign iframe reached the native store or fetch");
            assertEquals(String(await ev(STORED)), before, "the frame wrote");
            assertStringIncludes(
              (await adb("logcat", "-d")).out,
              "native store call REFUSED",
              "the APK did not refuse the frame's keyless calls",
            );
            // …and the refusals cost the app nothing: its state still
            // survives a kill (SIGKILL, no flush) and comes back.
            await adb("shell", "am", "force-stop", standalone);
            await launch(standalone);
            assertEquals(
              String(
                await until(
                  "the restored store",
                  async () =>
                    (await ev(COUNT)) != null ? await ev(STORED) : null,
                ),
              ),
              before,
              "the state did not survive a kill after the frame",
            );
          } finally {
            await adb("reverse", "--remove", `tcp:${port}`);
            await api.shutdown();
            // The client APK keeps its own cleartext rule: no overlay for it.
            await Deno.remove(join(dir, "android"), { recursive: true });
          }
        },
      );

      await step(
        "standalone: deno.json assets are packaged; a relative fetch reads them",
        async () => {
          assertEquals(
            await onPage(
              standalone,
              "fetch('text/en/a.md').then((r) => r.text())",
            ),
            "# packaged",
          );
        },
      );

      await step(
        "standalone: Back runs onBackButton from a COLD start (no tap), then exits",
        async () => {
          // A WebView ignores history entries pushed before the first user
          // gesture, so `pushState` navigation lost the first Back after a
          // cold start. The shell asks the page through evaluateJavascript,
          // which needs no gesture: count 2 → 1 → 0 → Android's default.
          const pkg = standalone;
          const ev = (e: string) => onPage(pkg, e);
          await launch(pkg, true);
          await until(
            "a fresh counter",
            async () => (await ev(COUNT)) === "0" ? true : null,
          );
          await ev(PLUS);
          await ev(PLUS);
          await until(
            "the count to reach 2",
            async () => (await ev(COUNT)) === "2" ? 2 : null,
          );
          await launch(pkg); // force-stop + launch: a cold start, no gesture
          await until(
            "the restored count",
            async () => (await ev(COUNT)) === "2" ? true : null,
          );
          for (const want of ["1", "0"]) {
            await clearSystemDialogs();
            await adb("shell", "input", "keyevent", "4");
            await until(
              `Back to step the count to ${want}`,
              async () => (await ev(COUNT)) === want ? true : null,
            );
          }
          assert(await resumed(pkg), "the app left before its handler said so");
          await clearSystemDialogs();
          await adb("shell", "input", "keyevent", "4");
          await until(
            "the app to leave the foreground on Back at 0",
            async () => (await resumed(pkg)) ? null : true,
          );
        },
      );

      await step(
        "standalone: light and dark follow the system, live — no reload",
        async () => {
          // Measured before the fix (API 35): the activity's theme was the
          // DARK AppCompat one, so the page's `prefers-color-scheme` said
          // dark on a phone set to light — and switching the system setting
          // recreated the activity, which reloaded the app.
          const pkg = standalone;
          const ev = (e: string) => onPage(pkg, e);
          const night = (on: boolean) =>
            adb("shell", "cmd", "uimode", "night", on ? "yes" : "no");
          const was = (await adb("shell", "cmd", "uimode", "night")).out
            .includes("yes");
          const look = (dark: boolean) =>
            until(dark ? "the dark look" : "the light look", async () => {
              const v = JSON.parse(String(
                await ev(
                  `JSON.stringify([matchMedia("(prefers-color-scheme: dark)").matches, ` +
                    `getComputedStyle(document.body).backgroundColor, window.__aioE2eMarker ?? null])`,
                ),
              )) as [boolean, string, number | null];
              return v[0] === dark ? v : null;
            });
          try {
            await night(false);
            await launch(pkg);
            await until(
              "the page",
              async () => (await ev(COUNT)) != null ? true : null,
            );
            await ev("window.__aioE2eMarker = 9, 1");
            const light = await look(false);
            await night(true);
            const dark = await look(true);
            assertEquals(
              dark[2],
              9,
              "the system theme change reloaded the app",
            );
            // `ui.theme: "auto"` (baked from app.ts) paints the page, in the
            // scheme the system asks for.
            assertNotEquals(light[1], "rgba(0, 0, 0, 0)", "nothing painted");
            assertNotEquals(light[1], dark[1], "light and dark look the same");
          } finally {
            await night(was);
          }
        },
      );

      await step(
        "standalone: Home and back keeps the page; a background kill restores the state",
        async () => {
          // (No deep link here: the template declares the launcher intent
          // only — an app that wants one overlays its AndroidManifest.xml.)
          const pkg = standalone;
          const ev = (e: string) => onPage(pkg, e);
          await launch(pkg, true);
          await until(
            "a fresh counter",
            async () => (await ev(COUNT)) === "0" ? true : null,
          );
          await ev(PLUS);
          await until(
            "the count to reach 1",
            async () => (await ev(COUNT)) === "1" ? true : null,
          );
          await ev("window.__aioE2eMarker = 5, 1");
          const home = async () => {
            await adb("shell", "input", "keyevent", "3");
            await until(
              "the app to leave the foreground",
              async () => (await resumed(pkg)) ? null : true,
            );
          };
          await home();
          await reopen(pkg);
          await until(
            "the app back in front",
            async () => (await resumed(pkg)) ? true : null,
          );
          assertEquals(
            await ev("window.__aioE2eMarker"),
            5,
            "coming back from Home reloaded the app",
          );
          assertEquals(await ev(COUNT), "1");
          // The OS reclaiming a backgrounded app: the process dies unasked.
          await home();
          await until("the background process to be killed", async () => {
            await adb("shell", "am", "kill", pkg);
            return (await adb("shell", "pidof", pkg)).out.trim() ? null : true;
          });
          await reopen(pkg);
          assertEquals(
            await until(
              "the restored counter",
              async () => (await ev(COUNT)) ?? null,
            ),
            "1",
            "the state did not survive the OS killing the backgrounded app",
          );
        },
      );

      await step(
        "standalone: the WebView's renderer process is lost — the app stays, and the page comes back with its state",
        async () => {
          // The page runs in a process of its own, and Android takes it back
          // when memory is short. Measured on a phone (Android 14, WebView
          // 141) before the shell answered `onRenderProcessGone`: the WebView
          // aborted the whole app — the launcher on screen where the app was.
          // `chrome://crash` and `chrome://kill` are the WebView's own hooks
          // for the two ways it goes (a crash; a kill, as the system's).
          const pkg = standalone;
          const ev = (e: string) => onPage(pkg, e);
          const pid = async () => (await adb("shell", "pidof", pkg)).out.trim();
          await launch(pkg, true);
          await until(
            "a fresh counter",
            async () => (await ev(COUNT)) === "0" ? true : null,
          );
          await ev(PLUS);
          await until(
            "the count to reach 1",
            async () => (await ev(COUNT)) === "1" ? true : null,
          );
          const app = await pid();
          for (
            const [url, said] of [
              ["chrome://crash", "CRASHED"],
              ["chrome://kill", "was KILLED by the system"],
            ] as const
          ) {
            await ev("window.__aioE2eMarker = 3, 1");
            await adb("logcat", "-c");
            // The navigation never answers: the process it ran in is gone.
            await withPage(pkg, (cdp) =>
              Promise.race([
                cdp.call("Page.navigate", { url }).catch(() => null),
                sleep(2000),
              ]));
            await until(
              `a new page after ${url}, the count kept`,
              async () =>
                (await ev("window.__aioE2eMarker ?? 0")) === 0 &&
                  (await ev(COUNT)) === "1"
                  ? true
                  : null,
              60_000,
            );
            assertEquals(await pid(), app, "the app died with its renderer");
            assert(await resumed(pkg), "the app left the screen");
            assertStringIncludes(
              (await adb("logcat", "-d", "-s", "aio:E")).out,
              `renderer process ${said}`,
            );
            // A second loss within 10 s is a loop, and the shell stops the
            // app instead (RENDERER_LOSS_LOOP_MS): past that before the next.
            await sleep(10_500);
          }
        },
      );

      await step(
        "standalone: <input type=file> opens the system's picker; backing out answers the page, and it opens again; a blob: download is refused out loud",
        async () => {
          // Measured on a phone before the shell answered `onShowFileChooser`
          // and set a download listener: a tap on a file input did nothing,
          // a tap on a download link did nothing, and logcat said nothing.
          const pkg = standalone;
          const ev = (e: string) => onPage(pkg, e);
          await ev(
            `(window.__aioE2eFile = Object.assign(document.createElement("input"), { type: "file" }), ` +
              `window.__aioE2eSaw = [], ["change", "cancel"].forEach((n) => ` +
              `__aioE2eFile.addEventListener(n, () => __aioE2eSaw.push(n))), ` +
              `document.body.appendChild(__aioE2eFile), 1)`,
          );
          // Twice: a picker whose callback was never answered (the user
          // backed out) is the last one that WebView ever opens.
          for (const round of [1, 2]) {
            await onPage(pkg, "__aioE2eFile.click(), 1", true);
            await until(
              `the system's file picker in front (round ${round})`,
              async () => (await resumed(pkg)) ? null : true,
            );
            await until(`the app back in front (round ${round})`, async () => {
              if (await resumed(pkg)) return true;
              await adb("shell", "input", "keyevent", "4");
              return null;
            });
            await until(
              `the page to be told the picker closed (round ${round})`,
              async () =>
                (await ev("__aioE2eSaw.length")) === round ? true : null,
            );
          }
          assertEquals(await ev("__aioE2eSaw.join()"), "cancel,cancel");
          // A file the page made: nothing outside the page can fetch it.
          await adb("logcat", "-c");
          await onPage(
            pkg,
            `(() => { const a = Object.assign(document.createElement("a"), { ` +
              `href: URL.createObjectURL(new Blob(["x"])), download: "x.txt" }); ` +
              `document.body.appendChild(a); a.click(); })(), 1`,
            true,
          );
          await until(
            "the shell to say the download was not saved",
            async () =>
              (await adb("logcat", "-d", "-s", "aio:E")).out.includes(
                  "download NOT saved: a blob: link",
                )
                ? true
                : null,
          );
        },
      );

      await step(
        "standalone: a second app keeps its own storage; `persist: false` from app.ts reaches a new install, and an install that holds state keeps it",
        async () => {
          const dirB = await tempDir("aio-android-e2e-b-");
          let b = "";
          try {
            const a = standalone;
            await launch(a, true);
            await until(
              "a fresh counter",
              async () => (await onPage(a, COUNT)) === "0" ? true : null,
            );
            await onPage(a, PLUS);
            await onPage(a, PLUS);
            await until(
              "A's count to reach 2",
              async () => (await onPage(a, COUNT)) === "2" ? true : null,
            );

            await counterApp(dirB, { title: "aio-android-e2e-b" });
            await colorScheme(dirB, "light");
            b = await install(await build(dirB, false));
            assertNotEquals(b, a, "the second app took the first one's id");
            await launch(b, true);
            assertEquals(
              await until(
                "B's counter",
                async () => (await onPage(b, COUNT)) ?? null,
              ),
              "0",
              "the second app started with the first app's state",
            );
            for (let i = 0; i < 3; i++) await onPage(b, PLUS);
            await until(
              "B's count to reach 3",
              async () => (await onPage(b, COUNT)) === "3" ? true : null,
            );
            assertStringIncludes(String(await onPage(b, STORED)), '"count":3');
            await launch(a);
            assertEquals(
              await until(
                "A's restored counter",
                async () => (await onPage(a, COUNT)) ?? null,
              ),
              "2",
              "the second app's writes reached the first app",
            );
            const where = "AioNativeStore.where(__aioNativeStoreKey)";
            assertStringIncludes(String(await onPage(a, where)), `/${a}/`);
            assertStringIncludes(String(await onPage(b, where)), `/${b}/`);

            // The same app, updated in place — now with `persist: false` in
            // its app.ts. The entry never runs on the phone: the BUILD read
            // the option and baked it in. This install already holds state
            // (every APK before the options were baked saved it, whatever
            // app.ts said): an update must not lose it. Kept, still saved.
            const had = String(await onPage(b, COUNT));
            assert(Number(had) > 0, `B holds no state to keep: ${had}`);
            await counterApp(dirB, {
              title: "aio-android-e2e-b",
              run: "persist: false,",
            });
            await colorScheme(dirB, "light");
            assertEquals(await install(await build(dirB, false)), b);
            assertStringIncludes(buildOut, "options baked in: persist");
            await launch(b);
            assertEquals(
              await until(
                "B's counter after the update",
                async () => (await onPage(b, COUNT)) ?? null,
              ),
              had,
              "an update to `persist: false` lost the state the install held",
            );
            await onPage(b, PLUS);
            const more = String(Number(had) + 1);
            await until(
              `B's count to reach ${more}`,
              async () => (await onPage(b, COUNT)) === more ? true : null,
            );
            await launch(b);
            assertEquals(
              await until(
                "B's counter after a kill",
                async () => (await onPage(b, COUNT)) ?? null,
              ),
              more,
              "an install that holds state stopped saving it",
            );
            // A NEW install (its data cleared) of the same APK holds nothing:
            // there `persist: false` is the rule — nothing is saved.
            await launch(b, true);
            assertEquals(
              await until(
                "B's counter on a fresh install",
                async () => (await onPage(b, COUNT)) ?? null,
              ),
              "0",
            );
            await onPage(b, PLUS);
            await until(
              "B's count to reach 1",
              async () => (await onPage(b, COUNT)) === "1" ? true : null,
            );
            await launch(b);
            assertEquals(
              await until(
                "B's counter after a kill",
                async () => (await onPage(b, COUNT)) ?? null,
              ),
              "0",
              "`persist: false` did not reach the phone: a change was saved",
            );
            // `android.colorScheme: "light"`: light on a phone set to dark.
            assertEquals(
              await seesDark(b, true),
              false,
              '`android.colorScheme: "light"` followed the system into dark',
            );
          } finally {
            if (b) await adb("uninstall", b);
            await dropTempDir(dirB);
          }
        },
      );

      await step(
        "standalone: browser workers run in the APK — a module worker, a classic one that starts its own, one from an assets mount; a WebView has no SharedWorker",
        async () => {
          const dirW = await tempDir("aio-android-e2e-w-");
          let w = "";
          try {
            await counterApp(dirW, { title: "aio-android-e2e-w" });
            await writeWorkerApp(dirW);
            // One more, three deep: a worker that starts the classic one
            // (which starts the module one) and, by plain path, the mount's.
            // WebView 133+ loads no script for a worker a worker starts —
            // the APK starts those from a Blob — so the middle one's
            // `import.meta.url` is checked to still be its script's.
            await Deno.writeTextFile(
              join(dirW, "src", "deep.ts"),
              `const mid = new Worker(new URL("./sub/classic.ts", import.meta.url));
const own = new Worker("workers/w.js");
const got: string[] = [];
mid.onmessage = own.onmessage = (e) => {
  got.push(String(e.data));
  if (got.length === 2) (self as unknown as Worker).postMessage("deep:" + got.sort().join("+"));
};
mid.onerror = own.onerror = () => (self as unknown as Worker).postMessage("deep:inner-error");
self.onmessage = () => { mid.postMessage(1); own.postMessage(1); };`,
            );
            const appW = join(dirW, "src", "App.tsx");
            const appSrc = await Deno.readTextFile(appW);
            const withDeep = appSrc.replace(
              `run("mount"`,
              `run("deep", new Worker(new URL("./deep.ts", import.meta.url)));\n    run("mount"`,
            );
            assert(
              withDeep !== appSrc,
              "the worker app no longer starts a mount worker",
            );
            await Deno.writeTextFile(appW, withDeep);
            // The worker's own npm import, installed as an app's author
            // installs it (a worker that cannot be bundled is left as it was).
            await fixtureNodeModules(dirW);
            const cfgPath = join(dirW, "deno.json");
            const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
            cfg.assets = { ...cfg.assets, "/workers": "./workers" };
            await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
            await colorScheme(dirW, "dark");
            w = await install(await build(dirW, false));
            await launch(w, true);
            const want = {
              ...WORKER_ANSWERS,
              shared: "unsupported",
              deep: "deep:classic:dep>ran:dep:2+ran:mount",
            };
            let last = "";
            const got = await until(
              "every worker's answer",
              async () => {
                last = String(
                  await onPage(w, "document.getElementById('r').textContent"),
                );
                const r = JSON.parse(last) as Record<string, string>;
                return Object.keys(want).every((k) => k in r) ? r : null;
              },
              60_000,
            ).catch((e) => {
              throw new Error(`${e.message} — the page shows ${last}`);
            });
            assertEquals(got, want);
            // `android.colorScheme: "dark"` — the look every APK had through
            // 1.0.19 — on a phone set to light.
            assertEquals(
              await seesDark(w, false),
              true,
              '`android.colorScheme: "dark"` followed the system into light',
            );
          } finally {
            if (w) await adb("uninstall", w);
            await dropTempDir(dirW);
          }
        },
      );

      await step(
        "build.android.strict: an own MainActivity.kt that drops the store fails the build, naming each loss",
        async () => {
          const dirS = await tempDir("aio-android-e2e-strict-");
          try {
            await counterApp(dirS, { title: "aio-android-e2e-strict" });
            const kt = join(dirS, "android", "app", "src", "main", "java");
            await Deno.mkdir(join(kt, "aio", "app"), { recursive: true });
            await Deno.writeTextFile(
              join(kt, "aio", "app", "MainActivity.kt"),
              "package aio.app\nclass MainActivity : " +
                "androidx.appcompat.app.AppCompatActivity()\n",
            );
            const cfgPath = join(dirS, "deno.json");
            const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
            cfg.build = { ...cfg.build, android: { strict: true } };
            await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
            const r = await sh(
              Deno.execPath(),
              ["run", "-A", join(REPO, "src", "build.ts"), "--android"],
              { cwd: dirS, env: { ANDROID_HOME: SDK } },
            );
            assert(!r.ok, `the strict build went through:\n${r.out}`);
            assertStringIncludes(r.out, "does not install AioNativeStore");
            assertStringIncludes(r.out, "does not install AioNativeFetch");
            assertStringIncludes(
              r.out,
              "build.android.strict: no APK was built",
            );
            assert(
              !r.out.includes("aio never reads"),
              `build.android is called an unknown key:\n${r.out}`,
            );
            // Refused before Gradle ran.
            assert(!r.out.includes("BUILD SUCCESSFUL"), r.out);
          } finally {
            await dropTempDir(dirS);
          }
        },
      );

      await step(
        "release: a keystore from the environment signs the APK and the bundle; not debuggable; it runs",
        async () => {
          const keys = await tempDir("aio-android-e2e-keys-");
          try {
            // A throwaway key, made here and dropped with this directory.
            const ks = join(keys, "throwaway.jks");
            const pass = `throwaway-${crypto.randomUUID()}`;
            const made = await sh("keytool", [
              "-genkeypair",
              "-keystore",
              ks,
              "-storepass",
              pass,
              "-keypass",
              pass,
              "-alias",
              "aio-e2e",
              "-keyalg",
              "RSA",
              "-keysize",
              "2048",
              "-validity",
              "2",
              "-dname",
              "CN=aio e2e throwaway",
            ]);
            assert(made.ok, `keytool: ${made.out}`);
            const badging = async (apk: string) =>
              (await sh(buildTool("aapt2"), ["dump", "badging", apk])).out;
            // The instrument sees a debuggable APK when there is one.
            assertStringIncludes(
              await badging(standaloneApk),
              "application-debuggable",
            );

            const apk = await build(dir, false, {
              args: ["--release"],
              env: {
                AIO_ANDROID_KEYSTORE: ks,
                AIO_ANDROID_KEYSTORE_PASSWORD: pass,
                AIO_ANDROID_KEY_ALIAS: "aio-e2e",
              },
            });
            assert(!apk.includes("unsigned"), apk);
            const certs = await sh(buildTool("apksigner"), [
              "verify",
              "--print-certs",
              apk,
            ]);
            assert(certs.ok, certs.out);
            assertStringIncludes(certs.out, "CN=aio e2e throwaway");
            assert(
              !(await badging(apk)).includes("application-debuggable"),
              "the signed release is debuggable",
            );
            const aab = apk.replace(/\.apk$/, ".aab");
            assertStringIncludes(
              (await sh("jarsigner", ["-verify", aab])).out,
              "jar verified",
            );
            assertStringIncludes(
              (await sh("keytool", ["-printcert", "-jarfile", aab])).out,
              "CN=aio e2e throwaway",
            );
            // The password went from the environment to Gradle's memory and
            // nowhere else: not into the generated project, not into a log.
            assertEquals(
              (await sh("grep", ["-rl", pass, join(dir, ".aio")])).out.trim(),
              "",
              "the keystore password was written into the build tree",
            );
            assert(!buildOut.includes(pass), "the build printed the password");

            // …and it is the app: R8-minified, signed, no DevTools — read
            // through the OS's accessibility dump. A tap is saved by the
            // native store and survives a kill.
            const pkg = standalone;
            await adb("uninstall", pkg); // another signature: no update path
            assertEquals(await install(apk), pkg);
            await launch(pkg);
            const node = (text: string) =>
              until(
                `"${text}" on screen`,
                async () =>
                  (await screen()).find((n) => n.text === text) ?? null,
              );
            await node("AIO Counter");
            await node("0");
            const plus = await node("+");
            await adb("shell", "input", "tap", `${plus.x}`, `${plus.y}`);
            await node("1");
            await launch(pkg);
            await node("1");
            assertStringIncludes(
              (await adb("shell", "run-as", pkg, "id")).out,
              "not debuggable",
            );
          } finally {
            // Whatever happened: no release-signed app is left where the next
            // run installs a debug-signed one over it.
            await adb("uninstall", standalone);
            await dropTempDir(keys);
          }
        },
      );

      let client = "";
      const port = freePort();
      /** The server's count (`/count`), or null while it does not answer. */
      const count = async (query = "") => {
        const r = await fetch(`http://127.0.0.1:${port}/count${query}`);
        return r.ok ? await r.text() : (await r.body?.cancel(), null);
      };
      const MINUS = "document.querySelectorAll('button')[0].click(), 1";

      await step(
        "client: connects by itself, a tap reaches the server, a call made offline is delivered, Back and a dead server reach the form",
        async () => {
          const cfgPath = join(dir, "deno.json");
          const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
          cfg.build = { ...cfg.build, server: `http://${hostAddr()}:${port}` };
          await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
          if (!isEmulator()) {
            await adb("reverse", `tcp:${port}`, `tcp:${port}`);
            takeBack.push(["reverse", "--remove", `tcp:${port}`]);
          }
          // The server takes its port BEFORE the client is built, and holds
          // it through the build. Started after it, the port — free when it
          // was picked — sat unbound for the minute Gradle takes, and on a
          // loaded machine another process's `port: 0` was handed the same
          // number: the server refused to boot ("port … already in use"),
          // and this step timed out waiting for it. `--no-watch`: the build
          // writes into the app's tree, and that is no reason to restart.
          const srv = server = startServer(dir, [
            `--port=${port}`,
            "--no-watch",
          ]);
          assertEquals(
            await until("the server", count, 60_000).catch((e) => {
              throw new Error(`${e.message}\nthe server said:\n${srv.log()}`);
            }),
            "0",
          );
          const pkg = client = await install(await build(dir, true));
          takeBack.push(["uninstall", pkg]);
          const ev = (e: string) => onPage(pkg, e);

          await launch(pkg, true);
          await until(
            "the client to open its server",
            async () =>
              (await ev("location.host")) === `${hostAddr()}:${port}`
                ? true
                : null,
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

          // A response sent as an attachment. A WebView saves nothing by
          // itself: with no download listener the tap did nothing and said
          // nothing. The shell hands it to Android's DownloadManager.
          const saved = "/sdcard/Download/aio-e2e-export.txt";
          await adb("shell", "rm", "-f", saved);
          takeBack.push(["shell", "rm", "-f", saved]);
          await onPage(
            pkg,
            `(document.body.appendChild(Object.assign(document.createElement("a"), ` +
              `{ href: "/export" })).click(), 1)`,
            true,
          );
          assertEquals(
            await until("the download to land in Downloads", async () => {
              const r = await adb("shell", "cat", saved);
              return r.ok ? r.out : null;
            }),
            "aio-e2e export",
          );
          assertEquals(await ev(COUNT), "1", "the download replaced the page");

          // Offline, then back: a tap made with no network is kept and
          // delivered when the socket returns. (The emulator's airplane mode;
          // a phone on USB keeps its `adb reverse` tunnel through it.)
          if (isEmulator()) {
            const airplane = (on: boolean) =>
              adb(
                "shell",
                "cmd",
                "connectivity",
                "airplane-mode",
                on ? "enable" : "disable",
              );
            await airplane(true);
            try {
              await until(
                "the page to say it lost its server",
                async () =>
                  String(await ev("document.body.innerText")).includes(
                      "Reconnecting",
                    )
                    ? true
                    : null,
                60_000,
              );
              await ev(PLUS);
              assertEquals(await count(), "1", "a tap arrived while offline");
            } finally {
              await airplane(false);
            }
            await until(
              "the tap made offline to reach the server",
              async () => (await count()) === "2" ? true : null,
              90_000,
            );
            await ev(MINUS);
            await until(
              "the count back at 1",
              async () => (await count()) === "1" ? true : null,
            );
          }

          // A server-talking APK asks the page on Back too: the app's
          // handler takes the first one (count 1 → 0, on the SERVER).
          await clearSystemDialogs();
          await adb("shell", "input", "keyevent", "4");
          await until(
            "Back to reach the app's handler (server count 0)",
            async () => (await count()) === "0" ? true : null,
          );
          // Back from the server's first page with no handler taking it: the
          // connect form, prefilled.
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
            `http://${hostAddr()}:${port}`,
          );

          // The server gone: the form, SAYING so — not Chromium's error page.
          await srv.stop();
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

      await step(
        "client: a keyed --expose server is paired by its code or its share link — over plain http, and over TLS on the certificate it signed itself; a wrong code, an unknown certificate and a changed one are refused, each saying so",
        async () => {
          const pkg = client;
          const ev = (e: string) => onPage(pkg, e);
          const connect = (url: string, pin = "") =>
            ev(
              `(document.getElementById('addr').value = ${
                JSON.stringify(url)
              }, document.getElementById('pin').value = ${
                JSON.stringify(pin)
              }, document.getElementById('f').requestSubmit(), 1)`,
            );
          const form = (hash: string) =>
            until(
              `the form at ${hash}`,
              async () =>
                (await ev("location.hash")) === hash
                  ? String(
                    await ev("document.getElementById('err').textContent"),
                  )
                  : null,
            );
          const said = (what: string) =>
            until(
              `the form to say "${what}"`,
              async () =>
                String(await ev("document.getElementById('err').textContent"))
                    .includes(what)
                  ? true
                  : null,
            );
          const printed = (srv: ReturnType<typeof startServer>, re: RegExp) =>
            until(
              `the server to print ${re}`,
              () => Promise.resolve(srv.log().match(re)?.[1] ?? null),
              60_000,
            ).catch((e) => {
              throw new Error(`${e.message}\nthe server said:\n${srv.log()}`);
            });
          /** A code that is not `pin`. */
          const wrong = (pin: string) => pin === "000000" ? "111111" : "000000";
          const at = `${hostAddr()}:${port}`;

          // A previous step that failed left its server up, and this one's
          // then refused to start ("Already running") — one failure read as
          // two.
          if (server) await server.stop();
          // ── Plain http (`--no-tls`) ──────────────────────────────────────
          let srv = server = startServer(dir, [
            `--port=${port}`,
            "--expose",
            "--no-tls",
          ]);
          const link = await printed(srv, /share: (http:\/\/\S+)/);
          const pin = await printed(srv, /pair code: (\d{6})/);
          const token = new URL(link).searchParams.get("token");
          assert(token, `no token in ${link}`);
          const key = `?token=${token}`;
          assertEquals(await count(), null, "the exposed server asked no key");
          const before = Number(
            await until("the keyed count", () => count(key)),
          );

          // The address the build baked is bare: the server refuses it — and
          // the form says what the server needs, not its "Unauthorized".
          await launch(pkg);
          assertStringIncludes(await form("#keyed"), "needs its key");
          // A wrong code: said, and nothing is remembered.
          await connect(`http://${at}`, wrong(pin));
          await said("Invalid or expired pairing code");
          assertEquals(
            await ev("localStorage.getItem('aio_server')"),
            `http://${at}`,
          );
          // The code the server printed: in.
          await connect(`http://${at}`, pin);
          await until(
            "the keyed server's page, by pairing code",
            async () => (await ev(COUNT)) === String(before) ? true : null,
          );
          await ev(PLUS);
          await until(
            "the tap to reach the keyed server",
            async () => (await count(key)) === String(before + 1) ? true : null,
          );
          // …and straight in on the next launch: the pairing is remembered.
          await launch(pkg);
          await until(
            "the remembered pairing to open the app",
            async () => (await ev(COUNT)) === String(before + 1) ? true : null,
          );
          // A fresh install with the share link (as this device reaches the
          // host) instead of a code: in too.
          await launch(pkg, true);
          await form("#keyed");
          await connect(`http://${at}/${key}`);
          // …and killed in the instant the server's page shows, it is still
          // paired: the shell holds the address before the page is opened.
          // (The form's localStorage alone lost it on a kill within a second
          // — the app came back to "needs its key".)
          await until(
            "the keyed server's page to open",
            async () => (await ev("location.host")) === at ? true : null,
          );
          await launch(pkg);
          await until(
            "the keyed server's page, by share link, after a kill in the instant it opened",
            async () => (await ev(COUNT)) === String(before + 1) ? true : null,
          );

          // ── TLS, the default: a certificate the server signed itself ─────
          await srv.stop();
          srv = server = startServer(dir, [`--port=${port}`, "--expose"]);
          const tlsPin = await printed(srv, /pair code: (\d{6})/);
          await printed(srv, /share: (https:\/\/\S+)/);
          /** The server's own count over TLS, trusting the root of `home`. */
          const tlsCount = async (home: string, k: string) => {
            const http = Deno.createHttpClient({
              caCerts: [
                await Deno.readTextFile(
                  join(dir, home, ".aio-ca", "aio-root.pem"),
                ),
              ],
            });
            try {
              const r = await fetch(
                `https://127.0.0.1:${port}/count${k}`,
                { client: http } as RequestInit & { client: Deno.HttpClient },
              );
              return r.ok ? await r.text() : (await r.body?.cancel(), null);
            } finally {
              http.close();
            }
          };
          const n = Number(
            await until("the TLS count", () => tlsCount(".home", key)),
          );
          await launch(pkg); // the remembered http:// link, at a TLS port
          await form("#unreachable");
          // A bare https address: nothing vouches for the certificate.
          await connect(`https://${at}`);
          assertStringIncludes(
            await form("#untrusted"),
            "does not trust the certificate",
          );
          // A wrong code pairs nothing — and pins nothing.
          await connect(at, wrong(tlsPin));
          await said("Invalid or expired pairing code");
          await connect(`https://${at}`);
          await said("does not trust the certificate");
          // The right code, the address typed without a scheme: https, in —
          // and the page's socket (wss) is let through on the same pin.
          await connect(at, tlsPin);
          await until(
            "the TLS server's page, by pairing code",
            async () =>
              (await ev("location.protocol")) === "https:" &&
                (await ev(COUNT)) === String(n)
                ? true
                : null,
          );
          await ev(PLUS);
          await until(
            "the tap to reach the TLS server",
            async () =>
              (await tlsCount(".home", key)) === String(n + 1) ? true : null,
          );
          await launch(pkg);
          await until(
            "the pinned server to open on the next launch",
            async () => (await ev(COUNT)) === String(n + 1) ? true : null,
          );

          // ── Another identity at the same address ─────────────────────────
          // Its own key and its own certificate root: to this client, the
          // paired server's certificate CHANGED. Refused, saying so — and
          // refused again on Connect, because it cannot prove it holds the
          // key this client paired with.
          await srv.stop();
          srv = server = startServer(
            dir,
            [`--port=${port}`, "--expose"],
            ".home-other",
          );
          const other = new URL(
            await printed(srv, /share: (https:\/\/\S+)/),
          ).searchParams.get("token");
          assert(other && other !== token, "the second server has its own key");
          await launch(pkg);
          assertStringIncludes(
            await form("#changed"),
            "not the one this device paired with",
          );
          // The second refusal is seen where the shell says it (logcat): the
          // form's hash is the same before and after.
          await adb("logcat", "-c");
          await ev("document.getElementById('f').requestSubmit(), 1");
          await until(
            "the shell to refuse the certificate again",
            async () =>
              (await adb("logcat", "-d", "-s", "aio:E")).out.includes(
                  "not the one pinned for this server",
                )
                ? true
                : null,
          );
          assertStringIncludes(
            await form("#changed"),
            "not the one this device paired with",
          );
          // Its OWN share link: the server proves that key on the certificate
          // it presents, which becomes the pin. In.
          const m = Number(
            await until(
              "the second server's count",
              () => tlsCount(".home-other", `?token=${other}`),
            ),
          );
          await connect(`https://${at}/?token=${other}`);
          await until(
            "the second server's page, by share link",
            async () =>
              (await ev("location.protocol")) === "https:" &&
                (await ev(COUNT)) === String(m)
                ? true
                : null,
          );
          await ev(PLUS);
          await until(
            "the tap to reach the second server",
            async () =>
              (await tlsCount(".home-other", `?token=${other}`)) ===
                  String(m + 1)
                ? true
                : null,
          );
          await srv.stop();
          server = null;
        },
      );

      const api = (await adb("shell", "getprop", "ro.build.version.sdk")).out
        .trim();
      const { recordProof } = await import("../scripts/proof.ts");
      const proved =
        `API ${api}: standalone (dispatch, durable native store — survives an instant kill and a background kill, rotation, light/dark live, android.colorScheme dark and light hold against the system, app.ts options baked — ui.theme/lang/dir reach the phone, persist: false a new install while an install holding state keeps it, a second app keeps its own storage, browser workers (module, classic+nested, three deep, assets mount), nativeFetch past an Origin-refusing API, a foreign iframe can neither read nor write the store) + signed release (keystore from the environment, APK + AAB, not debuggable, runs) + client (connect, server dispatch, ${
          isEmulator() ? "a call made offline delivered, " : ""
        }Back, unreachable, keyed --expose server by pairing code and by share link over http and over self-signed TLS — certificate pinned; wrong code, unknown and changed certificate refused)`;
      // Two literal rows (tests/proof-claims-have-gates.test.ts reads them).
      if (red) { /* the failed steps are the result — nothing is proved */ }
      else if (isEmulator()) await recordProof("android", "emulator", proved);
      else await recordProof("android", "device", proved);
    } finally {
      if (server) {
        await (server as ReturnType<typeof startServer>).stop();
      }
      if (!isEmulator()) { for (const args of takeBack) await adb(...args); }
      if (emu.started) await adb("emu", "kill");
      await dropTempDir(dir);
    }
  },
});
