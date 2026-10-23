// An app with NO UI (the cli template: no src/App.tsx) under `am surface` and
// `am trigger`. surface answered "Module not found …/src/App.tsx" — a crash,
// read as a broken app — and trigger said "start a client: am start
// --client=electron", which cannot help: there is nothing to open. Both now say
// the app has no UI and name what does work (am state / am dispatch).
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { scaffold } from "../src/am/am-cmd-create.ts";
import { missingUiEntry, waitClientMs } from "../src/am/am-cmd-inspect.ts";
import { AIO_ENTRY_PATHS } from "../src/entries.ts";
import { spec } from "./module-spec-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const REAL_DENO_DIR = Deno.env.get("DENO_DIR") ??
  join(Deno.env.get("HOME") ?? "/tmp", ".cache", "deno");
const dec = new TextDecoder();

Deno.test("missingUiEntry: only a UI entry that does not exist", async () => {
  const dir = await tempDir("aio-no-ui-unit-");
  try {
    const gone = join(dir, "src", "App.tsx");
    const err = (p: string) =>
      `surface: failed to import UI entry ${p}: TypeError: Module not found "file://${p}".`;
    assertEquals(missingUiEntry(err(gone)), gone);
    // App.tsx exists, one of ITS imports is missing: the real error stands.
    const here = join(dir, "App.tsx");
    await Deno.writeTextFile(here, "");
    assertEquals(missingUiEntry(err(here)), null);
    assertEquals(missingUiEntry("no UI client connected"), null);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("waitClientMs: absent = 0, bare = 10s, a bad value is refused", () => {
  assertEquals(waitClientMs([]), { ok: true, value: 0 });
  assertEquals(waitClientMs(["--wait-client"]), { ok: true, value: 10_000 });
  assertEquals(waitClientMs(["x", "--wait-client=250"]), {
    ok: true,
    value: 250,
  });
  for (const bad of ["--wait-client=", "--wait-client=-1", "--wait-client=x"]) {
    assertEquals(waitClientMs([bad]).ok, false, bad);
  }
});

Deno.test("am surface / am trigger on a cli app say it has no UI", async () => {
  const name = "aio-no-ui-probe";
  const dir = await tempDir("aio-no-ui-app-");
  const home = join(dir, "home");
  await Deno.mkdir(home);
  const cli = scaffold(name, "cli", true, "cli");
  for (const [rel, content] of Object.entries(cli)) {
    if (rel === "deno.json") continue;
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      ...JSON.parse(cli["deno.json"]!),
      imports: Object.fromEntries(
        Object.entries(AIO_ENTRY_PATHS).map((
          [k, v],
        ) => [k, `${spec(ROOT)}/${v}`]),
      ),
    }),
  );
  const env = { HOME: home, XDG_RUNTIME_DIR: home, DENO_DIR: REAL_DENO_DIR };
  const run = async (args: string[]) => {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", ...args],
      cwd: dir,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { code: r.code, text: dec.decode(r.stdout) + dec.decode(r.stderr) };
  };
  const serve = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-check", "src/app.ts", "serve"],
    cwd: dir,
    env,
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    let up = { code: 1, text: "" };
    for (let i = 0; i < 120 && up.code !== 0; i++) {
      up = await run(["src/app.ts", "list"]);
      if (up.code !== 0) await new Promise((r) => setTimeout(r, 250));
    }
    assertEquals(up.code, 0, `the server never came up:\n${up.text}`);
    const am = join(ROOT, "src/am.ts");
    for (
      const args of [
        [am, "surface", `--app=${name}`],
        [am, "trigger", `--app=${name}`, "App:AddButton", "click"],
      ]
    ) {
      const r = await run(args);
      assertEquals(r.code, 1, r.text);
      assertStringIncludes(r.text, "this app has no UI");
      assertStringIncludes(r.text, "am dispatch");
      assert(!r.text.includes("Module not found"), r.text);
      assert(!r.text.includes("--client=electron"), r.text);
    }
    // `--wait-client=ms` waits that long for a UI client before answering
    // (a page mid-reload has none for a moment); without it, no wait.
    const t0 = Date.now();
    const waited = await run([
      am,
      "trigger",
      `--app=${name}`,
      "--wait-client=1500",
      "App:AddButton",
      "click",
    ]);
    assertEquals(waited.code, 1, waited.text);
    assertStringIncludes(waited.text, "this app has no UI");
    assert(Date.now() - t0 >= 1500, `answered in ${Date.now() - t0}ms`);
  } finally {
    try {
      serve.kill("SIGTERM");
    } catch { /* gone */ }
    await serve.status;
    await dropTempDir(dir);
  }
});
