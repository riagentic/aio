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
import { fromFileUrl, join } from "@std/path";
import { cdpConnect, cdpTargets } from "../src/am/am-cdp.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

const GATED = Deno.env.get("AIO_ANDROID_E2E") === "1";
const REPO = fromFileUrl(new URL("../", import.meta.url));
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
 *  server's own state (so a tap is proven to reach the server, not the DOM). */
async function counterApp(dir: string): Promise<void> {
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
      await nativeFetchOverlay(dir);

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

      await t.step(
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

      await t.step(
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

      await t.step(
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

      await t.step(
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
        `API ${api}: standalone (dispatch, durable native store — survives an instant kill, rotation, nativeFetch past an Origin-refusing API, a foreign iframe can neither read nor write the store) + client (connect, server dispatch, Back, unreachable)`,
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
