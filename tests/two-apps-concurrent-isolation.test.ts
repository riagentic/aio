// two-apps-concurrent-isolation.test.ts — two (and three) apps in ONE process,
// booted the way a host really boots them: at the same time.
//
// `two-apps-one-process-singletons.test.ts` boots its apps one after the
// other. Every singleton below survived that and broke the moment two
// `aio.run()` calls overlapped, or reported one app's facts on the other's
// surfaces:
//   - `feedback`/`updates`: both boots claimed the process cell before either
//     bound it → "[feedback] already bound", exit 1; and the one-slot armed
//     `refresh()` fired the other app's cell.
//   - `budgets`: one process-wide ledger — B's 64 KB budget turned A's
//     `/health` degraded over A's own cell.
//   - feedback auto-capture: B's crash was filed in A's reports, and B's
//     `reduce-error` inside the bus's 5 s dedup window swallowed A's.
//   - `/health` uptime read the LAST boot's start time.
//   - a late app's pre-logger lines went into the first app's log files.
//
// A child process, because `startFeedback`/`startUpdates` are off under
// `libraryMode`, which every in-process harness sets.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";

const ROOT = new URL("..", import.meta.url).pathname;

type Json = Record<string, unknown>;

Deno.test({
  name:
    "two apps booted concurrently: builtin cells, budgets, auto-capture, uptime and early logs stay per app",
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "aio-two-concurrent-" });
    const [pa, pb, pc] = [freePort(), freePort(), freePort()];
    await Deno.writeTextFile(
      join(root, "two.ts"),
      `
import { aio, cell } from "${ROOT}mod.ts";
const mk = (id: string, big = 0) => cell("c", {
  state: { n: 0, big: "x".repeat(big) },
  methods: {
    inc(s: { n: number }) { s.n++; },
    boom(_s: { n: number }) { throw new Error("BOOM-FROM-" + id); },
  },
});
const boot = (id: string, port: number, extra: Record<string, unknown>) =>
  aio.run({
    appId: id,
    cells: [mk(id, id === "twoa" ? 80_000 : 0)],
    client: "server-only",
    persist: false,
    port,
    ...extra,
  } as never);
const [a, b] = await Promise.all([
  boot("twoa", ${pa}, {
    feedback: { auto: true },
    updates: { source: "file://${root}/rel-a", channel: "alpha", check: false },
  }),
  boot("twob", ${pb}, {
    feedback: { auto: true },
    updates: { source: "file://${root}/rel-b", channel: "beta", check: false },
    budgets: { cellState: "64KB" },
  }),
]);
console.log("BOOTED", Object.keys(a.getState()).sort().join(","), Object.keys(b.getState()).sort().join(","));
// A late third app, so uptime and pre-logger lines have a "last boot" to leak.
await new Promise((r) => setTimeout(r, 2200));
await boot("twoc", ${pc}, { perfBudget: { methods: { "c:nope-early-line": { maxMs: 5 } } } });
console.log("BOOTED-C");
await new Promise((r) => setTimeout(r, 120_000));
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
    const tick = () => new Promise((r) => setTimeout(r, 50));
    const waitOut = async (marker: string) => {
      for (let i = 0; i < 600 && !out.includes(marker); i++) {
        if (/already bound|top level threw/i.test(out)) break;
        await tick();
      }
    };
    const get = async (port: number, path: string): Promise<Json> =>
      await (await fetch(`http://127.0.0.1:${port}${path}`)).json();
    const state = (port: number) => get(port, "/__aio/trojan/state");
    const health = (port: number) => get(port, "/__aio/health");
    const dispatch = async (port: number, type: string) =>
      await (await fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
        method: "POST",
        headers: { "X-AIO": "1" },
        body: JSON.stringify({ type, payload: { args: [] } }),
      })).text();
    const reports = async (appId: string): Promise<string> => {
      let all = "";
      try {
        const dir = join(root, "apps", appId, "data", "reports");
        for await (const e of Deno.readDir(dir)) {
          all += await Deno.readTextFile(join(dir, e.name));
        }
      } catch { /* no reports yet */ }
      return all;
    };
    const readLog = (appId: string, f: string) =>
      Deno.readTextFile(join(root, "apps", appId, "logs", f)).catch(() => "");
    try {
      await waitOut("BOOTED");
      // ── 1. both concurrent boots come up, each with its own builtin cells ──
      assertStringIncludes(
        out,
        "BOOTED c,feedback,updates c,feedback,updates",
        `a concurrent boot with feedback/updates must not refuse:\n${out}`,
      );
      assert(!/already bound/.test(out), out);
      let a: Json = {}, b: Json = {};
      for (let i = 0; i < 100; i++) {
        [a, b] = [await state(pa), await state(pb)];
        const fa = a.feedback as Json, fb = b.feedback as Json;
        const ua = a.updates as Json, ub = b.updates as Json;
        if (fa?.enabled && fb?.enabled && ua?.enabled && ub?.enabled) break;
        await tick();
      }
      // The boot-time refresh()/ready() was ONE armed slot: the second boot
      // overwrote the first's, so one app's `enabled` stayed false forever.
      assertEquals(
        [(a.feedback as Json).enabled, (b.feedback as Json).enabled],
        [true, true],
        "each app's boot refresh reaches its own feedback cell",
      );
      assertEquals(
        [(a.updates as Json).channel, (b.updates as Json).channel],
        ["alpha", "beta"],
      );
      assertEquals(
        [(a.updates as Json).enabled, (b.updates as Json).enabled],
        [true, true],
      );

      // ── 2. budgets are the declaring app's own ──
      const ha = await health(pa);
      const hb = await health(pb);
      assertEquals(
        ha.budgets,
        undefined,
        `A declared no budgets — B's must not appear on A: ${
          JSON.stringify(ha)
        }`,
      );
      assertEquals(ha.status, "healthy", JSON.stringify(ha));
      assertEquals(
        (hb.budgets as Json)?.ok,
        true,
        `B's small cells are inside B's budget; A's 80 KB cell is not B's: ${
          JSON.stringify(hb)
        }`,
      );

      // ── 4 + 7b. auto-capture files each app's crash in its own reports ──
      await dispatch(pb, "c:boom");
      // A's same-type failure INSIDE the bus's dedup window.
      await dispatch(pa, "c:boom");
      for (let i = 0; i < 100; i++) {
        if (
          (await reports("twob")).includes("BOOM-FROM-twob") &&
          (await reports("twoa")).includes("BOOM-FROM-twoa")
        ) break;
        await tick();
      }
      const ra = await reports("twoa");
      const rb = await reports("twob");
      assertStringIncludes(rb, "BOOM-FROM-twob", "B's crash is in B's reports");
      assert(
        !ra.includes("BOOM-FROM-twob"),
        "B's crash must not be filed in A's reports",
      );
      assertStringIncludes(
        ra,
        "BOOM-FROM-twoa",
        "B's reduce-error must not dedup A's out of A's auto-capture",
      );
      assert(!rb.includes("BOOM-FROM-twoa"), "…nor A's into B's");

      // ── 7a. uptime is each app's own ──
      await waitOut("BOOTED-C");
      assertStringIncludes(out, "BOOTED-C", out);
      const upA = (await health(pa)).uptime as number;
      assert(
        upA >= 2,
        `A has been up >2s; a later boot must not reset A's uptime (got ${upA})`,
      );

      // ── 5. a late app's pre-logger lines stay out of the running apps' files
      assertStringIncludes(out, "nope-early-line", "said on the console");
      for (const id of ["twoa", "twob"]) {
        for (const f of ["app.log", "debug.log", "warning.log"]) {
          assert(
            !(await readLog(id, f)).includes("nope-early-line"),
            `C's boot line must not land in ${id}/logs/${f}`,
          );
        }
      }
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
