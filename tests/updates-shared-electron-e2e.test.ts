// A REAL update of a shared-runtime app (`build.electronRuntime: "online"`):
// two compiled binaries, a signed channel, and an Electron mirror. The new
// build needs an Electron the per-user store does not have, so the updater
// must put it there BEFORE the swap (src/server/updates-electron.ts) — and
// when that download fails, the update is refused and the old version keeps
// serving. Gated like the other artifact e2e tests (AIO_BUILD_E2E=1).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  buildFlags,
  freePort,
  kill,
  makeApp,
  placedBinary,
  spawn,
  waitForHttp,
} from "./e2e-app-harness.ts";
import { generateSigningKey, shipApp } from "../src/build/ship.ts";
import {
  DEFAULT_ELECTRON_VERSION,
  electronSlug,
  electronZipName,
} from "../src/electron/electron-runtime-fetch.ts";
import { sharedElectronReady } from "../src/electron/shared-runtime.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { runtimeZip } from "./electron-runtime-stub.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";
const SLUG = electronSlug();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ws(port: number, type: string, settleMs: number) {
  const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let state: Record<string, Record<string, unknown>> = {};
  s.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    try {
      const f = JSON.parse(e.data);
      if (f?.t === "state" && f.d) state = f.d;
    } catch { /* not a JSON frame */ }
  });
  await new Promise<void>((res, rej) => {
    s.addEventListener("open", () => res());
    s.addEventListener("error", () => rej(new Error(`ws to :${port} failed`)));
  });
  await new Promise((r) => setTimeout(r, 500));
  s.send(JSON.stringify({ v: 2, t: "action", d: { type } }));
  await new Promise((r) => setTimeout(r, settleMs));
  s.close();
  return state;
}

Deno.test({
  name:
    "artifact: an online app's plain binary (browser by default) updates without fetching Electron — the mirror down changes nothing, nothing lands in the store",
  ignore: !GATE,
  // aio-ok: a compiled binary re-execs ITSELF to update; the successor is not a child the test can await
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-shared-update-");
    const tmp = await tempDir("shared-update-");
    const channel = join(tmp, "channel");
    const installDir = join(tmp, "install");
    const store = join(tmp, "store");
    await Deno.mkdir(channel);
    await Deno.mkdir(installDir);
    const keys = await generateSigningKey();
    const keyPath = join(tmp, "release-key.json");
    await Deno.writeTextFile(keyPath, JSON.stringify(keys));

    // The Electron mirror: the zip and its SHASUMS, or a 503 while `down`.
    const zip = await runtimeZip(tmp);
    const name = electronZipName(DEFAULT_ELECTRON_VERSION, SLUG);
    const sums = `${await sha256Hex(zip)} *${name}\n`;
    const mirror = { down: true, zipRequests: 0 };
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      (req) => {
        const p = new URL(req.url).pathname;
        if (p.endsWith("/SHASUMS256.txt")) return new Response(sums);
        if (p.endsWith(`/${name}`)) {
          mirror.zipRequests++;
          return mirror.down
            ? new Response("down", { status: 503 })
            : new Response(zip.slice().buffer as ArrayBuffer);
        }
        return new Response("no", { status: 404 });
      },
    );
    const envBefore = {
      mirror: Deno.env.get("ELECTRON_MIRROR"),
      store: Deno.env.get("AIO_SHARED_ELECTRON_DIR"),
    };
    Deno.env.set(
      "ELECTRON_MIRROR",
      `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/`,
    );
    Deno.env.set("AIO_SHARED_ELECTRON_DIR", store);
    let proc: Deno.ChildProcess | null = null;
    try {
      const cfgPath = join(dir, "deno.json");
      const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
      cfg.build = { ...(cfg.build ?? {}), electronRuntime: "online" };
      await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
      const appTs = await Deno.readTextFile(join(dir, "src", "app.ts"));
      await Deno.writeTextFile(
        join(dir, "src", "app.ts"),
        appTs.replace(
          /await aio\.run\(([\s\S]*?)\);/,
          `await aio.run({ updates: { source: "${toFileUrl(channel).href}", ` +
            `channel: "prod", auto: false, check: false } });`,
        ),
      );
      const publish = async (version: string) => {
        const c = JSON.parse(await Deno.readTextFile(cfgPath));
        c.version = version;
        await Deno.writeTextFile(cfgPath, JSON.stringify(c, null, 2));
        const bin = placedBinary(dir);
        await shipApp({
          binaryPath: bin,
          name: String(c.title ?? c.name),
          version,
          channel: "prod",
          channelDir: channel,
          url: "app",
          keyPath,
        });
        await Deno.copyFile(bin, join(channel, "prod", "app"));
      };

      // v0.1.0, installed.
      const b1 = await buildFlags(dir, "--compile");
      assertEquals(b1.code, 0, `v0.1.0 build failed:\n${b1.err}`);
      const installed = join(installDir, "app");
      await Deno.copyFile(placedBinary(dir), installed);
      await Deno.chmod(installed, 0o755);
      await publish("0.1.0");

      // v0.2.0: one method the older build cannot have.
      const cell = await Deno.readTextFile(join(dir, "src", "cell.ts"));
      await Deno.writeTextFile(
        join(dir, "src", "cell.ts"),
        cell.replace(
          /(\s+)reset\(s\) \{/,
          `$1double(s) {$1  s.count *= 2;$1},$1reset(s) {`,
        ),
      );
      const b2 = await buildFlags(dir, "--compile");
      assertEquals(b2.code, 0, `v0.2.0 build failed:\n${b2.err}`);
      await publish("0.2.0");

      const port = freePort();
      const s = spawn(
        installed,
        [`--port=${port}`, "--client=browser"],
        installDir,
      );
      proc = s.proc;
      await waitForHttp(`http://127.0.0.1:${port}/__aio/health`, 60_000);

      // A plain `--compile` binary is baked `--client=browser`: it may never
      // open a window, so its update fetches no Electron (1.0.23) — with the
      // mirror DOWN it still applies, and the store stays empty. The desktop
      // PACKAGE path (fetch before the swap, a failed fetch refuses the
      // update) is pinned in tests/electron-shared-runtime.test.ts
      // ("update pre-download…", "…refused…").
      const c1 = await ws(port, "updates:check", 4000);
      assertEquals(c1.updates?.status, "available", JSON.stringify(c1.updates));
      await ws(port, "updates:apply", 2000);
      let up = false;
      for (let i = 0; i < 120 && !up; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          await ws(port, "counter:double", 800);
          const h = await (await fetch(`http://127.0.0.1:${port}/__aio/health`))
            .json();
          up = (h.cells?.counter?.lastAction) === "counter:double";
        } catch { /* mid-handover */ }
      }
      assert(up, `v0.2.0 never served after the update:\n${s.log()}`);
      assertEquals(
        mirror.zipRequests,
        0,
        `a browser-default binary's update asked for Electron:\n${s.log()}`,
      );
      assertEquals(
        await sharedElectronReady(DEFAULT_ELECTRON_VERSION, SLUG, store),
        false,
        "Electron landed in the store for a binary that opens in a browser",
      );
    } finally {
      if (proc) await kill(proc).catch(() => {});
      await server.shutdown();
      for (
        const [k, v] of [
          ["ELECTRON_MIRROR", envBefore.mirror],
          ["AIO_SHARED_ELECTRON_DIR", envBefore.store],
        ] as const
      ) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await dropTempDir(tmp);
    }
  },
});
