// A save re-validates the import graph from the watcher's debounce timer, and
// nothing told `close()` that walk existed. Closing the dev server while it
// was under way stopped esbuild beneath it; the walk's next transpile started
// the service again, after the last thing that would ever stop it — an
// orphaned native child, and a reload line printed by a server that had
// already closed. The walk is now esbuild work `close()` waits for, and a
// watcher that has been shut down transpiles nothing further.
//
// A real server and real saves; the sanitizers are the oracle — an esbuild
// child alive when the test returns, or its pending wait, fails it.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { createFileWatcher } from "../src/server/server-watcher.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import {
  normPath,
  stopEsbuild,
  transpile,
  transpileCache,
} from "../src/server/server-transpile.ts";

/** Enough modules that the walk is still under way when `close()` is called
 *  at its first transpile. */
const MODULES = 400;

Deno.test({
  name: "close mid-revalidation: no esbuild child outlives the server",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const { aio, cell } = await import("../mod.ts");
    const c = cell("wcmv", { state: { n: 0 }, methods: {} });
    const dir = await tempDir("aio-close-mid-validation-");
    const entry = join(dir, "App.tsx");
    await Deno.writeTextFile(
      entry,
      "export default function App() { return <main>hi</main>; }\n",
    );
    // The boot lines are not this test's subject.
    const orig = { ...console };
    for (const k of ["log", "info", "warn", "error", "debug"] as const) {
      console[k] = () => {};
    }
    try {
      const app = await aio.run({
        cells: [c],
        appId: "test-close-mid-validation",
        client: "browser",
        persist: false,
        libraryMode: true,
        port: freePort(),
        baseDir: dir,
      });
      let closed = false;
      try {
        // The save: a root component that now imports MODULES new files.
        const names = Array.from({ length: MODULES }, (_, i) => `m${i}`);
        for (const n of names) {
          await Deno.writeTextFile(
            join(dir, `${n}.ts`),
            `export const ${n}: number = ${n.slice(1)};\n`,
          );
        }
        await Deno.writeTextFile(
          entry,
          names.map((n) => `import { ${n} } from "./${n}.ts";\n`).join("") +
            `export default function App() { return <main>{${
              names.join(" + ")
            }}</main>; }\n`,
        );
        // Under way: the walk has transpiled its first new module.
        const first = normPath(join(dir, "m0.ts"));
        const last = normPath(join(dir, `m${MODULES - 1}.ts`));
        const t0 = Date.now();
        while (!transpileCache.has(first)) {
          assert(
            Date.now() - t0 < 30_000,
            "the watcher never re-validated the saved graph",
          );
          await new Promise((r) => setTimeout(r, 1));
        }
        assert(
          !transpileCache.has(last),
          "the walk had finished before close() — nothing was in flight",
        );
        await app.close();
        closed = true;
        assert(
          !transpileCache.has(last),
          "close() stops the walk rather than paying for the rest of it",
        );
      } finally {
        if (!closed) await app.close();
      }
    } finally {
      Object.assign(console, orig);
      await dropTempDir(dir);
    }
  },
});

// The same close, landing one step later: the walk's last transpile is done
// and the prod-bundle judge — esbuild work of its own — has not started its
// build yet. No transpile is in flight at that moment, so only the WALK being
// declared as work makes the stop wait; without it esbuild is stopped first
// and the judge's build starts the service again, with nobody left to stop it.
Deno.test({
  name:
    "shutdown mid-revalidation: esbuild work still to come is waited for, and nothing is broadcast",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const dir = await tempDir("aio-shutdown-mid-validation-");
    const entry = join(dir, "App.tsx");
    await Deno.writeTextFile(entry, "export default () => <div>hi</div>;\n");
    const judging = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    const sent: string[] = [];
    const reloads: string[] = [];
    const tag = `v${crypto.randomUUID().replaceAll("-", "")}`;
    const watcher = createFileWatcher({
      absBaseDir: dir,
      importMapObj: {},
      debug: () => {},
      broadcastWs: (m) => sent.push(m),
      onReload: (signal) => reloads.push(signal),
      // Far past the test: the graph check, not its timeout, decides.
      graphTimeoutMs: 60_000,
      // The judge, standing in: it uses esbuild AFTER the walk has finished.
      prodGraph: async () => {
        judging.resolve();
        await go.promise;
        await transpile(`export const ${tag}: number = 1;\n`, `/${tag}.ts`);
        return { errors: [], ms: 0, cached: false };
      },
    });
    try {
      watcher.scheduleReload(entry);
      await judging.promise;
      watcher.shutdown();
      const stopped = stopEsbuild();
      go.resolve();
      await stopped;
      assert(
        transpileCache.has(normPath(`/${tag}.ts`)),
        "the stop waited for the judge's esbuild work",
      );
      assertEquals(sent, [], "a watcher that was shut down broadcasts nothing");
      assertEquals(reloads, [], "…and reports no reload");
    } finally {
      // No second stop here: ONE stop being enough is the claim under test,
      // and a second would end the very service the sanitizer must find.
      watcher.shutdown();
      await dropTempDir(dir);
    }
  },
});

/** One turn of the event loop — a turn, not a duration. */
const turn = () => new Promise<void>((r) => setTimeout(r, 0));

