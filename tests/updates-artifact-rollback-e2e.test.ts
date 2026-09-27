// The rollback half of the update loop, on a REAL compiled aio binary.
//
// `tests/updates-artifact-e2e.test.ts` proves a compiled binary replaces
// itself with a build that WORKS. This is the other promise of
// `.katana/updates.md`: "the new version proves itself by SERVING, not by
// starting; if it does not, the previous one is put back". Every other
// rollback test drives stand-in artifacts; none had a real `deno compile`
// binary fail to come up and a real one come back.
//
// v0.2.0 passes every pre-swap gate (signed, digest, `--version` smoke test)
// and then cannot serve on THIS install: its migration throws on the data
// v0.1.0 wrote — the canonical update that works on the developer's empty
// store and not on a user's. The test plays the supervisor (restart on exit)
// and asserts v0.1.0 is back, serving the data it had, without v0.2.0's method.
//
// Two real `deno compile` runs, so it sits behind AIO_BUILD_E2E like the other
// artifact tests — `deno task test:build`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildFlags,
  freePort,
  kill,
  makeApp,
  placedBinary,
  spawn,
} from "./e2e-app-harness.ts";
import { generateSigningKey, shipApp } from "../src/build/ship.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";

/** One action over the app's own WebSocket (production binaries have no
 *  control API); the last state frame comes back. */
async function dispatch(
  port: number,
  type: string,
  settleMs = 1500,
): Promise<Record<string, Record<string, unknown>>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let state: Record<string, Record<string, unknown>> = {};
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    try {
      const f = JSON.parse(e.data);
      if (f?.t === "state" && f.d) state = f.d;
    } catch { /* aio-ok: not a JSON frame */ }
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

async function health(port: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/health`);
    return r.ok ? await r.json() : (await r.body?.cancel(), null);
  } catch {
    return null; // aio-ok: nothing listening — the question being asked
  }
}

/** Serving within `ms`, or null. Stops early once `exited` settles. */
async function servedWithin(
  port: number,
  ms: number,
  exited?: Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  let done = false;
  exited?.then(() => done = true);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const h = await health(port);
    if (h?.appId) return h;
    if (done) return await health(port);
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

Deno.test({
  name:
    "artifact: a compiled update that cannot serve on this install is rolled back to the build that did",
  ignore: !GATE,
  // aio-ok: the handover's successor is not a child the test can await
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-rollback-");
    const channel = await tempDir("rollback-channel-");
    const installDir = await tempDir("rollback-install-");
    const keyPath = join(installDir, "release-key.json");
    await Deno.writeTextFile(
      keyPath,
      JSON.stringify(await generateSigningKey()),
    );
    const procs: Deno.ChildProcess[] = [];
    const logs: (() => string)[] = [];
    const allLogs = () =>
      logs.map((l, i) => `--- run ${i} ---\n${l()}`).join("\n");
    try {
      const appTs = await Deno.readTextFile(join(dir, "src", "app.ts"));
      await Deno.writeTextFile(
        join(dir, "src", "app.ts"),
        appTs.replace(
          /await aio\.run\(([\s\S]*?)\);/,
          `await aio.run({ updates: { source: "file://${channel}", ` +
            `channel: "prod", auto: false, check: false } });`,
        ),
      );
      const built = await buildFlags(dir, "--compile");
      assertEquals(built.code, 0, `v0.1.0 build failed:\n${built.err}`);
      const installed = join(installDir, "app");
      await Deno.copyFile(placedBinary(dir), installed);
      await Deno.chmod(installed, 0o755);

      const publish = async (version: string) => {
        const cfgPath = join(dir, "deno.json");
        const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
        cfg.version = version;
        await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
        const bin = placedBinary(dir);
        await shipApp({
          binaryPath: bin,
          name: String(cfg.title ?? cfg.name),
          version,
          channel: "prod",
          channelDir: channel,
          url: "app",
          keyPath,
        });
        await Deno.copyFile(bin, join(channel, "prod", "app"));
      };
      await publish("0.1.0");

      // ── v0.2.0: a new method, and a migration this install's data breaks ──
      const cell = await Deno.readTextFile(join(dir, "src", "cell.ts"));
      assertStringIncludes(cell, "reset(s)", "the scaffold changed shape");
      await Deno.writeTextFile(
        join(dir, "src", "cell.ts"),
        cell
          .replace(
            `state: { count: 0 },`,
            `state: { count: 0 },\n  version: 2,\n  onMigrate() {\n` +
              `    throw new Error("v0.2.0 cannot read this install's data");\n` +
              `  },`,
          )
          .replace(
            /(\s+)reset\(s\) \{/,
            `$1double(s) {$1  s.count *= 2;$1},$1reset(s) {`,
          ),
      );
      const built2 = await buildFlags(dir, "--compile");
      assertEquals(built2.code, 0, `v0.2.0 build failed:\n${built2.err}`);
      await publish("0.2.0");

      // ── v0.1.0 runs, writes data, and installs v0.2.0 ─────────────────────
      const port = freePort();
      const run = () => {
        const s = spawn(installed, [`--port=${port}`], installDir);
        procs.push(s.proc);
        logs.push(s.log);
        return s.proc;
      };
      const v1 = run();
      assert(
        await servedWithin(port, 60_000, v1.status),
        `v0.1.0 never served\n${allLogs()}`,
      );
      await dispatch(port, "counter:increment");
      const checked = await dispatch(port, "updates:check", 4000);
      assertEquals(
        checked.updates?.status,
        "available",
        `0.2.0 was not offered: ${
          JSON.stringify(checked.updates)
        }\n${allLogs()}`,
      );
      await dispatch(port, "updates:apply", 2000);
      await v1.status;

      // ── the supervisor: restart on exit, until something serves ───────────
      // The handover's own successor is boot 1 of v0.2.0; it is not our child,
      // so it is given time to come up (it cannot) before the first restart.
      let served = await servedWithin(port, 30_000);
      let restarts = 0;
      while (!served && restarts < 6) {
        restarts++;
        const p = run();
        served = await servedWithin(port, 60_000, p.status);
      }
      assert(
        served,
        `nothing served after ${restarts} restarts — the failed update was ` +
          `never rolled back\n${allLogs()}`,
      );
      assertStringIncludes(allLogs(), "rolling back to 0.1.0");

      // ── the decisive reads: v0.1.0's bytes, with v0.1.0's data ────────────
      const after = await dispatch(port, "counter:double");
      assertEquals(
        after.counter?.count,
        1,
        `the data v0.1.0 wrote did not survive the rollback: ${
          JSON.stringify(after.counter)
        }\n${allLogs()}`,
      );
      const h = await health(port);
      const counter =
        (h?.cells as Record<string, Record<string, unknown>>)?.counter ?? {};
      assert(
        counter.lastAction !== "counter:double",
        `v0.2.0's method ran — the failed build is still installed\n${allLogs()}`,
      );
    } finally {
      for (const p of procs) await kill(p).catch(() => {});
      // The handover's successor is not in `procs`; stop whatever still
      // serves on the install (AIO_PARENT_PID ends it with this process too).
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await dropTempDir(channel);
      await dropTempDir(installDir);
    }
  },
});
