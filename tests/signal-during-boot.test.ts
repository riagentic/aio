// An app that is asked to stop WHILE IT IS STARTING stops.
//
// The SIGINT/SIGTERM handlers used to be installed near the end of boot,
// inside `setupTransport`, after the server was listening. A signal arriving
// before that point is not merely early — it is LOST:
// `Deno.addSignalListener` replaces the default disposition, and a signal that
// lands while that is being set up reaches neither the listener nor the
// default. The process then runs forever, having been asked to stop.
//
// Measured: `tests/seam-paths.test.ts` signals its child as soon as the key
// file appears and failed about one run in five, the child's log showing a
// complete boot and then nothing at all for 45 seconds. Adding a listener at
// the top of the app's own module made it pass 8 for 8 — which is what
// identified the WINDOW rather than the app.
//
// In production this is a supervisor restarting an app quickly, a container
// stopping during startup, or `am stop` straight after `am start`.
//
// This file tests the property directly instead of relying on another test's
// incidental timing: spawn a real app, signal it at a range of delays that
// straddle boot, and require it to be gone.
import { assert } from "@std/assert";

const ROOT = new URL("..", import.meta.url).pathname;

/** Spawn a real (non-libraryMode) app, SIGTERM it after `delayMs`, and report
 *  how long it took to exit. `null` means it never did. */
async function signalAfter(delayMs: number): Promise<number | null> {
  const dir = await Deno.makeTempDir({ prefix: "aio-sigboot-" });
  await Deno.mkdir(`${dir}/src`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      title: "sigboot",
      version: "0.0.1",
      unstable: ["kv"],
      imports: {
        "aio": `${ROOT}mod.ts`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@^1",
      },
    }),
  );
  await Deno.writeTextFile(
    `${dir}/src/app.ts`,
    `import { aio, cell } from "aio";
export const probe = cell("probe", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ persist: true, key: true });
`,
  );
  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-kv",
      "--no-lock",
      "src/app.ts",
      "--client=server-only",
    ],
    cwd: dir,
    env: { HOME: dir, XDG_RUNTIME_DIR: dir, AIO_APPS_DIR: dir },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // Drain so the child never blocks on a full pipe.
  const sink = async (s: ReadableStream<Uint8Array>) => {
    for await (const _ of s) { /* discarded */ }
  };
  sink(proc.stdout).catch(() => {});
  sink(proc.stderr).catch(() => {});

  await new Promise((r) => setTimeout(r, delayMs));
  const t0 = performance.now();
  try {
    proc.kill("SIGTERM");
  } catch { /* already gone: that is an exit too */ }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 20_000);
  });
  const status = await Promise.race([proc.status, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (status === null) {
    try {
      proc.kill("SIGKILL");
    } catch { /* raced */ }
    await proc.status;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    return null;
  }
  const ms = performance.now() - t0;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  return ms;
}

Deno.test({
  name: "signal: SIGTERM at any point during boot still stops the app",
  ignore: Deno.build.os === "windows",
  async fn() {
    // A spread that straddles the whole boot: before the runtime exists, while
    // it is wiring itself up, and after it is serving. The lost-signal window
    // was in the middle of that range, which is why a single delay would have
    // been a coin toss rather than a test.
    const delays = [0, 25, 50, 100, 200, 350, 500, 750, 1000, 1500];
    const never: number[] = [];
    const slow: string[] = [];
    for (const d of delays) {
      const ms = await signalAfter(d);
      if (ms === null) never.push(d);
      else if (ms > 15_000) slow.push(`${d}ms → ${ms.toFixed(0)}ms`);
    }
    assert(
      never.length === 0,
      `the app NEVER exited when signalled at ${never.join(", ")}ms into ` +
        `boot. A signal that arrives before the handler exists is lost, and ` +
        `the app runs forever having been asked to stop — see ` +
        `installProcessSignals in src/server/shutdown.ts.`,
    );
    assert(
      slow.length === 0,
      `stopped, but far too slowly: ${slow.join("; ")}`,
    );
  },
});
