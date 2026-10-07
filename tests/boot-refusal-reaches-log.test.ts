// A boot that is refused, or dies, says why in `app.log` — not only on stderr.
//
// The refusal is thrown to the app's entry, which lets it end the process, so
// the reason was printed by the runtime on stderr and nowhere else: the logger
// had been stopped and detached first. A desktop app started by a double-click
// has no stderr. Measured on a real machine: the window never opened, and
// `app.log` ended `stopped` (twice) with no ERROR anywhere.
//
// Pinned with real processes, one per place a boot can stop: inside the boot
// before the app's own shutdown exists (a database that will not open), after
// it exists (a port that is taken, a route that cannot be served, a lock
// record that cannot be rewritten), after the boot returned (a fault in the
// last step), before the logger exists (cells that cannot be composed), and
// the refusal that exits by itself (already running).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { childEnv } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = join(import.meta.dirname!, "..");

const APP = `import { aio, cell } from "aio";
import { _lockDeps, writeLock } from "aio/server/single-instance-lock.ts";
const plant = Deno.env.get("PLANT");
const appId = Deno.env.get("APP_ID")!;
if (plant === "lock-update") {
  // The lock record cannot be rewritten when the app comes up.
  const write = _lockDeps.write;
  _lockDeps.write = (f, bytes) => {
    if (new TextDecoder().decode(bytes).includes('"status":"started"')) {
      throw new Deno.errors.PermissionDenied(
        "Access is denied. (os error 5): planted on the lock record");
    }
    write(f, bytes);
  };
}
if (plant === "running") {
  // A live holder that is not this process: the parent.
  writeLock({ appId, pid: Deno.ppid, port: 0, startedAt: Date.now(),
    status: "starting", cwd: "/" });
}
const embedded = plant.startsWith("emb-");
if (Deno.env.get("HOST")) {
  // An app of the process's own, up and running, that embeds a second one.
  await aio.run({
    appId: appId + "-host",
    cells: [cell("host", { state: { n: 0 }, methods: { inc(s) { s.n++; } } })],
    client: "server-only",
    port: 0,
  });
}
let up = false;
const probe = cell("probe", {
  // "compose": a credential-named field every client would receive — refused
  // while the cells are composed, before the boot has a logger.
  state: plant.endsWith("compose") ? { n: 0, apiKey: "sk-live" } : { n: 0 },
  methods: { inc(s) { s.n++; } },
  onInit() { up = true; },
});
const config = {
  appId,
  cells: [probe],
  client: "server-only",
  ...(plant === "port" ? { port: Number(Deno.env.get("PORT")) } : {}),
  ...(plant.endsWith("route")
    ? { routes: { "/a/*/b": () => new Response("x") } }
    : {}),
  ...(embedded
    ? { libraryMode: true, port: 0, baseDir: Deno.env.get("BASE") }
    : {}),
};
if (plant === "late") {
  // Read by the boot's last step, after the app is up.
  Object.defineProperty(config, "onStart", {
    enumerable: true,
    get() {
      if (up) throw new Error("planted: a fault after the app came up");
      return undefined;
    },
  });
}
if (embedded) {
  // The host's own answer to an embedded app that refuses: catch, carry on.
  try {
    await aio.run(config as never);
    console.log("EMBEDDED BOOTED");
  } catch (e) {
    console.log("HOST CAUGHT " + (e as Error).message);
  }
  Deno.exit(0);
}
await aio.run(config as never);
console.log("BOOTED");
Deno.exit(0);
`;

interface Outcome {
  code: number;
  out: string;
  app: string;
  error: string;
  /** Every path under the run's directory once it ended, relative to it
   *  (Deno's own `deno.lock` aside). */
  tree: string[];
}

function walkAll(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(join(root, rel))) {
    const at = rel ? `${rel}/${e.name}` : e.name;
    if (at === "deno.lock") continue;
    out.push(at);
    if (e.isDirectory) out.push(...walkAll(root, at));
  }
  return out.sort();
}

async function boot(
  plant: string,
  prepare?: (
    home: string,
    dir: string,
  ) => Promise<Record<string, string> | void>,
  args: (dir: string) => string[] = () => [],
): Promise<Outcome> {
  const dir = await tempDir("boot-refusal-log-");
  try {
    const appId = `refusal-log-${plant}-${Deno.pid}`;
    const apps = join(dir, "apps");
    const home = join(apps, appId);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${spec(REPO)}/mod.ts`,
          "aio/": `${spec(REPO)}/src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "app.ts"), APP);
    const extra = await prepare?.(home, dir) ?? {};
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts"), ...args(dir)],
      cwd: dir,
      env: childEnv({
        AIO_APPS_DIR: apps,
        APP_ID: appId,
        PLANT: plant,
        ...extra,
      }),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
    const dec = new TextDecoder();
    const read = (name: string) => {
      try {
        return Deno.readTextFileSync(join(home, "logs", name));
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return "";
        throw e;
      }
    };
    return {
      code: r.code,
      out: dec.decode(r.stdout) + dec.decode(r.stderr),
      app: read("app.log"),
      error: read("error.log"),
      tree: walkAll(dir),
    };
  } finally {
    await dropTempDir(dir);
  }
}

