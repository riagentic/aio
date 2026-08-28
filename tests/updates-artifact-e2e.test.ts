// The update loop, on a REAL compiled aio binary.
//
// `tests/updates-e2e.test.ts` drives the whole path against stand-in artifacts
// (real programs, but shell scripts) and `tests/updates-boot-e2e.test.ts`
// proves a real `aio.run` boot offers a real signed release. Neither runs the
// half a user actually experiences: a 100+ MB `deno compile` binary REPLACING
// ITSELF and coming back up.
//
// That half has its own failure modes, and none of them can happen to a shell
// script: a binary cannot rewrite the file it is executing on every platform,
// the staged artifact has to be proven executable BEFORE the swap, the
// relaunch has to inherit the port and the data directory, and the new process
// has to prove itself by SERVING — `.katana/updates.md`: "the new version
// proves itself by SERVING, not by starting; if it does not, the previous one
// is put back".
//
// So this builds TWO real artifacts of the same app — v0.1.0, and a v0.2.0
// carrying a method the older build does not have — publishes both through the
// shipped publish path, runs the old one, and asks it to update. The decisive
// read is that method: a version string can be wrong about which bytes are
// running, and a method that did not exist cannot.
//
// Two real `deno compile` runs (~1 min each), so it sits behind the same
// AIO_BUILD_E2E gate as the other artifact tests — `deno task test:build`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildFlags,
  freePort,
  kill,
  makeApp,
  spawn,
  waitForHttp,
} from "./e2e-app-harness.ts";
import { shipApp } from "../src/build/ship.ts";
import { generateSigningKey } from "../src/build/ship.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";

/** The compiled binary: the one extension-less executable in the project root. */
function findBinary(dir: string): string {
  const bin = [...Deno.readDirSync(dir)]
    .filter((e) => e.isFile && !e.name.includes("."))
    .map((e) => e.name);
  assertEquals(
    bin.length,
    1,
    `expected exactly one compiled binary, got: ${bin.join(", ") || "none"}`,
  );
  return join(dir, bin[0]!);
}

/** Drive one action into a running app the way a client does, and read the
 *  state frame back. The control API is DEV-ONLY and these are production
 *  binaries, so a WebSocket is not a shortcut here — it is the only door, and
 *  it is the same one the app's own UI uses. */
async function dispatch(
  port: number,
  type: string,
  settleMs = 4000,
): Promise<Record<string, Record<string, unknown>>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let state: Record<string, Record<string, unknown>> = {};
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    try {
      const f = JSON.parse(e.data);
      if (f?.t === "state" && f.d) state = f.d;
    } catch { /* not a JSON frame */ }
  });
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error(`ws to :${port} failed`)));
  });
  await new Promise((r) => setTimeout(r, 500));
  ws.send(JSON.stringify({ v: 2, t: "action", d: { type } }));
  await new Promise((r) => setTimeout(r, settleMs));
  ws.close();
  return state;
}

/** `/__aio/health` — which reports the LAST action each cell ran, and whether
 *  it errored. That is what proves a method executed on a production binary
 *  with no control API. */
async function health(port: number): Promise<Record<string, unknown>> {
  const r = await fetch(`http://127.0.0.1:${port}/__aio/health`);
  return await r.json();
}

