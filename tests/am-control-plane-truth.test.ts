// am — the control plane must tell a SCRIPT the truth.
//
// `am` is scripted against (docs/clients/app-manager.md's "For AI agents"
// section is literally `am … && echo up || echo down`), so three things are
// load-bearing and were not checked anywhere:
//
//   1. every failure exits NON-ZERO. A command that prints an error and
//      `return`s exits 0, which is a green light for the next line of the
//      script — the doctrine's silent failure with a stack trace attached.
//   2. a 200 response is not a success. `am trigger`'s reply carries its OWN
//      `ok` flag (the element may not exist on the live surface); the HTTP
//      status is 200 either way.
//   3. `--json` means JSON on stdout, on the success path AND the miss path.
//
// Each test below fails on the pre-fix tree.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdLog, cmdTrigger } from "../src/am/am-cmd-inspect.ts";
import { cmdAdd } from "../src/am/am-cmd-meta.ts";
import { cmdCreate } from "../src/am/am-cmd-create.ts";
import { appDirs, registerAppDirs } from "../src/server/app-dirs.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

// ── harness ──────────────────────────────────────────────────

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/** Run `fn` with Deno.exit stubbed; returns the exit code, or null if the
 *  command returned normally (i.e. claimed success). */
async function exitCodeOf(fn: () => Promise<void>): Promise<number | null> {
  const real = Deno.exit;
  let code: number | null = null;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    code = e.code;
  } finally {
    Deno.exit = real;
  }
  return code;
}

async function capture(
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const l = console.log, e = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = l;
    console.error = e;
  }
  return { logs, errors };
}

/** A fake app control port. `triggerReply` is what POST trigger/0 answers with
 *  — always HTTP 200, exactly like a real client's reply. */
function fakeControlServer(triggerReply: unknown) {
  return Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const p = new URL(req.url).pathname;
      const json = (d: unknown) =>
        new Response(JSON.stringify(d), {
          headers: { "content-type": "application/json" },
        });
      if (p === "/__aio/trojan/trigger/0" && req.method === "POST") {
        return json(triggerReply);
      }
      return new Response("not found", { status: 404 });
    },
  );
}

const flagsFor = (port: number, app: string): GlobalFlags =>
  ({ json: true, port, app }) as GlobalFlags;

// ── 1. am trigger: a miss is a FAILURE, not a 200 ────────────
//
// `runUITrigger` (src/air/ui-remote.ts) answers a vanished path with
// `{ok:false, error, available:[…]}` — inside a 200. `cmdTrigger` checked only
// the transport-level `result.ok`, so the documented agent loop
// (observe → act → observe) reported the ACT as done when nothing was
// clicked. The same function already inspected `ok === false` for the `clear`
// half of `setValue`: two rules for one fact, and the weaker one was on the
// path every trigger takes.

