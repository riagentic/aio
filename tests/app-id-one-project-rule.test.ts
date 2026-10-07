// A zero-config app's identity is ONE rule — `projectAppId` — whichever of dev,
// the build or `am` asks, and wherever the launch cwd is.
//
// The dev runtime used to read deno.json from the CWD only (no walk up, not
// the entry's project), so the SAME project resolved a different identity — a
// different data directory — depending on where `deno run` was launched from:
// a pinned `appId` was dropped when launched from `src/`, and an entry at
// `server/main.ts` was `~/.server` in dev but `~/.<project>` to the build
// (`binaryName`) and to `am` (`projectRoot()`).
//
// docs/basics/pitfalls.md: "Pin `appId` in `deno.json` … The chain is the same
// one the build names the binary with, so `deno run` and the compiled artifact
// resolve the **same** id — compiling never moves your data directory."
//
// The project rule applies only to an entry the project DECLARES (deno.json
// `entry`, else `src/app.ts`, or a `build.targets` entry — what the build
// compiles): a monorepo root deno.json, or an unrelated `~/deno.json`, must not
// fold every entry below it into one app. Any other entry keeps the previous
// rule (the launch cwd's deno.json, else the entry's folder).
//
// Where the rule change would move an existing app's data, the app keeps
// booting under the OLD id, with a warning naming both paths and both fixes —
// never a refused boot, never a silent fresh start.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basename, fromFileUrl, join } from "@std/path";
import { spec } from "./module-spec-helper.ts";
import { linkDir } from "./symlink-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";

const AIO_ROOT = fromFileUrl(new URL("..", import.meta.url));

const PROBE = `import { resolveAppId } from "${
  spec(join(AIO_ROOT, "src/server/single-instance-lock.ts"))
}";
console.log("IDPROBE " + resolveAppId());
`;

const AM_PROBE = `import { resolveAmAppId } from "${
  spec(join(AIO_ROOT, "src/am/am-utils.ts"))
}";
console.log("IDPROBE " + resolveAmAppId());
`;

/** Every probe looks at app homes (the old-data fallback) — under a temp apps
 *  root, never the real HOME's. */
async function probe(
  entry: string,
  cwd: string,
  apps: string,
): Promise<string> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `--config=${join(AIO_ROOT, "deno.json")}`, entry],
    cwd,
    env: { AIO_APPS_DIR: apps },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(r.stdout);
  const line = out.split("\n").find((l) => l.startsWith("IDPROBE "));
  if (!line) {
    throw new Error(
      `no id (exit ${r.code})\n${out}\n${new TextDecoder().decode(r.stderr)}`,
    );
  }
  return line.slice(8).trim();
}

async function mkdirp(dir: string): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