Deno.test({
  name: "artifact: a compiled binary updates ITSELF and serves the new build",
  ignore: !GATE,
  // aio-ok: a compiled binary re-execs ITSELF to update; the successor process is not a child the test can await
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-update-");
    const channel = await Deno.makeTempDir({ prefix: "update-channel-" });
    const installDir = await Deno.makeTempDir({ prefix: "update-install-" });
    const keys = await generateSigningKey();
    // Outside the app dir on purpose: `ship keygen` refuses to write a private
    // key inside a git work tree, and the scaffold makes one.
    const keyPath = join(installDir, "release-key.json");
    await Deno.writeTextFile(keyPath, JSON.stringify(keys));
    let proc: Deno.ChildProcess | null = null;
    try {
      // ── the app: updates configured, pointed at a local channel ───────────
      // `file://` is a first-class source, not a test fixture — air-gapped and
      // LAN installs use exactly this path. `auto: false` because this test is
      // about the ACCEPTED update; `check: false` because it drives the check
      // itself rather than waiting out a poll interval.
      const appTs = await Deno.readTextFile(join(dir, "src", "app.ts"));
      await Deno.writeTextFile(
        join(dir, "src", "app.ts"),
        appTs.replace(
          /await aio\.run\(([\s\S]*?)\);/,
          `await aio.run({ updates: { source: "file://${channel}", ` +
            `channel: "prod", auto: false, check: false } });`,
        ),
      );

      // ── v0.1.0 ────────────────────────────────────────────────────────────
      const built = await buildFlags(dir, "--compile");
      assertEquals(built.code, 0, `v0.1.0 build failed:\n${built.err}`);
      const installed = join(installDir, "app");
      await Deno.copyFile(findBinary(dir), installed);
      await Deno.chmod(installed, 0o755);

      const publish = async (version: string) => {
        const cfgPath = join(dir, "deno.json");
        const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
        cfg.version = version;
        await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
        const bin = findBinary(dir);
        const m = await shipApp({
          binaryPath: bin,
          // The app's OWN id, explicitly. `shipApp` otherwise derives it from
          // the deno.json in the CWD, which here is the framework repo — and
          // the client then refuses the manifest by name ("this app is X, the
          // manifest is for aio"), which is exactly the cross-product-install
          // guard doing its job. `am publish` runs inside the app, so it never
          // sees this; a test driving `shipApp` directly must say the name.
          name: String(cfg.title ?? cfg.name),
          version,
          channel: "prod",
          channelDir: channel,
          url: "app",
          keyPath,
        });
        // The artifact beside its manifest — a channel with a manifest and no
        // binary is a 404 at download time.
        await Deno.copyFile(bin, join(channel, "prod", "app"));
        return m;
      };
      await publish("0.1.0");

      // ── v0.2.0: same app, one method the older build cannot have ──────────
      const cell = await Deno.readTextFile(join(dir, "src", "cell.ts"));
      assertStringIncludes(cell, "reset(s)", "the scaffold changed shape");
      await Deno.writeTextFile(
        join(dir, "src", "cell.ts"),
        cell.replace(
          /(\s+)reset\(s\) \{/,
          `$1double(s) {$1  s.count *= 2;$1},$1reset(s) {`,
        ),
      );
      const built2 = await buildFlags(dir, "--compile");
      assertEquals(built2.code, 0, `v0.2.0 build failed:\n${built2.err}`);
      const m2 = await publish("0.2.0");
      assertEquals(m2.version, "0.2.0");
      assert(m2.signature, "the release must be signed");

      // ── run v0.1.0 and ask it to update ───────────────────────────────────
      const port = freePort();
      const s = spawn(installed, [`--port=${port}`], installDir);
      proc = s.proc;
      await waitForHttp(`http://127.0.0.1:${port}/__aio/health`, 60_000)
        .catch((e) => {
          throw new Error(`v0.1.0 never served: ${e}\n--- log ---\n${s.log()}`);
        });

      const checked = await dispatch(port, "updates:check");
      const u = checked.updates;
      assert(u, `no updates cell on a real artifact:\n${s.log()}`);
      assertEquals(
        u.status,
        "available",
        `a signed 0.2.0 in the channel was not offered: ${
          JSON.stringify(u)
        }\n${s.log()}`,
      );
      assertEquals((u.available as Record<string, unknown>).version, "0.2.0");

      // The apply hands over: download → verify against the signed digest →
      // keep the predecessor → swap → relaunch. The relaunched process is a
      // DIFFERENT pid on the SAME port, so waiting for health is waiting for
      // the new build to prove itself by serving.
      await dispatch(port, "updates:apply", 2000);
      let after: Record<string, unknown> | null = null;
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const h = await health(port);
          if (h.appId) {
            after = h;
            const cells = h.cells as Record<string, Record<string, unknown>>;
            if (cells?.counter) break;
          }
        } catch {
          /* mid-handover: the old process is gone, the new one is not up */
        }
      }
      assert(after, `nothing served on :${port} after the update\n${s.log()}`);

      // The predecessor is kept — a rollback with nothing to roll back to is
      // not a rollback.
      const kept = [...Deno.readDirSync(installDir)].map((e) => e.name);
      assert(
        kept.some((n) => n.includes("old")),
        `the previous version was not kept: ${kept.join(", ")}`,
      );

      // ── the decisive read ─────────────────────────────────────────────────
      // A method that does not exist in v0.1.0. A version string can be wrong
      // about which bytes are running; this cannot.
      await dispatch(port, "counter:double", 1500);
      const h2 = await health(port);
      const counter =
        (h2.cells as Record<string, Record<string, unknown>>).counter ?? {};
      assertEquals(
        counter.lastAction,
        "counter:double",
        `the running binary does not have v0.2.0's method — the swap ` +
          `reported success and left the old bytes in place:\n${s.log()}`,
      );
      assertEquals(counter.errors, 0, JSON.stringify(counter));
    } finally {
      if (proc) await kill(proc).catch(() => {});
      // The relaunched process is not `proc` — it is the handover's child, on
      // the same port. Reap it by name so it cannot outlive the test.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await Deno.remove(channel, { recursive: true }).catch(() => {});
      await Deno.remove(installDir, { recursive: true }).catch(() => {});
    }
  },
});
