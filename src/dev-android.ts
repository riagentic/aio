/**
 * @module
 * `deno task dev:android` — run the app in an Android emulator against the LIVE
 * dev server (the mobile counterpart of `dev:browser`):
 *   1. ensure an emulator is running (boot an AVD if none),
 *   2. build a thin dev APK whose WebView loads http://10.0.2.2:PORT,
 *   3. start the dev server, install + launch the app, keep the server running.
 *
 * Edits reflect live (reload in the WebView) — no re-bundle. Needs the Android
 * SDK (adb + emulator) and at least one AVD; fails loud with steps otherwise.
 */
import { join } from "@std/path";
import { resolveSdk } from "./build/build-helpers.ts";

const dec = new TextDecoder();

async function run(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command(cmd, {
    args,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: p.code, out: dec.decode(p.stdout), err: dec.decode(p.stderr) };
}

function fail(msg: string, ...lines: string[]): never {
  console.error(`[dev:android] ✗ ${msg}`);
  for (const l of lines) console.error(`  ${l}`);
  Deno.exit(1);
}

function freePort(): number {
  const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** True once a booted, non-offline device is attached. */
async function deviceReady(adb: string): Promise<boolean> {
  const { out } = await run(adb, ["devices"]);
  const online = out.split(/\r?\n/).slice(1).some((l) =>
    /\tdevice$/.test(l.trim())
  );
  if (!online) return false;
  const boot = await run(adb, ["shell", "getprop", "sys.boot_completed"]);
  return boot.out.trim() === "1";
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`timed out waiting for ${what} (${timeoutMs / 1000}s)`);
}

async function main(): Promise<void> {
  const sdk = resolveSdk();
  if (!sdk) {
    fail(
      "Android SDK not found — set ANDROID_HOME to your SDK dir (the one with " +
        "platform-tools/), install the SDK, and create an emulator (AVD)",
      "ANDROID_HOME may point at the SDK or its parent (e.g. ~/Android → ~/Android/Sdk)",
    );
  }
  const exe = Deno.build.os === "windows" ? ".exe" : "";
  const adb = join(sdk, "platform-tools", `adb${exe}`);
  const emulatorBin = join(sdk, "emulator", `emulator${exe}`);
  for (
    const t of [
      { path: adb, hint: "platform-tools" },
      { path: emulatorBin, hint: "emulator" },
    ]
  ) {
    try {
      await Deno.stat(t.path);
    } catch {
      fail(
        `${t.hint} not found in the SDK ($ANDROID_HOME/${t.hint})`,
        `install it: ${
          join(sdk, "cmdline-tools/latest/bin/sdkmanager")
        } "${t.hint}"`,
      );
    }
  }

  // Pick an AVD (AIO_AVD overrides; else the first one).
  const avds = (await run(emulatorBin, ["-list-avds"])).out
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const wantAvd = Deno.env.get("AIO_AVD");
  const avd = wantAvd ?? avds[0];
  if (!avd) {
    fail(
      "no Android emulator (AVD) found — create one, then re-run",
      'e.g. via Android Studio → Device Manager, or `avdmanager create avd`',
    );
  }
  if (wantAvd && !avds.includes(wantAvd)) {
    fail(`AVD "${wantAvd}" not found — available: ${avds.join(", ") || "(none)"}`);
  }

  const port = freePort();
  const devUrl = `http://10.0.2.2:${port}`; // 10.0.2.2 = host loopback from AVD

  // 1) Boot the emulator early (slow) unless one is already running.
  await run(adb, ["start-server"]);
  let emuProc: Deno.ChildProcess | undefined;
  if (!(await deviceReady(adb))) {
    console.log(`[dev:android] booting emulator "${avd}"...`);
    emuProc = new Deno.Command(emulatorBin, {
      args: ["-avd", avd, "-no-boot-anim", "-no-snapshot-save"],
      stdout: "null",
      stderr: "null",
    }).spawn();
  } else {
    console.log("[dev:android] using the already-running emulator");
  }

  // 2) Build the dev APK (in parallel with the emulator booting).
  console.log("[dev:android] building dev APK...");
  const buildTs = new URL("./build.ts", import.meta.url).href;
  const build = await run("deno", [
    "run",
    "-A",
    buildTs,
    "--android",
    `--android-dev-url=${devUrl}`,
  ]);
  if (build.code !== 0) {
    console.error(build.out + build.err);
    fail("APK build failed (see above)");
  }
  const apk = [...Deno.readDirSync(Deno.cwd())]
    .filter((e) => e.isFile && e.name.endsWith(".apk"))
    .map((e) => ({ name: e.name, m: Deno.statSync(e.name).mtime?.getTime() ?? 0 }))
    .sort((a, b) => b.m - a.m)[0]?.name;
  if (!apk) fail("no .apk produced by the build");
  const appId = `app.aio.${apk.replace(/\.apk$/, "").replace(/[^a-z0-9]/g, "")}`;

  // 3) Start the dev server (the app in the emulator loads it via 10.0.2.2).
  console.log(`[dev:android] starting dev server on :${port}...`);
  const server = new Deno.Command("deno", {
    args: ["run", "-A", "src/app.ts", "--client=browser", `--port=${port}`],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  // 4) Wait for the emulator, then install + launch.
  await waitFor(() => deviceReady(adb), 180_000, "the emulator to finish booting");
  console.log(`[dev:android] installing ${apk}...`);
  const inst = await run(adb, ["install", "-r", join(Deno.cwd(), apk)]);
  if (inst.code !== 0) {
    console.error(inst.out + inst.err);
    try {
      server.kill("SIGKILL");
    } catch { /* gone */ }
    fail("adb install failed (see above)");
  }
  await run(adb, [
    "shell",
    "am",
    "start",
    "-n",
    `${appId}/aio.app.MainActivity`,
  ]);
  console.log(
    `[dev:android] ✓ ${apk} launched on "${avd}" → ${devUrl}\n` +
      "  edit your app and reload in the emulator; Ctrl-C to stop the server.",
  );

  // 5) Keep the server in the foreground; tear it down on exit.
  const stop = () => {
    try {
      server.kill("SIGTERM");
    } catch { /* gone */ }
  };
  Deno.addSignalListener("SIGINT", () => {
    stop();
    Deno.exit(0);
  });
  const status = await server.status;
  void emuProc; // left running for fast re-runs
  Deno.exit(status.code);
}

if (import.meta.main) await main();
