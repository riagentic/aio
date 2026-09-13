// builtin-cells-per-app.test.ts — `updates:` and `feedback:` on TWO apps in one
// process: both boot, and each app's cell is wired to its OWN runtime.
//
// The two framework cells were process-wide singletons reading one
// process-wide runtime. A cell def binds to exactly one app (D2), so the second
// `aio.run({ updates })` or `aio.run({ feedback: true })` in a process refused
// to boot: "[updates] already bound — … use a factory", a factory the app
// cannot write for a cell aio owns. And the boot's scheduled check, the
// progress reports and the feedback refresh all went to the one singleton, so
// even a second cell would have shown the FIRST app's updates.
//
// A child process, because the part that wires a runtime (`startUpdates`,
// `startFeedback`) is off under `libraryMode`, which every in-process harness
// sets.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test({
  name:
    "builtin cells: two apps in one process each get their own updates + feedback",
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "aio-builtin-per-app-" });
    const [pa, pb] = [freePort(), freePort()];
    await Deno.writeTextFile(
      join(root, "two.ts"),
      `
import { aio, cell } from "${ROOT}mod.ts";
const mk = () => cell("c", { state: { n: 0 }, methods: { inc(s: { n: number }) { s.n++; } } });
const boot = (id: string, port: number, channel: string) =>
  aio.run({
    appId: id,
    cells: [mk()],
    client: "server-only",
    persist: false,
    port,
    baseDir: "${root}/" + id,
    feedback: { auto: false },
    updates: { source: "file://${root}/rel-" + id, channel, check: false },
  });
const a = await boot("twoa", ${pa}, "alpha");
const b = await boot("twob", ${pb}, "beta");
console.log("BOOTED", Object.keys(a.getState()).sort().join(","), Object.keys(b.getState()).sort().join(","));
await new Promise((r) => setTimeout(r, 60_000));
`,
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "-c", `${ROOT}deno.json`, join(root, "two.ts")],
      cwd: root,
      env: { AIO_APPS_DIR: join(root, "apps"), NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let out = "";
    const pump = async (s: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const c of s) out += dec.decode(c);
    };
    const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
    const trojan = (port: number) => `http://127.0.0.1:${port}/__aio/trojan`;
    const state = async (
      port: number,
    ): Promise<{
      updates: Record<string, unknown>;
      feedback: Record<string, unknown>;
    }> => await (await fetch(`${trojan(port)}/state`)).json();
    const dispatch = async (port: number, type: string, args: unknown[] = []) =>
      await (await fetch(`${trojan(port)}/dispatch`, {
        method: "POST",
        headers: { "X-AIO": "1" },
        body: JSON.stringify({ type, payload: { args } }),
      })).text();
    try {
      for (let i = 0; i < 300 && !out.includes("BOOTED"); i++) {
        if (/already bound|error:/i.test(out)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assertStringIncludes(
        out,
        "BOOTED c,feedback,updates c,feedback,updates",
        out,
      );

      // Each app's cell shows ITS configuration (published from its runtime).
      type Cells = {
        updates: Record<string, unknown>;
        feedback: Record<string, unknown>;
      };
      let a = {} as Cells;
      let b = {} as Cells;
      for (let i = 0; i < 100; i++) {
        [a, b] = [await state(pa), await state(pb)];
        if (a.updates?.channel && b.updates?.channel) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals([a.updates.channel, b.updates.channel], ["alpha", "beta"]);
      assertEquals([a.updates.enabled, b.updates.enabled], [true, true]);

      // A check through app B's cell asks app B's source, not app A's.
      await dispatch(pb, "updates:check");
      for (let i = 0; i < 100; i++) {
        b = await state(pb);
        if (b.updates.status !== "checking" && b.updates.lastChecked) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assertStringIncludes(String(b.updates.error), "rel-twob");
      assert(!String(b.updates.error).includes("rel-twoa"));
      assertEquals((await state(pa)).updates.lastChecked, null);

      // Feedback: app B's report lands in app B's data, through B's runtime.
      await dispatch(pb, "feedback:report", ["b is broken"]);
      for (let i = 0; i < 100; i++) {
        b = await state(pb);
        if (b.feedback.status === "saved" || b.feedback.status === "error") {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals(b.feedback.status, "saved", JSON.stringify(b.feedback));
      assertStringIncludes(
        String((b.feedback.last as { path: string }).path),
        "twob",
      );
      assertEquals((await state(pa)).feedback.last, null);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
      await child.status;
      await pumps;
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});
