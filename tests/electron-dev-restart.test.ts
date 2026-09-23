// A cell edit under `deno task dev --client=electron` must RESTART the app, not
// end it (field report cc §5).
//
// The restart's own teardown kills the Electron window. The launch-time status
// handler read that exit as "the user closed the window" and ran
// `stopProcess(0)` — in the very process that was becoming the supervisor — so
// the relaunched child found its AIO_PARENT_PID gone two seconds later and the
// dev session was over. Measured with the real binary before the fix:
//
//   watch  cell file changed (cell.ts) — restarting the app
//   aio    electron closed (code 0) — shutting down
//   app    started  cells=probe port=41371
//   WARN   parent process 347650 is gone (AIO_PARENT_PID) — shutting down
//
// Three layers: the decision (pure, runs everywhere), the flag the decision
// reads (a real process, runs everywhere), and the whole flow with a real
// Electron on the nested display (opt-in, like the other Electron e2e tests).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { electronClosedPlan } from "../src/server/aio-lifecycle.ts";
import { freePort } from "../src/testing/server-test.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { descendantPids } from "../src/server/single-instance-lock.ts";
import { stopChild } from "./stop-child.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("../", import.meta.url).pathname;

Deno.test("electron closed: a restart's own teardown stops nothing", () => {
  const ctx = { keepServer: false, restarting: true, url: "http://x/" };
  const p = electronClosedPlan({ code: 0, signal: null }, ctx);
  assertEquals(p.stop, false, "the supervisor-to-be must survive the restart");
  assertStringIncludes(p.line, "electron closed (code 0) — restarting");
  // …whatever the exit looked like — a restart is a restart.
  assertEquals(
    electronClosedPlan({ code: 143, signal: "SIGTERM" }, ctx).stop,
    false,
  );
  // keepServer does not change that answer either.
  assertEquals(
    electronClosedPlan({ code: 0, signal: null }, { ...ctx, keepServer: true })
      .stop,
    false,
  );
});

Deno.test("electron closed: outside a restart the window still owns the app", () => {
  const base = { keepServer: false, restarting: false, url: "http://x/" };
  const closed = electronClosedPlan({ code: 0, signal: null }, base);
  assertEquals(closed, {
    line: "electron closed (code 0) — shutting down",
    stop: true,
    crashed: false,
    exitCode: 0,
  });
  const killed = electronClosedPlan({ code: 137, signal: "SIGKILL" }, base);
  assertEquals(killed.stop, true);
  assertStringIncludes(killed.line, "signal SIGKILL");
  assertEquals([killed.crashed, killed.exitCode], [true, 1]);
  const kept = electronClosedPlan({ code: 0, signal: null }, {
    ...base,
    keepServer: true,
  });
  assertEquals(kept.stop, false);
  assertStringIncludes(kept.line, "server still running at http://x/");
});

Deno.test("electron closed: the launch handler asks the restart flag", async () => {
  // A source gate on the ONE wiring line: the plan above is only as good as
  // the handler actually passing the live flag into it.
  const src = await Deno.readTextFile(
    new URL("../src/server/aio-lifecycle.ts", import.meta.url),
  );
  assertStringIncludes(src, "restarting: isRestarting()");
  assert(
    !src.includes("electron closed (${how}) — shutting down`);\n"),
    "the old unconditional shutdown line is back",
  );
});

Deno.test("dev-restart: isRestarting() is already true while shutdown() runs", async () => {
  // A real process: the flag has to be up BEFORE the teardown kills Electron,
  // which is when the status handler reads it. The shutdown exits the process
  // itself, so no supervisor is ever started here.
  const probe = `
import { isRestarting, restartForCellChange } from ${
    JSON.stringify(`${REPO}src/server/dev-restart.ts`)
  };
if (isRestarting()) { console.log("EARLY"); Deno.exit(2); }
await restartForCellChange("/tmp/cell.ts", () => {
  console.log("DURING=" + isRestarting());
  Deno.exit(0);
});
console.log("RETURNED");
`;
  const env = { ...Deno.env.toObject() };
  delete env.AIO_NO_DEV_RESTART;
  delete env.AIO_DEV_SUPERVISED;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "-c", `${REPO}deno.json`, probe],
    env: { ...env, NO_COLOR: "1" },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  assertStringIncludes(
    text,
    "DURING=true",
    text + new TextDecoder().decode(out.stderr),
  );
  assertEquals(out.code, 0);
});

// ── the whole flow, real Electron on the nested display ─────────────────────

/** The real Electron binary (not the node shim), or null. */
function electronBinary(): string | null {
  const own = Deno.env.get("ELECTRON_PATH");
  const candidates = [
    ...(own ? [own] : []),
    (() => {
      try {
        const cli = Deno.realPathSync(join(REPO, "node_modules/.bin/electron"));
        return join(dirname(cli), "dist", "electron");
      } catch {
        return "";
      }
    })(),
  ];
  for (const c of candidates) {
    try {
      if (c && Deno.statSync(c).isFile) return c;
    } catch { /* next */ }
  }
  return null;
}