Deno.test("am trigger: an unresolved path exits 1 (200 body says ok:false)", async () => {
  const app = `am-trig-miss-${Deno.pid}`;
  const server = fakeControlServer({
    ok: false,
    path: "App:GoneButton",
    action: "click",
    error: "element not found on the live surface",
    available: ["App:AddButton"],
  });
  try {
    const port = (server.addr as Deno.NetAddr).port;
    const { logs } = await capture(async () => {
      const code = await exitCodeOf(() =>
        cmdTrigger(["0", "App:GoneButton", "click"], flagsFor(port, app))
      );
      assertEquals(code, 1, "a trigger that did nothing must exit non-zero");
    });
    // Still machine-readable: the `available` list is how a caller self-corrects.
    const body = JSON.parse(logs[0]!) as { available: string[] };
    assertEquals(body.available, ["App:AddButton"]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("am trigger: a real hit still succeeds (exit 0, ok:true)", async () => {
  const app = `am-trig-hit-${Deno.pid}`;
  const server = fakeControlServer({
    ok: true,
    path: "App:AddButton",
    action: "click",
    surface: [],
  });
  try {
    const port = (server.addr as Deno.NetAddr).port;
    const { logs } = await capture(async () => {
      const code = await exitCodeOf(() =>
        cmdTrigger(["0", "App:AddButton", "click"], flagsFor(port, app))
      );
      assertEquals(code, null, "a successful trigger must not exit non-zero");
    });
    assertEquals(JSON.parse(logs[0]!).ok, true);
  } finally {
    await server.shutdown();
  }
});

Deno.test("am trigger: setValue reports the miss of its own type step", async () => {
  // `clear` succeeds, then the element vanishes before the `type` — the second
  // reply is the one that carries the truth, and it used to be printed under a
  // zero exit.
  const app = `am-trig-sv-${Deno.pid}`;
  let n = 0;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/__aio/trojan/trigger/0" && req.method === "POST") {
        const body = n++ === 0
          ? { ok: true, path: "App:Field", action: "clear" }
          : { ok: false, path: "App:Field", action: "type", error: "gone" };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  );
  try {
    const port = (server.addr as Deno.NetAddr).port;
    await capture(async () => {
      const code = await exitCodeOf(() =>
        cmdTrigger(
          ["0", "App:Field", "setValue", "hi"],
          flagsFor(port, app),
        )
      );
      assertEquals(code, 1);
    });
  } finally {
    await server.shutdown();
  }
});

// ── 2. am log --client: the path the app actually writes ─────
//
// `client.log` is written by src/server/client-log.ts into the ACTIVE LOGGER'S
// directory — `appDirs(appId).logs` since alpha38, `.aio/log` before that. `am`
// carried its own literal `"log/client.log"`, a relative path no aio version has
// ever written, so `am log --client` answered "(no client log yet)" for every
// app that ever existed — and exited 0 while doing it.

Deno.test("am log --client: reads the app's real client.log", async () => {
  const app = `am-clientlog-${Deno.pid}`;
  const home = await Deno.makeTempDir({ prefix: "am-clientlog-" });
  const logs = join(home, "logs");
  await Deno.mkdir(logs, { recursive: true });
  // The shape has ONE owner (appDirs) — a hand-built literal here was a
  // second copy that broke the day the real one grew a field.
  registerAppDirs(app, appDirs(app, home));
  await Deno.writeTextFile(
    join(logs, "client.log"),
    "[t] [INFO ] [client:0] boot\n[t] [ERROR] [client:0] boom\n",
  );
  try {
    const r = await capture(() =>
      cmdLog([], { app, client: 0, json: true } as GlobalFlags)
    );
    const all = r.logs.join("\n");
    assertStringIncludes(all, "boom");
    // --json means JSON on stdout — every line of it.
    for (const line of r.logs) {
      JSON.parse(line); // throws if a raw log line was printed into the stream
    }
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

Deno.test("am log --client: no client log is an error, not a zero exit", async () => {
  const app = `am-clientlog-none-${Deno.pid}`;
  const home = await Deno.makeTempDir({ prefix: "am-clientlog-none-" });
  // The shape has ONE owner (appDirs) — a hand-built literal here was a
  // second copy that broke the day the real one grew a field.
  registerAppDirs(app, appDirs(app, home));
  try {
    const { logs } = await capture(async () => {
      const code = await exitCodeOf(() =>
        cmdLog([], { app, client: 0, json: true } as GlobalFlags)
      );
      assertEquals(code, 1);
    });
    // The message names the path it looked at — "(no client log yet)" named
    // none. --json errors land on STDOUT (the stream a script parses).
    assert(
      logs.some((e) => e.includes("client.log")),
      `must name the path searched, got: ${logs.join(" | ")}`,
    );
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

// ── 3. every failure exits non-zero ──────────────────────────

Deno.test("am log: a missing log file exits 1", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "am-nolog-" });
  const cwd = Deno.cwd();
  try {
    Deno.chdir(tmp);
    await capture(async () => {
      const code = await exitCodeOf(() =>
        cmdLog([], { json: true, app: `am-nolog-${Deno.pid}` } as GlobalFlags)
      );
      assertEquals(code, 1);
    });
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("am new: every refusal exits 1", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "am-new-exit-" });
  const cwd = Deno.cwd();
  const flags = { json: true } as GlobalFlags;
  try {
    Deno.chdir(tmp);
    const cases: [string, string[]][] = [
      ["usage", []],
      ["invalid name", ["cell", "2fast"]],
      ["unknown kind", ["widget", "ok"]],
    ];
    for (const [name, args] of cases) {
      await capture(async () => {
        const code = await exitCodeOf(() => cmdAdd(args, flags));
        assertEquals(code, 1, `am add ${name} must exit 1`);
      });
    }
    // Scaffolding twice: the second run created nothing, and said so with a 0.
    await capture(() => cmdAdd(["cell", "widget"], flags));
    await capture(async () => {
      const code = await exitCodeOf(() => cmdAdd(["cell", "widget"], flags));
      assertEquals(code, 1, "am add over an existing file must exit 1");
    });
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("am create: every refusal exits 1", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "am-create-exit-" });
  const cwd = Deno.cwd();
  const flags = { json: true } as GlobalFlags;
  try {
    Deno.chdir(tmp);
    // `am create x && cd x` is the documented first line of onboarding — a zero
    // exit here sends the shell into a directory that does not exist.
    const cases: [string, string[]][] = [
      ["usage", []],
      ["invalid name", ["../escape"]],
      ["unknown template", ["ok", "--template=nope"]],
    ];
    for (const [name, args] of cases) {
      await capture(async () => {
        const code = await exitCodeOf(() => cmdCreate(args, flags));
        assertEquals(code, 1, `am create ${name} must exit 1`);
      });
    }
    // Non-empty target directory without --force.
    await Deno.mkdir(join(tmp, "taken"));
    await Deno.writeTextFile(join(tmp, "taken", "keep.txt"), "mine");
    await capture(async () => {
      const code = await exitCodeOf(() => cmdCreate(["taken"], flags));
      assertEquals(code, 1, "am create over a non-empty dir must exit 1");
    });
    assertEquals(
      await Deno.readTextFile(join(tmp, "taken", "keep.txt")),
      "mine",
      "the refusal must not have touched the directory",
    );
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

// ── 4. "no client connected" must be a REFUSAL, not a 200 ────
//
// `handleTrojan`'s sendToClient falls back to the UDS transport when the WS
// roster has no such index, guarded by `if (trojan.requestUdsClientState)` —
// but aio-server.ts ALWAYS supplies that function, and with no UDS listener it
// resolves `{error:"UDS not active"}`, which is served as HTTP 200. So the
// `err("client N not connected", 404)` two lines below it was unreachable, and
// every client-addressed route answered "success" for a client that does not
// exist:
//   am client 0   → prints {"error":"UDS not active"}, exit 0
//   am surface 0  → prints [] (an empty surface!), exit 0
//   am trigger 0  → prints {"error":"UDS not active"}, exit 0
// and `am surface` with no index never reached its headless fallback, because
// the reply it was supposed to fall back FROM looked like a success.

Deno.test("am: a client index that is not connected is a loud refusal", async () => {
  const { aio } = await import("../src/server/aio.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const { cmdClient, cmdSurface } = await import(
    "../src/am/am-cmd-inspect.ts"
  );
  const { toFileUrl } = await import("@std/path");
  const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

  _resetAioRuntime();
  const dir = await Deno.makeTempDir({ prefix: "am-noclient-" });
  await Deno.writeTextFile(
    join(dir, "cell.ts"),
    `import { cell } from "${toFileUrl(REPO).href}/src/state/cell-create.ts";
export const nc = cell("am-noclient", {
  state: { label: "live-label" },
  methods: { set(s, v: string) { s.label = v; } },
});
`,
  );
  await Deno.writeTextFile(
    join(dir, "App.tsx"),
    `import { h } from "${toFileUrl(REPO).href}/src/air/vdom.ts";
import { nc } from "./cell.ts";
export default function App() {
  return h("div", null,
    h("span", null, (nc as { label?: string }).label ?? ""),
    h("button", { onClick: () => {} }, "Refresh"));
}
`,
  );
  const mod = await import(toFileUrl(join(dir, "cell.ts")).href) as {
    nc: import("../src/state/cell.ts").CellDef;
  };
  const appId = "am-noclient-app";
  const app = await aio.run({
    cells: [mod.nc],
    appId,
    libraryMode: true,
    persist: false,
    client: "server-only",
    baseDir: dir,
  });
  const flags = { json: true, app: appId, port: app.port! } as GlobalFlags;
  try {
    // No browser, no electron, no UDS — index 0 addresses nothing.
    for (
      const [name, fn] of [
        ["am client 0", () => cmdClient(["0"], flags)],
        ["am surface 0", () => cmdSurface(["0"], flags)],
        [
          "am trigger 0",
          () => cmdTrigger(["0", "App:RefreshButton", "click"], flags),
        ],
      ] as [string, () => Promise<void>][]
    ) {
      const { logs, errors } = await capture(async () => {
        const code = await exitCodeOf(fn);
        assertEquals(code, 1, `${name} against no client must exit 1`);
      });
      // --json errors land on STDOUT (the stream a script parses).
      assert(
        (logs.join(" ") + errors.join(" ")).includes("not connected"),
        `${name} must say the client is not connected, got: ` +
          `${errors.join(" | ")} / ${logs.join(" | ")}`,
      );
    }

    // …and with NO index, the CLI's documented headless fallback fires: the
    // failed `surface/0` is what triggers it, so a 200-shaped miss disabled it.
    const { logs } = await capture(() => cmdSurface([], flags));
    const surf = logs.join("\n");
    assertStringIncludes(surf, "RefreshButton");
    assertStringIncludes(surf, "live-label");
  } finally {
    await app.close();
    _resetAioRuntime();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
