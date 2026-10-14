// The dev Worker warning is said when the Worker APPEARS, not only at boot.
//
// `unmanagedWorkers` finds a `new Worker(…)` that runs in dev and does not
// load in a build. The dev server printed it from the boot validation alone:
// a Worker added while `deno task dev` ran (the usual way one arrives) was
// revalidated on the save, found, and kept quiet until the next restart.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { startGraphValidation } from "../src/server/server-dev-checks.ts";
import {
  type GraphResult,
  validateGraph,
} from "../src/server/graph-validator.ts";
import { stopEsbuild } from "../src/server/server-transpile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { captureConsole, captureConsoleAsync } from "./console-capture.ts";

// A Worker the graph check has something to say about: its script is not
// there. (Which Workers are findings is graph-validator's to decide and to
// test; this file is about WHEN a finding is said.)
const WORKER_APP =
  `const w = new Worker(new URL("./missing.ts", import.meta.url), { type: "module" });\n` +
  `export default function App() { return null; }`;
const PLAIN_APP = `export default function App() { return null; }`;
const transpile = (s: string) => Promise.resolve(s);
const said = (lines: string[]) =>
  lines.filter((l) => l.includes("⚠") && l.includes("missing.ts")).length;
const finding = (r: GraphResult) =>
  r.errors.filter((e) => e.category === "unmanaged-worker").length;

Deno.test("dev: a Worker found by a hot-reload revalidation is warned about, once", async () => {
  const dir = await tempDir("aio-dev-worker-reload-");
  try {
    const app = join(dir, "App.tsx");
    await Deno.writeTextFile(app, PLAIN_APP);
    let handle!: ReturnType<typeof startGraphValidation>;
    const boot = await captureConsoleAsync(async () => {
      handle = startGraphValidation(dir, {}, () => {});
      await handle.done;
    });
    assertEquals(said(boot), 0, "no Worker yet");

    // What the watcher does on a save: validate again, hand over the result.
    const revalidate = async (src: string): Promise<GraphResult> => {
      await Deno.writeTextFile(app, src);
      return await validateGraph(app, {}, transpile);
    };
    const withWorker = await revalidate(WORKER_APP);
    assertEquals(finding(withWorker), 1, "the fixture is not a finding");
    assertEquals(
      said(captureConsole(() => handle.setResult(withWorker))),
      1,
      "the save that added the Worker said nothing",
    );
    // The next save of anything: the same finding is not repeated.
    assertEquals(said(captureConsole(() => handle.setResult(withWorker))), 0);
    // Fixed, then back: a new finding, said again.
    const plain = await revalidate(PLAIN_APP);
    assertEquals(said(captureConsole(() => handle.setResult(plain))), 0);
    assertEquals(said(captureConsole(() => handle.setResult(withWorker))), 1);
    handle.stop();
  } finally {
    await stopEsbuild(); // the boot validation's transpiler
    await dropTempDir(dir);
  }
});

Deno.test("dev: a Worker present at boot is warned about at boot, and not again on the first save", async () => {
  const dir = await tempDir("aio-dev-worker-boot-");
  try {
    const app = join(dir, "App.tsx");
    await Deno.writeTextFile(app, WORKER_APP);
    let handle!: ReturnType<typeof startGraphValidation>;
    const boot = await captureConsoleAsync(async () => {
      handle = startGraphValidation(dir, {}, () => {});
      await handle.done;
    });
    assertEquals(said(boot), 1);
    const again = await validateGraph(app, {}, transpile);
    assertEquals(finding(again), 1, "the fixture is not a finding");
    assertEquals(said(captureConsole(() => handle.setResult(again))), 0);
    handle.stop();
  } finally {
    await stopEsbuild(); // the boot validation's transpiler
    await dropTempDir(dir);
  }
});