function e2eSkip(): string | null {
  if (Deno.build.os !== "linux") return "linux-only (nested X display)";
  if (!electronBinary()) {
    return "Electron not installed — run: deno task install:electron";
  }
  if (!Deno.env.get("ELECTRON_E2E")) {
    return "E2E disabled — set ELECTRON_E2E=1 to run";
  }
  if (!testDisplayEnv().DISPLAY) return "no nested display (install Xephyr)";
  return null;
}

const SKIP = e2eSkip();
if (SKIP) {
  console.warn(
    `[electron-dev-restart] real-Electron cell-edit e2e SKIPPED — ${SKIP}`,
  );
}

async function get(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    const t = (await res.text()).trim();
    return res.ok ? t : null;
  } catch {
    return null;
  }
}

async function until(fn: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const alive = (pid: number) => {
  try {
    Deno.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
};

Deno.test({
  name:
    "electron dev e2e: a cell edit restarts the app — supervisor, child and window all stay up",
  ignore: SKIP !== null,
  // aio-ok: a real Electron tree; its zygotes outlive the test boundary briefly
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  async fn() {
    const dir = await tempDir("aio-electron-restart-");
    const port = freePort();
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "aio",
          lib: ["deno.ns", "dom", "dom.iterable"],
        },
        imports: {
          "aio": `${REPO}mod.ts`,
          "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() { return <div><h1>restart</h1></div>; }\n",
    );
    const cell = (mark: string) =>
      `import { cell } from "aio";
export const probe = cell("probe", {
  state: { mark: "${mark}" },
  methods: { set(s: { mark: string }, m: string) { s.mark = m; } },
});
`;
    await Deno.writeTextFile(join(dir, "cell.ts"), cell("v1"));
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio } from "aio";
import { probe } from "./cell.ts";
await aio.run({
  appId: "electron-dev-restart-e2e",
  cells: [probe],
  client: "electron",
  persist: false,
  port: ${port},
  routes: { "/mark": () => new Response(probe.mark) },
});
`,
    );
    const apps = await tempDir("aio-electron-restart-home-");
    const env = { ...Deno.env.toObject() };
    for (
      const k of [
        "AIO_NO_DEV_RESTART",
        "AIO_DEV_SUPERVISED",
        "AIO_PARENT_PID",
        "AIO_PORT",
      ]
    ) {
      delete env[k];
    }
    const proc = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts")],
      cwd: dir,
      clearEnv: true,
      env: {
        ...env,
        NO_COLOR: "1",
        AIO_APPS_DIR: apps,
        ELECTRON_PATH: electronBinary()!,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        // The window is real — it goes to the nested display, never yours.
        ...testDisplayEnv(),
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let log = "";
    const dec = new TextDecoder();
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) log += dec.decode(c);
    };
    const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
    const mounts = () => log.split("ui mounted").length - 1;
    let tree: number[] = [];
    try {
      assert(
        await until(() => mounts() >= 1, 60_000),
        `the first window never mounted:\n${log}`,
      );
      assertEquals(await get(`http://127.0.0.1:${port}/mark`), "v1");
      await Deno.writeTextFile(join(dir, "cell.ts"), cell("v2"));
      assert(
        await until(
          async () => (await get(`http://127.0.0.1:${port}/mark`)) === "v2",
          30_000,
        ),
        `the relaunched app never served the new cell:\n${log}`,
      );
      assert(
        await until(() => mounts() >= 2, 30_000),
        `the relaunched app opened no window:\n${log}`,
      );
      // Past the 2 s parent watch, several times over.
      await new Promise((r) => setTimeout(r, 10_000));
      tree = await descendantPids(proc.pid).catch(() => []);
      assert(alive(proc.pid), `the supervisor died:\n${log}`);
      assertEquals(
        await get(`http://127.0.0.1:${port}/mark`),
        "v2",
        `the relaunched app is gone 10 s later:\n${log}`,
      );
      assertStringIncludes(log, "electron closed (code 0) — restarting");
      assert(!log.includes("— shutting down"), `something shut down:\n${log}`);
      assert(
        !log.includes("parent process"),
        `the child lost its parent:\n${log}`,
      );
      assert(
        !log.includes("electron closed") ||
          log.split("electron closed").length === 2,
        `the relaunched window closed:\n${log}`,
      );
    } finally {
      if (!tree.length) tree = await descendantPids(proc.pid).catch(() => []);
      await stopChild(proc, { label: "electron dev app", quiet: true });
      // The supervisor exits on SIGTERM after signalling its child; the child
      // then closes its window. Give that a moment, then nothing survives.
      await until(() => tree.every((p) => !alive(p)), 15_000);
      for (const p of tree) {
        try {
          if (alive(p)) Deno.kill(p, "SIGKILL");
        } catch { /* gone */ }
      }
      await drained.catch(() => {});
      await dropTempDir(dir);
      await dropTempDir(apps);
    }
  },
});
