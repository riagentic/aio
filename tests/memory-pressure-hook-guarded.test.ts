// `memory.onMemoryPressure` is a hook like any other: observe-only and
// error-guarded. It runs on the monitor's timer, so a throw (or a rejection)
// used to escape as an uncaughtException and take the whole app down — on the
// one occasion it was being warned about memory.
import { assert, assertEquals } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

for (const kind of ["throws", "rejects"] as const) {
  Deno.test(`memory: an onMemoryPressure hook that ${kind} never breaks the app`, async () => {
    const dir = await tempDir("aio-mem-hook-");
    let calls = 0;
    try {
      const c = cell("memhook", {
        state: { n: 0 },
        methods: {
          inc(s: { n: number }) {
            s.n++;
          },
        },
      });
      _resetAioRuntime();
      const app = await aio.run({
        cells: [c],
        appId: "memhook",
        dbPath: `${dir}/data.db`,
        libraryMode: true,
        client: "server-only",
        baseDir: dir,
        logging: false,
        memory: {
          interval: 50,
          warnThreshold: 1e-9, // every tick reports
          criticalThreshold: 0.999,
          onMemoryPressure: () => {
            calls++;
            if (kind === "throws") throw new Error("hook boom");
            return Promise.reject(new Error("hook boom"));
          },
        },
      } as Any);
      const deadline = Date.now() + 5_000;
      while (calls < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert(
        calls >= 2,
        `the hook ran ${calls} time(s) — it must keep running`,
      );
      await (c as Any).inc();
      assertEquals((app.getState() as Any).memhook.n, 1);
      await app.close();
    } finally {
      _resetAioRuntime();
      await dropTempDir(dir);
    }
  });
}

// An unchanged pressure is SAID once: the log and `onError` had the same
// MEMORY_PRESSURE every interval for as long as the app sat over its warn
// threshold. The hook above is not what is said — it still runs each time.
Deno.test("memory: steady pressure reaches onError once, and onMemoryPressure every interval", async () => {
  const dir = await tempDir("aio-mem-said-");
  let calls = 0;
  const errors: string[] = [];
  try {
    const c = cell("memsaid", { state: { n: 0 }, methods: {} });
    _resetAioRuntime();
    const app = await aio.run({
      cells: [c],
      appId: "memsaid",
      dbPath: `${dir}/data.db`,
      libraryMode: true,
      client: "server-only",
      baseDir: dir,
      logging: false,
      onError: (e: { code: string }) => errors.push(e.code),
      memory: {
        interval: 50,
        warnThreshold: 1e-9, // every tick is over it
        criticalThreshold: 0.999,
        onMemoryPressure: () => {
          calls++;
        },
      },
    } as Any);
    const deadline = Date.now() + 5_000;
    while (calls < 4 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(calls >= 4, `the hook ran ${calls} time(s)`);
    assertEquals(errors.filter((e) => e === "MEMORY_PRESSURE"), [
      "MEMORY_PRESSURE",
    ]);
    await app.close();
  } finally {
    _resetAioRuntime();
    await dropTempDir(dir);
  }
});
