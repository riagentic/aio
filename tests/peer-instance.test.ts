// peer(id, { instance }) (aipro §7): an app started with `--instance=agent1`
// has its locks in that instance's scope, so `peer("svc")` from it never
// found a service running as the default instance (or another one) — `null`,
// "not running", while it was. `instance: null` reads the default scope,
// `instance: "<name>"` that instance's; an identity (`as`) cannot be proven
// across scopes and is refused by name. Real apps, real lock dirs.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { childEnv } from "./e2e-app-harness.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

Deno.test("peer: { instance: null } and { instance: name } reach a service in another --instance scope; `as` across scopes is refused", async () => {
  const dir = await tempDir("peer-instance-");
  const mod = toFileUrl(join(ROOT, "mod.ts")).href;
  const srv = toFileUrl(join(ROOT, "src/server-entry.ts")).href;
  const home = join(dir, "home");
  const run = join(dir, "run");
  await Deno.mkdir(home, { recursive: true });
  await Deno.mkdir(run, { recursive: true, mode: 0o700 });
  const svc = (id: string) =>
    `import { aio, cell } from "${mod}";
const c = cell("svc", { state: { n: 0 }, methods: { bump(s) { return ++s.n; } } });
await aio.run({ appId: "${id}", cells: [c], client: "server-only" });
`;
  const a = `pidef${Deno.pid}`, b = `pinam${Deno.pid}`;
  await Deno.writeTextFile(join(dir, "a.ts"), svc(a));
  await Deno.writeTextFile(join(dir, "b.ts"), svc(b));
  await Deno.writeTextFile(
    join(dir, "caller.ts"),
    `import { aio, cell } from "${mod}";
import { peer } from "${srv}";
const c = cell("me", { state: { x: 0 }, methods: { getX(s) { return s.x; } } });
await aio.run({ appId: "picaller${Deno.pid}", cells: [c], client: "server-only" });
const wait = async (id, opts) => {
  for (let i = 0; i < 200; i++) {
    const p = await peer(id, opts);
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};
const out = {};
const pa = await wait("${a}", { instance: null });
out.defaultScope = pa ? await pa.call("svc", "bump") : "not found";
pa?.close();
const pb = await wait("${b}", { instance: "svc1" });
out.namedScope = pb ? await pb.call("svc", "bump") : "not found";
pb?.close();
out.ownScope = await peer("${a}");
try { await peer("${a}", { instance: null, as: "picaller${Deno.pid}" }); out.as = "allowed"; }
catch (e) { out.as = e.message; }
try { await peer("${a}", { instance: "../x" }); out.bad = "allowed"; }
catch (e) { out.bad = e.message; }
console.log("RESULT " + JSON.stringify(out));
Deno.exit(0);
`,
  );
  // One HOME and runtime dir for all three, so `--instance` names and the
  // default lock dir resolve to the same places; the default-scope service
  // runs with NO AIO_APPS_DIR, the named one in `~/.aio-instances/svc1`, the
  // caller in an apps root of its own (as `--instance=agent1` would).
  const base = { ...childEnv(), HOME: home, XDG_RUNTIME_DIR: run };
  const env = (appsDir: string | null) => {
    const e: Record<string, string> = { ...base };
    // Empty reads as unset (a spawned child inherits this process's env, so
    // deleting the key would leave the test runner's apps root in place).
    e.AIO_APPS_DIR = appsDir ?? "";
    return e;
  };
  const spawn = (
    file: string,
    e: Record<string, string>,
    stdout: "piped" | "null",
  ) =>
    new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(ROOT, "deno.json"), file],
      cwd: dir,
      env: e,
      stdout,
      stderr: "null",
    }).spawn();
  const sa = spawn(join(dir, "a.ts"), env(null), "null");
  const sb = spawn(
    join(dir, "b.ts"),
    env(join(home, ".aio-instances", "svc1")),
    "null",
  );
  try {
    const { stdout } = await spawn(
      join(dir, "caller.ts"),
      env(join(home, ".aio-instances", "agent1")),
      "piped",
    ).output();
    const line = new TextDecoder().decode(stdout).split("\n")
      .find((l) => l.startsWith("RESULT "));
    assert(line, "the caller printed no result");
    const out = JSON.parse(line.slice(7));
    assertEquals(out.defaultScope, 1);
    assertEquals(out.namedScope, 1);
    assertEquals(out.ownScope, null, "its own scope has no such app");
    assert(/proven within one --instance scope/.test(out.as), out.as);
    assert(/--instance needs a simple name/.test(out.bad), out.bad);
  } finally {
    for (const p of [sa, sb]) {
      p.kill("SIGTERM");
      await p.status;
    }
    await dropTempDir(dir);
  }
});