Deno.test("appId: deno.json appId is honoured when dev is launched from src/", async () => {
  const root = await tempDir("appid-rule-");
  try {
    const apps = join(root, "apps");
    const proj = join(root, "myproj");
    await mkdirp(join(proj, "src"));
    await Deno.writeTextFile(
      join(proj, "deno.json"),
      JSON.stringify({ appId: "wallet" }),
    );
    const entry = join(proj, "src", "app.ts");
    await Deno.writeTextFile(entry, PROBE);
    // From the project root: the pinned id.
    assertEquals(await probe(entry, proj, apps), "wallet");
    // From src/ (Deno itself walks up and finds the same deno.json): the
    // pinned id must not be dropped for the directory name.
    assertEquals(await probe(entry, join(proj, "src"), apps), "wallet");
    // From somewhere unrelated: still the entry's project, not the cwd's.
    assertEquals(await probe(entry, root, apps), "wallet");
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("appId: zero-config dev, build and am agree for a declared non-src entry", async () => {
  const root = await tempDir("appid-rule-");
  try {
    const apps = join(root, "apps");
    const proj = join(root, "myproj");
    await mkdirp(join(proj, "server"));
    await Deno.writeTextFile(
      join(proj, "deno.json"),
      JSON.stringify({ entry: "server/main.ts" }),
    );
    const entry = join(proj, "server", "main.ts");
    await Deno.writeTextFile(entry, PROBE);
    // The build names the binary `projectAppId(root, deno.json)`, root = the
    // project directory — the directory's name here.
    const buildId = basename(proj);
    assertEquals(await probe(entry, proj, apps), buildId);
    assertEquals(await probe(entry, join(proj, "server"), apps), buildId);
    // `am`, run from a subdirectory of the project, says the same.
    const amProbe = join(root, "am-probe.ts");
    await Deno.writeTextFile(amProbe, AM_PROBE);
    assertEquals(await probe(amProbe, join(proj, "server"), apps), buildId);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("appId: monorepo apps under one identity-less deno.json stay distinct", async () => {
  const root = await tempDir("appid-mono-");
  try {
    const apps = join(root, "apps");
    const mono = await mkdirp(join(root, "mono"));
    await Deno.writeTextFile(join(mono, "deno.json"), '{ "imports": {} }');
    const a = join(await mkdirp(join(mono, "apps", "a")), "main.ts");
    const b = join(await mkdirp(join(mono, "apps", "b")), "main.ts");
    await Deno.writeTextFile(a, PROBE);
    await Deno.writeTextFile(b, PROBE);
    // One id for both would be one lock and one state.db for two apps.
    for (const cwd of [mono, join(mono, "apps")]) {
      assertEquals(await probe(a, cwd, apps), "a");
      assertEquals(await probe(b, cwd, apps), "b");
    }
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("appId: a sibling project's cwd deno.json never names an entry outside it", async () => {
  const root = await tempDir("appid-sibling-");
  try {
    const apps = join(root, "apps");
    // appA: pinned id, and data under it.
    const appA = await mkdirp(join(root, "appA"));
    await Deno.writeTextFile(
      join(appA, "deno.json"),
      JSON.stringify({ appId: "a" }),
    );
    await Deno.writeTextFile(
      join(await mkdirp(join(apps, "a", "data")), "state.db"),
      "",
    );
    // appB: no identity, no data — its entry is NOT appB's declared one, so
    // only the previous rule can answer; it must not answer with appA's id.
    const appB = await mkdirp(join(root, "appB"));
    await Deno.writeTextFile(join(appB, "deno.json"), "{}");
    const entry = join(await mkdirp(join(appB, "tools")), "app.ts");
    await Deno.writeTextFile(entry, PROBE);
    assertEquals(await probe(entry, appA, apps), "tools");
    // appB's declared entry, launched from appA: appB's own id, never "a".
    const declared = join(await mkdirp(join(appB, "src")), "app.ts");
    await Deno.writeTextFile(declared, PROBE);
    assertEquals(await probe(declared, appA, apps), "appb");
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("appId: an entry reached through a symlink is still inside the cwd project", async () => {
  const root = await tempDir("appid-symlink-");
  try {
    const apps = join(root, "apps");
    const real = await mkdirp(join(root, "real"));
    await Deno.writeTextFile(
      join(real, "deno.json"),
      JSON.stringify({ appId: "myid" }),
    );
    // Not the declared entry — only the cwd rule can name it.
    await Deno.writeTextFile(
      join(await mkdirp(join(real, "tools")), "app.ts"),
      PROBE,
    );
    const link = join(root, "link");
    await linkDir(real, link);
    assertEquals(
      await probe(join(real, "tools", "app.ts"), real, apps),
      "myid",
    );
    assertEquals(
      await probe(join(link, "tools", "app.ts"), real, apps),
      "myid",
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("appId: an ancestor deno.json does not name an entry it does not declare", async () => {
  const root = await tempDir("appid-ancestor-");
  try {
    const apps = join(root, "apps");
    // A `~/deno.json`-style file with an identity, a few levels up.
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ name: "@me/dotfiles" }),
    );
    const proj = join(root, "work", "proj");
    const entry = join(await mkdirp(join(proj, "src")), "app.ts");
    await Deno.writeTextFile(entry, PROBE);
    assertEquals(await probe(entry, proj, apps), "proj");
    assertEquals(await probe(entry, join(proj, "src"), apps), "proj");
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("appId: a %-encoded folder name keeps its old id while the data is there", async () => {
  const root = await tempDir("appid-space-");
  try {
    const apps = join(root, "apps");
    const proj = join(root, "my app");
    await mkdirp(join(proj, "src"));
    await Deno.writeTextFile(join(proj, "deno.json"), "{}");
    const entry = join(proj, "src", "app.ts");
    await Deno.writeTextFile(entry, PROBE);
    // No data anywhere: the project rule — the decoded folder name.
    assertEquals(await probe(entry, proj, apps), "my-app");
    // The previous rule slugified the %-encoded path (`my%20app` →
    // `my-20app`); an app that ran under it keeps its data.
    const old = await mkdirp(join(apps, "my-20app", "data"));
    await Deno.writeTextFile(join(old, "meta.json"), "{}");
    assertEquals(await probe(entry, proj, apps), "my-20app");
  } finally {
    await dropTempDir(root);
  }
});

const APP = `import { aio, cell } from "${spec(join(AIO_ROOT, "mod.ts"))}";
export const c = cell("c", { state: { n: 0 }, methods: {} });
await aio.run({ cells: [c] });
console.log("BOOTED");
Deno.exit(0);
`;

Deno.test("appId: data under the previously inferred id keeps booting there, loudly", async () => {
  const root = await tempDir("appid-move-");
  try {
    const apps = join(root, "apps");
    const proj = join(root, "myproj");
    await mkdirp(join(proj, "server"));
    await Deno.writeTextFile(
      join(proj, "deno.json"),
      JSON.stringify({ entry: "server/main.ts" }),
    );
    const entry = join(proj, "server", "main.ts");
    await Deno.writeTextFile(entry, APP);
    // What the previous rule made of this layout: `server` (the entry's
    // directory) — and an app that ran under it has its data there.
    const oldHome = join(apps, "server");
    await mkdirp(join(oldHome, "data"));
    await Deno.writeTextFile(join(oldHome, "data", "state.db"), "");
    const newHome = join(apps, "myproj");

    const boot = async () => {
      const port = await freePort();
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          `--config=${join(AIO_ROOT, "deno.json")}`,
          entry,
          `--port=${port}`,
          "--client=server-only",
        ],
        cwd: proj,
        env: { AIO_APPS_DIR: apps, NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      return { code: r.code, text: d.decode(r.stdout) + d.decode(r.stderr) };
    };

    // A working app keeps working: it boots, under the id its data is at...
    const kept = await boot();
    assertEquals(kept.code, 0, kept.text);
    assertStringIncludes(kept.text, "BOOTED");
    // Its meta.json records the id the run used — the old one.
    assertStringIncludes(
      await Deno.readTextFile(join(oldHome, "data", "meta.json")),
      '"server"',
    );
    // ...and says so, once, with both paths and both fixes.
    assertEquals(kept.text.split("app identity:").length, 2, kept.text);
    assertStringIncludes(kept.text, '"appId": "server"');
    assertStringIncludes(kept.text, `mv ${oldHome} ${newHome}`);
    // Nothing was created under the new id — no second, empty app.
    assertEquals(await exists(newHome), false, `${newHome} was created`);

    // The author moves the data: the new id, and no warning.
    await Deno.rename(oldHome, newHome);
    const moved = await boot();
    assertStringIncludes(moved.text, "BOOTED");
    assert(!moved.text.includes("app identity:"), moved.text);
    assertStringIncludes(
      await Deno.readTextFile(join(newHome, "data", "meta.json")),
      '"myproj"',
    );
  } finally {
    await dropTempDir(root);
  }
});
