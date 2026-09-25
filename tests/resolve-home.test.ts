// resolveHome() — the data home asked BEFORE aio.run(), and the refusal of the
// split it exists to prevent.
//
// A wallet app opened its vault before aio.run() and passed appDir + dbPath
// explicitly. Under `--profile=tasks` (1.0.11) aio moved its lock, logs and
// meta.json to the profile home while the vault and the explicit dbPath
// opened the everyday one — silently. These boots prove resolveHome() names
// the SAME folder aio.run() registers (on the main isolate and in a worker
// cell's thread), and that the split dbPath is refused at boot.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  _resetAppDirs,
  dbPathOutsideHomeError,
  homeRequested,
  registeredProfile,
} from "../src/server/app-dirs.ts";
import { resolveHome } from "../src/server/resolve-home.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Prints resolveHome() before aio.run(), then the dirs aio.run registered —
 *  and, with a worker cell, what resolveHome() answers in the worker. */
const PROBE = `import { aio, cell, isCellWorker } from "${REPO}/mod.ts";
import { resolveHome } from "${REPO}/src/server-entry.ts";
import { appDirs, registeredProfile } from "${REPO}/src/server/app-dirs.ts";
import { resolveAppId } from "${REPO}/src/server/single-instance-lock.ts";
const cfg = JSON.parse(Deno.env.get("PROBE_CFG") ?? "{}");
const ask = () => {
  try {
    return resolveHome({ appId: cfg.appId, appDir: cfg.appDir, profiles: cfg.profiles });
  } catch (e) {
    return { error: (e as Error).message };
  }
};
const probe = cell("probe", {
  worker: !!cfg.worker,
  state: { n: 0 },
  methods: { where(_s: { n: number }) { return { inWorker: isCellWorker(), ...ask() }; } },
});
if (!isCellWorker()) console.log("PRE " + JSON.stringify(ask()));
const { worker: _w, ...run } = cfg;
await aio.run({ cells: [probe], ...run, persist: false, client: "server-only", port: 0 });
if (!isCellWorker()) {
  const id = resolveAppId(cfg.appId);
  const post = { home: appDirs(id).home, profile: registeredProfile(id) };
  const worker = cfg.worker ? await probe.where() : undefined;
  console.log("POST " + JSON.stringify({ post, worker }));
  Deno.exit(0);
}
`;

type Home = { home?: string; profile?: string; error?: string };
type Result = {
  code: number;
  out: string;
  pre?: Home;
  post?: Home;
  worker?: Home & { inWorker: boolean };
};

async function boot(
  root: string,
  cfg: Record<string, unknown>,
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<Result> {
  const entry = join(root, "src", "app.ts");
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `--config=${join(REPO, "deno.json")}`, entry, ...args],
    cwd: root,
    env: {
      AIO_APPS_DIR: join(root, "apps"),
      PROBE_CFG: JSON.stringify(cfg),
      AIO_PROFILE: "",
      ...env,
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(r.stdout) +
    new TextDecoder().decode(r.stderr);
  const line = (tag: string) => {
    const l = out.split("\n").find((x) => x.startsWith(tag + " "));
    return l ? JSON.parse(l.slice(tag.length + 1)) : undefined;
  };
  const post = line("POST");
  return {
    code: r.code,
    out,
    pre: line("PRE"),
    post: post?.post,
    worker: post?.worker,
  };
}

/** A project dir with the probe entry and its own deno.json identity. */
async function project(): Promise<string> {
  const root = await tempDir("aio-rhome-");
  await Deno.mkdir(join(root, "src"));
  await Deno.writeTextFile(join(root, "src", "app.ts"), PROBE);
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({ title: "rhome probe" }),
  );
  return root;
}

/** resolveHome() before boot === the dirs aio.run registered. */
async function agrees(
  cfg: Record<string, unknown>,
  args: string[],
  env: Record<string, string>,
  want: (root: string) => Home,
): Promise<void> {
  const root = await project();
  try {
    const r = await boot(root, cfg, args, env);
    assertEquals(r.code, 0, r.out);
    assertEquals(r.pre, want(root), r.out);
    assertEquals(
      {
        home: r.post!.home,
        ...(r.post!.profile ? { profile: r.post!.profile } : {}),
      },
      r.pre,
      r.out,
    );
  } finally {
    await dropTempDir(root);
  }
}