// The OTHER walk a save starts: "is this module in the server entry's import
// graph?" — and if it is, the app restarts. Shut down while that walk is
// under way, the watcher must restart nothing, and the walk is esbuild work
// the stop waits for (here it is held between two transpiles, so no single
// transpile is in flight when the stop is asked).
Deno.test({
  name:
    "shutdown mid server-graph walk: the walk is waited for, and a closed server restarts nothing",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const dir = await tempDir("aio-shutdown-server-walk-");
    const entry = join(dir, "app.ts");
    const helper = join(dir, "helper.ts");
    await Deno.writeTextFile(helper, "export const h: number = 1;\n");
    await Deno.writeTextFile(
      entry,
      'import { h } from "./helper.ts";\nexport const x: number = h;\n',
    );
    const atHelper = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    const restarts: string[] = [];
    const watcher = createFileWatcher({
      absBaseDir: dir,
      importMapObj: {},
      debug: () => {},
      broadcastWs: () => {},
      serverEntry: entry,
      onCellChange: (path) => restarts.push(path),
      // Hold the walk at the changed module, before its transpile starts.
      transpile: async (src, f) => {
        if (f.endsWith("helper.ts")) {
          atHelper.resolve();
          await go.promise;
        }
        return await transpile(src, f);
      },
    });
    try {
      watcher.scheduleReload(helper);
      await atHelper.promise; // the entry is transpiled: a service is running
      watcher.shutdown();
      const stopped = stopEsbuild();
      go.resolve();
      await stopped;
      await turn();
      assert(
        transpileCache.has(normPath(helper)),
        "the stop waited for the walk to finish",
      );
      assertEquals(restarts, [], "a watcher that was shut down restarted");
    } finally {
      // No second stop: one being enough is the claim (see above).
      watcher.shutdown();
      await dropTempDir(dir);
    }
  },
});

// The CSS step is the last thing a reload run waits for, and the one place
// the shutdown check used to be missing: a watcher shut down while the step
// ran still broadcast, reloaded and printed `reloaded …`. With a root
// component the run reaches the step through the graph walk; without one it
// skips the walk — and skipped the only check with it.
for (const root of [true, false]) {
  Deno.test({
    name: `shutdown during the CSS step (${
      root ? "with" : "without"
    } a root component): nothing is sent, reloaded or said`,
    sanitizeOps: true,
    sanitizeResources: true,
    fn: async () => {
      const dir = await tempDir("aio-shutdown-css-step-");
      const entry = join(dir, "App.tsx");
      const css = join(dir, "style.css");
      if (root) {
        await Deno.writeTextFile(
          entry,
          "export default () => <div>hi</div>;\n",
        );
      }
      await Deno.writeTextFile(css, "main { color: red; }\n");
      const running = Promise.withResolvers<void>();
      const go = Promise.withResolvers<void>();
      const sent: string[] = [];
      const reloads: string[] = [];
      const said: string[] = [];
      const prev = getLogger();
      setLogger({
        logDir: "",
        pub: (_level: string, cat: string, msg: string) => {
          if (cat === "watch" || cat === "graph") said.push(msg);
        },
        perf: () => {},
        flush: () => Promise.resolve(),
        // deno-lint-ignore no-explicit-any
      } as any);
      const watcher = createFileWatcher({
        absBaseDir: dir,
        importMapObj: {},
        // A run ended by the shutdown is not an "unexpected error".
        debug: (m) => void (m.includes("unexpected error") && said.push(m)),
        broadcastWs: (m) => sent.push(m),
        onReload: (signal) => reloads.push(signal),
        graphTimeoutMs: 60_000,
        runCss: async () => {
          running.resolve();
          await go.promise;
          return [];
        },
      });
      try {
        watcher.scheduleReload(root ? entry : css);
        await running.promise;
        watcher.shutdown();
        go.resolve();
        await watcher.cssSettled();
        await turn();
        assertEquals(sent, [], "a watcher that was shut down broadcast");
        assertEquals(reloads, [], "…reported a reload");
        assertEquals(said, [], "…printed a line");
      } finally {
        setLogger(prev);
        watcher.shutdown();
        await stopEsbuild(); // the root's walk transpiled it
        await dropTempDir(dir);
      }
    },
  });
}

Deno.test({
  name: "cssSettled: resolves only once the CSS step in flight has ended",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const dir = await tempDir("aio-css-settled-");
    const css = join(dir, "style.css");
    await Deno.writeTextFile(css, "main { color: red; }\n");
    const running = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    const order: string[] = [];
    const failed = Promise.withResolvers<void>();
    const watcher = createFileWatcher({
      absBaseDir: dir,
      importMapObj: {},
      debug: () => {},
      broadcastWs: () => {},
      runCss: async () => {
        running.resolve();
        await go.promise;
        order.push("step ended");
        return [];
      },
    });
    try {
      await watcher.cssSettled(); // nothing in flight: at once
      watcher.scheduleReload(css);
      await running.promise;
      watcher.shutdown();
      const settled = watcher.cssSettled().then(() => order.push("settled"));
      await turn();
      assertEquals(order, [], "settled while the step was still running");
      go.resolve();
      await settled;
      assertEquals(order, ["step ended", "settled"]);
      // A step that FAILS is settled too: its failure is the run's to report,
      // not the close's to trip over.
      const failing = createFileWatcher({
        absBaseDir: dir,
        importMapObj: {},
        debug: () => {},
        broadcastWs: () => {},
        runCss: () => {
          failed.resolve();
          return Promise.reject(new Error("css step failed"));
        },
      });
      try {
        failing.scheduleReload(css);
        await failed.promise;
        await failing.cssSettled();
      } finally {
        failing.shutdown();
      }
    } finally {
      watcher.shutdown();
      await dropTempDir(dir);
    }
  },
});