const count = (text: string, re: RegExp) =>
  text.split("\n").filter((l) => re.test(l)).length;

/** The refusal is in app.log and error.log at ERROR, once, and the run's
 *  "stopped" summary is not written twice. */
function assertSaid(o: Outcome, reason: string): void {
  assertEquals(o.code, 1, o.out);
  assertStringIncludes(o.out, reason, "the caller still gets the reason");
  const said = o.app.split("\n").filter((l) =>
    /ERROR\s+boot\s+refused/.test(l)
  );
  assertEquals(said.length, 1, `app.log:\n${o.app}\n--- output:\n${o.out}`);
  assertStringIncludes(said[0]!, reason);
  assertEquals(count(o.out, /ERROR\s+boot\s+refused/), 1, o.out);
  assertStringIncludes(o.error, reason, "error.log carries it too");
  assert(
    count(o.app, /INFO\s+app\s+stopped/) <= 1,
    `"stopped" written more than once:\n${o.app}`,
  );
}

Deno.test("boot refusal → app.log: a lock record that cannot be rewritten", async () => {
  const o = await boot("lock-update");
  assertSaid(o, "Access is denied. (os error 5)");
  assertEquals(count(o.app, /INFO\s+app\s+stopped/), 1, o.app);
});

Deno.test("boot refusal → app.log: a port that is taken", async () => {
  const held = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const o = await boot(
      "port",
      () => Promise.resolve({ PORT: String(held.addr.port) }),
    );
    assertSaid(o, `port ${held.addr.port} already in use`);
  } finally {
    held.close();
  }
});

Deno.test("boot refusal → app.log: a route that cannot be served", async () => {
  assertSaid(await boot("route"), 'invalid custom route "/a/*/b"');
});

Deno.test("boot refusal → app.log: a database that will not open", async () => {
  const o = await boot("db", async (home) => {
    await Deno.mkdir(join(home, "data"), { recursive: true, mode: 0o700 });
    await Deno.writeFile(
      join(home, "data", "state.db"),
      new Uint8Array(8192).fill(0x5a),
    );
  });
  assertSaid(o, "persistence unavailable");
});

Deno.test("boot refusal → app.log: a fault after the app came up", async () => {
  assertSaid(await boot("late"), "planted: a fault after the app came up");
});

Deno.test("boot refusal → app.log: a refusal from BEFORE the logger existed (cells that cannot be composed), in a home that exists", async () => {
  const o = await boot(
    "compose",
    (home) => Deno.mkdir(home, { recursive: true }),
  );
  assertSaid(o, "apiKey");
  assertEquals(count(o.app, /INFO\s+app\s+stopped/), 1, o.app);
});

// A refused start is not what creates an app's home: `--home=<a typo>` left a
// folder of log files wherever the typo pointed.
Deno.test("boot refusal before the logger, NO home yet: the reason on the console, nothing created", async () => {
  const o = await boot("compose");
  assertEquals(o.code, 1, o.out);
  assertStringIncludes(o.out, "apiKey");
  assertEquals(o.tree, ["app.ts", "deno.json"], "the default home");

  const typo = await boot(
    "compose",
    undefined,
    (dir) => [`--home=${join(dir, "typo", "deeper", "home")}`],
  );
  assertEquals(typo.code, 1, typo.out);
  assertStringIncludes(typo.out, "apiKey");
  assertEquals(typo.tree, ["app.ts", "deno.json"], "a home named by --home");
});

// An embedded app's refusal is an exception its host catches — the host
// decides what it means. aio printing "ERROR boot refused — the app did not
// start" beside it called a handled condition a failure, on the host's console.
for (const host of [false, true]) {
  for (const plant of ["emb-compose", "emb-route"]) {
    Deno.test(
      `an embedded app that refuses (${plant}, ${
        host ? "inside a running app" : "alone"
      }): the throw carries the reason, no "boot refused" line`,
      async () => {
        const o = await boot(
          plant,
          (_home, dir) =>
            Promise.resolve({ BASE: dir, ...(host ? { HOST: "1" } : {}) }),
        );
        assertEquals(o.code, 0, o.out);
        assertStringIncludes(
          o.out,
          plant === "emb-compose"
            ? "HOST CAUGHT"
            : 'HOST CAUGHT [aio] invalid custom route "/a/*/b"',
        );
        if (plant === "emb-compose") assertStringIncludes(o.out, "apiKey");
        assertEquals(count(o.out, /boot\s+refused/), 0, o.out);
      },
    );
  }
}

Deno.test("boot refusal → app.log: already running (the refusal that exits by itself)", async () => {
  const o = await boot("running");
  assertEquals(o.code, 1, o.out);
  const said = o.app.split("\n").filter((l) => /ERROR/.test(l));
  assertEquals(said.length, 1, o.app);
  assertStringIncludes(said[0]!, "Already running");
  // The logs are the RUNNING app's: the refusal is one line in app.log and
  // nothing in its error.log (see `guestLogger`).
  assert(!o.error.includes("Already running"), o.error);
});