Deno.test("resolveHome === aio.run: no request → the default home", async () => { // aio-ok: agrees() asserts exit 0, the expected home and aio.run's
  await agrees({ appId: "rh" }, [], {}, (root) => ({
    home: join(root, "apps", "rh"),
  }));
});

Deno.test("resolveHome === aio.run: --profile=tasks", async () => { // aio-ok: agrees() asserts exit 0, the expected home and aio.run's
  await agrees({ appId: "rh" }, ["--profile=tasks"], {}, (root) => ({
    home: join(root, "apps", "rh-tasks"),
    profile: "tasks",
  }));
});

Deno.test("resolveHome === aio.run: AIO_PROFILE=tasks", async () => { // aio-ok: agrees() asserts exit 0, the expected home and aio.run's
  await agrees({ appId: "rh" }, [], { AIO_PROFILE: "tasks" }, (root) => ({
    home: join(root, "apps", "rh-tasks"),
    profile: "tasks",
  }));
});

Deno.test("resolveHome === aio.run: --home=<dir>", async () => {
  const root = await project();
  try {
    const dir = join(root, "elsewhere");
    const r = await boot(root, { appId: "rh" }, [`--home=${dir}`]);
    assertEquals(r.code, 0, r.out);
    assertEquals(r.pre, { home: dir });
    assertEquals(r.post, { home: dir });
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("resolveHome === aio.run: explicit appDir + --profile → <appDir>-tasks", async () => {
  const root = await project();
  try {
    const vault = join(root, "vault");
    const r = await boot(root, { appId: "rh", appDir: vault }, [
      "--profile=tasks",
    ]);
    assertEquals(r.code, 0, r.out);
    assertEquals(r.pre, { home: `${vault}-tasks`, profile: "tasks" });
    assertEquals(r.post, r.pre);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("resolveHome === aio.run: an omitted appId derives the same identity", async () => {
  const root = await project();
  try {
    const r = await boot(root, {}, ["--profile=tasks"]);
    assertEquals(r.code, 0, r.out);
    assert(r.pre?.home?.endsWith("-tasks"), r.out);
    assertEquals(r.post, r.pre);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("resolveHome and aio.run refuse profiles:false with one text", async () => {
  const root = await project();
  try {
    const r = await boot(root, { appId: "rh", profiles: false }, [
      "--profile=tasks",
    ]);
    assertEquals(r.code, 1, r.out);
    assert(r.pre?.error, r.out);
    assertStringIncludes(r.pre.error, "profiles: false");
    // aio.run's exit-1 line carries the same text.
    assertStringIncludes(r.out.replace(r.pre.error, ""), r.pre.error);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("resolveHome in a worker cell's thread === main === aio.run (Deno.args + env reach the worker)", async () => {
  const root = await project();
  try {
    // No appId: the worker must also inherit the owner's identity.
    const r = await boot(root, { worker: true }, ["--profile=tasks"]);
    assertEquals(r.code, 0, r.out);
    assert(r.worker?.inWorker, "the method must really run in the worker");
    assertEquals(r.pre?.profile, "tasks");
    assertEquals(r.post, r.pre);
    const { inWorker: _, ...w } = r.worker!;
    assertEquals(w, r.pre);
  } finally {
    await dropTempDir(root);
  }
});

// ── the split: dbPath outside the requested home ──

Deno.test("boot refuses an explicit dbPath outside the profile home (config and --db-path)", async () => {
  const root = await project();
  try {
    const vault = join(root, "vault");
    const everyday = join(vault, "data", "state.db");
    const byConfig = await boot(
      root,
      { appId: "rh", appDir: vault, dbPath: everyday },
      ["--profile=tasks"],
    );
    assertEquals(byConfig.code, 1, byConfig.out);
    assertStringIncludes(
      byConfig.out,
      `--profile=tasks runs this app from ${vault}-tasks, but dbPath ` +
        `${everyday} lies outside it`,
    );
    assertStringIncludes(byConfig.out, "resolveHome()");
    const byFlag = await boot(root, { appId: "rh" }, [
      "--profile=tasks",
      `--db-path=${everyday}`,
    ]);
    assertEquals(byFlag.code, 1, byFlag.out);
    assertStringIncludes(byFlag.out, `dbPath ${everyday} lies outside it`);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("dbPath inside the profile home, or with no request, still boots", async () => {
  const root = await project();
  try {
    const vault = join(root, "vault");
    const inside = await boot(
      root,
      { appId: "rh", appDir: vault, dbPath: `${vault}-tasks/data/state.db` },
      ["--profile=tasks"],
    );
    assertEquals(inside.code, 0, inside.out);
    const plain = await boot(root, {
      appId: "rh",
      appDir: vault,
      dbPath: join(root, "other", "state.db"),
    });
    assertEquals(plain.code, 0, plain.out);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("dbPathOutsideHomeError: inside, sibling prefix, memory, relative", () => {
  const h = "/srv/app-tasks";
  assertEquals(dbPathOutsideHomeError(undefined, h, "x"), null);
  assertEquals(dbPathOutsideHomeError(":memory:", h, "x"), null);
  assertEquals(dbPathOutsideHomeError("file::memory:?c=1", h, "x"), null);
  assertEquals(dbPathOutsideHomeError(`${h}/data/state.db`, h, "x"), null);
  assert(dbPathOutsideHomeError(`${h}2/data/state.db`, h, "x"));
  assert(dbPathOutsideHomeError("/srv/app/data/state.db", h, "x"));
  assert(dbPathOutsideHomeError(h, h, "x"));
  assert(dbPathOutsideHomeError(`${h}/../app/state.db`, h, "x"));
});

Deno.test("resolveHome is a query: it records no profile and no request", () => {
  const prev = Deno.env.get("AIO_PROFILE");
  _resetAppDirs();
  Deno.env.set("AIO_PROFILE", "tasks");
  try {
    const got = resolveHome({ appId: "rh-pure" });
    assertEquals(got.profile, "tasks");
    assertEquals(homeRequested("rh-pure"), false);
    assertEquals(registeredProfile("rh-pure"), undefined);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_PROFILE");
    else Deno.env.set("AIO_PROFILE", prev);
    _resetAppDirs();
  }
});

Deno.test("a refused dbPath leaves no profile recorded — a second app that catches it is not left half-profiled", async () => {
  const root = await tempDir("aio-rhome-caught-");
  try {
    await Deno.mkdir(join(root, "src"));
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ title: "rhome caught" }),
    );
    // App A boots under the profile; app B, in the same process, asks for a
    // dbPath outside ITS profile home — refused by a throw (a runtime is up).
    await Deno.writeTextFile(
      join(root, "src", "app.ts"),
      `import { aio, cell } from "${REPO}/mod.ts";
import { homeRequested, registeredProfile } from "${REPO}/src/server/app-dirs.ts";
const c = (n: string) => cell(n, { state: { n: 0 }, methods: {} });
const base = { persist: false, client: "server-only", port: 0 } as const;
await aio.run({ appId: "rh-a", cells: [c("a")], ...base });
let refused = "";
try {
  await aio.run({ appId: "rh-b", cells: [c("b")], ...base, dbPath: Deno.env.get("OUTSIDE") });
} catch (e) {
  refused = (e as Error).message;
}
console.log("CAUGHT " + JSON.stringify({ refused, requested: homeRequested("rh-b"), profile: registeredProfile("rh-b") ?? null }));
Deno.exit(0);
`,
    );
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        `--config=${join(REPO, "deno.json")}`,
        join(root, "src", "app.ts"),
        "--profile=tasks",
      ],
      cwd: root,
      env: {
        AIO_APPS_DIR: join(root, "apps"),
        AIO_PROFILE: "",
        OUTSIDE: join(root, "elsewhere", "state.db"),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    const line = out.split("\n").find((l) => l.startsWith("CAUGHT "));
    assert(line, out);
    const got = JSON.parse(line.slice("CAUGHT ".length));
    assertStringIncludes(got.refused, "lies outside it");
    assertEquals(
      { requested: got.requested, profile: got.profile },
      { requested: false, profile: null },
      out,
    );
  } finally {
    await dropTempDir(root);
  }
});
