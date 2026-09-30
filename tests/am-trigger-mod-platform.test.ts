// `am trigger … press "mod+k"`: `mod` is the modifier of the PAGE's platform —
// the UI client's (its User-Agent, carried on the roster as `mac`) — not of the
// machine running `am`. A Linux `am` driving a Safari tab sent Ctrl+K, which a
// Mac app's `mod` shortcut does not answer.
import { assertEquals } from "@std/assert";
import { cmdTrigger } from "../src/am/am-cmd-inspect.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { resolveAmAppId } from "../src/am/am-utils.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const APP = "am-trigger-mod-platform-app";

/** A stand-in app whose roster holds one UI client with `mac`; records the
 *  trigger bodies am sends. */
async function pressed(mac: boolean | undefined, spec: string) {
  const envKey = "AIO_APPS_DIR";
  const prevEnv = Deno.env.get(envKey);
  const appsDir = await tempDir("am-trigger-mod-");
  Deno.env.set(envKey, appsDir);
  _resetInstanceVerify();
  const port = freePort();
  const seen: Record<string, unknown>[] = [];
  const ac = new AbortController();
  const server = Deno.serve({
    port,
    signal: ac.signal,
    onListen: () => {},
  }, async (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/__aio/health") {
      return Response.json({ appId: resolveAmAppId(APP) });
    }
    if (p === "/__aio/trojan/clients") {
      return Response.json([
        { index: 0, type: "browser-reload" },
        { index: 3, type: "browser", ...(mac === undefined ? {} : { mac }) },
      ]);
    }
    seen.push(await req.json() as Record<string, unknown>);
    return Response.json({ ok: true, surface: [] });
  });
  const realLog = console.log;
  console.log = () => {};
  try {
    await cmdTrigger(
      ["App:Stage", "press", spec],
      { app: APP, port, json: true } as GlobalFlags,
    );
  } finally {
    console.log = realLog;
    ac.abort();
    await server.finished;
    _resetInstanceVerify();
    if (prevEnv === undefined) Deno.env.delete(envKey);
    else Deno.env.set(envKey, prevEnv);
    await dropTempDir(appsDir);
  }
  return seen;
}

Deno.test("am trigger: mod follows the UI client's platform", async () => {
  assertEquals(await pressed(true, "mod+k"), [{
    path: "App:Stage",
    action: "press",
    key: "k",
    mods: { metaKey: true },
  }]);
  assertEquals((await pressed(false, "mod+k"))[0]!.mods, { ctrlKey: true });
});

Deno.test("am trigger: a client of unknown platform takes am's own OS", async () => {
  // am's own platform is `Deno.build.os` — `navigator.platform` is not the
  // OS on every host. Injected both ways so the test holds on any machine.
  const real = Object.getOwnPropertyDescriptor(Deno, "build")!;
  const onOs = async (os: string) => {
    // With os stubbed to `windows`, the lock-dir base comes from TEMP/TMP —
    // and with neither set it is the literal `C:\Temp`, which this test then
    // created in the repo root on Linux (it reappeared on every suite run).
    // Point them at a managed temp dir for the length of the stub.
    const winTemp = os === "windows" ? await tempDir("am-trigger-win-") : null;
    const prev = { TEMP: Deno.env.get("TEMP"), TMP: Deno.env.get("TMP") };
    if (winTemp) {
      Deno.env.set("TEMP", winTemp);
      Deno.env.set("TMP", winTemp);
    }
    Object.defineProperty(Deno, "build", {
      ...real,
      value: { ...Deno.build, os },
    });
    try {
      return (await pressed(undefined, "mod+k"))[0]!.mods;
    } finally {
      Object.defineProperty(Deno, "build", real);
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
      if (winTemp) await dropTempDir(winTemp);
    }
  };
  assertEquals(await onOs("darwin"), { metaKey: true });
  assertEquals(await onOs("linux"), { ctrlKey: true });
  assertEquals(await onOs("windows"), { ctrlKey: true });
});
