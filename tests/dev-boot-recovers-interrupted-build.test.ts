// A build killed outright (SIGKILL, a power cut: no `finally`, no signal
// handler) leaves the project's node_modules with links held aside and
// package files in the build's trim mirror. The next BUILD put them back —
// but `deno task dev` in between ran on that tree and failed in ways that
// name neither the build nor the fix. Every start from source now asks, and
// the answer costs two directory listings when there is nothing to do.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { buildJournalsIn } from "../src/build/build-journals.ts";
import { recoverInterruptedBuild } from "../src/server/aio-run-helpers.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  childEnv,
  freePort,
  kill,
  REPO_ROOT,
  waitForHttp,
} from "./e2e-app-harness.ts";

const exists = (p: string) => Deno.lstat(p).then(() => true).catch(() => false);
const REL = "a@1.0.0/node_modules/a/dist/index.js.map";

/** A project as a killed build left it: package `a` installed, its source
 *  map in the trim mirror, its `node_modules/a` link held aside — each named
 *  by a journal no live build owns. Returns the two paths that must come back. */
async function killedBuild(root: string): Promise<string[]> {
  const nm = join(root, "node_modules");
  const pkg = join(nm, ".deno", "a@1.0.0", "node_modules", "a");
  await Deno.mkdir(join(pkg, "dist"), { recursive: true });
  await Deno.writeTextFile(join(pkg, "index.js"), "module.exports = 1;\n");
  await Deno.mkdir(join(root, ".aio", "trim", REL, ".."), { recursive: true });
  await Deno.writeTextFile(join(root, ".aio", "trim", REL), "MAP");
  await Deno.writeTextFile(
    join(root, ".aio", "trim-journal.json"),
    JSON.stringify([REL]),
  );
  await Deno.writeTextFile(
    join(nm, ".aio-build-links.json"),
    JSON.stringify([{
      path: "a",
      target: join(".deno", "a@1.0.0", "node_modules", "a"),
      isDir: false,
    }]),
  );
  return [join(nm, ".deno", REL), join(nm, "a", "index.js")];
}

Deno.test("dev boot: what a killed build left aside is put back — and a clean project is two listings, no build loaded", async () => {
  const root = await tempDir("dev-boot-recover-");
  try {
    assertEquals(buildJournalsIn(root), false, "no node_modules, no .aio");
    const back = await killedBuild(root);
    assertEquals(await Promise.all(back.map(exists)), [false, false]);
    assert(buildJournalsIn(root));

    const warn = console.warn;
    console.warn = () => {}; // "restored 1 node_modules link(s) …"
    try {
      await recoverInterruptedBuild(root);
    } finally {
      console.warn = warn;
    }
    assertEquals(await Promise.all(back.map(exists)), [true, true]);
    assertEquals(await Deno.readTextFile(back[0]!), "MAP");
    assertEquals(buildJournalsIn(root), false, "both journals are consumed");
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("dev boot: a real app started from source repairs its project before it serves", async () => {
  const root = await Deno.realPath(await tempDir("dev-boot-recover-e2e-"));
  let proc: Deno.ChildProcess | undefined;
  try {
    const head = JSON.parse(
      await Deno.readTextFile(join(REPO_ROOT, "deno.json")),
    );
    const imports = Object.fromEntries(
      Object.entries(head.imports as Record<string, string>).map((
        [k, v],
      ) => [k, v.startsWith("./") ? toFileUrl(join(REPO_ROOT, v)).href : v]),
    );
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ compilerOptions: head.compilerOptions, imports }),
    );
    await Deno.mkdir(join(root, "src"));
    // Top-level await, as every app is written: the recovery loads the build
    // from inside `aio.run`, and must not stall the module that awaits it.
    await Deno.writeTextFile(
      join(root, "src", "app.ts"),
      `import { aio, cell } from "aio";\n` +
        `cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });\n` +
        `await aio.run({ client: "server-only", ui: { title: "Recover" } });\n`,
    );
    const back = await killedBuild(root);
    const port = freePort();
    let out = "";
    proc = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(root, "deno.json"),
        join(root, "src", "app.ts"),
        `--port=${port}`,
      ],
      cwd: root,
      env: childEnv({ AIO_APPS_DIR: join(root, "home") }),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const dec = new TextDecoder();
    const pumps = [proc.stdout, proc.stderr].map(async (s) => {
      for await (const c of s) out += dec.decode(c);
    });
    try {
      await waitForHttp(`http://127.0.0.1:${port}/health`, 60_000);
    } catch (e) {
      throw new Error(`${e}\n${out.slice(-2000)}`);
    }
    assertEquals(await Promise.all(back.map(exists)), [true, true], out);
    assertEquals(buildJournalsIn(root), false);
    await kill(proc);
    await Promise.all(pumps);
    proc = undefined;
  } finally {
    if (proc) await kill(proc);
    await dropTempDir(root);
  }
});
