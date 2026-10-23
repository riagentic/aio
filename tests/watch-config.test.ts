// `aio.run({ watch })` — the cheap escape hatch from a reload that costs real
// money.
//
// Dev watches the whole app directory, so a `deno fmt` over the repo triggered
// full reloads repeatedly (report 7 §3). aio starts from a good position — cell
// state lives on the server and survives a reload — but "what is lost is small"
// included 760 MB of GPU weights, an embedded `<webview>`'s logged-in session,
// and a wallet's unlock.
//
// `watch: ["src/ui"]` narrows it; `watch: false` turns it off. One line either
// way, against a `patch` signal that is a much larger piece of work.
import { assert, assertEquals } from "@std/assert";
import { createFileWatcher } from "../src/server/server-watcher.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { CONFIG_DOCS } from "../src/server/config.ts";
import { join, resolve } from "@std/path";

// deno-lint-ignore no-explicit-any
type D = any;

const deps = (dir: string, watch?: false | string[]) => {
  const said: string[] = [];
  return {
    said,
    opts: {
      absBaseDir: dir,
      importMapObj: {},
      watch,
      debug: (m: string) => said.push(m),
      broadcastWs: () => {},
    } as D,
  };
};

Deno.test("watch: false never opens a watcher at all", async () => {
  const dir = await tempDir("watch-off-");
  try {
    const { said, opts } = deps(dir, false);
    const w = createFileWatcher(opts);
    const started = w.start();
    assertEquals(started, false, "the watcher started despite `watch: false`");
    // Turned off by not opening it, never by ignoring its events: the process
    // must hold no file handles for a feature nobody asked for.
    assert(
      said.some((m) => m.includes("disabled by `watch: false`")),
      `it must say so: ${said.join(" | ")}`,
    );
    w.shutdown();
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("watch: [paths] narrows what is watched", async () => {
  const dir = await tempDir("watch-narrow-");
  try {
    await Deno.mkdir(`${dir}/src/ui`, { recursive: true });
    await Deno.mkdir(`${dir}/models`, { recursive: true });
    const { opts } = deps(dir, ["src/ui"]);
    const w = createFileWatcher(opts);
    assertEquals(w.start(), true);
    // The narrowing is the whole feature: an edit under `models/` — the 760 MB
    // the report was reloading — must not reach the watcher.
    w.shutdown();
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("no `watch` key behaves exactly as before", async () => {
  const dir = await tempDir("watch-default-");
  try {
    const { opts } = deps(dir, undefined);
    const w = createFileWatcher(opts);
    assertEquals(w.start(), true, "the default must still watch the app dir");
    w.shutdown();
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("`watch` is a documented, discoverable config key", () => {
  // A config key nobody can find is a feature only its author can use — which
  // is this round's meta-finding, and the reason the reporter hand-rolled a
  // workaround instead.
  const row = (CONFIG_DOCS as Record<string, [string, string]>).watch;
  assert(row, "watch is missing from CONFIG_DOCS");
  assert(
    String(row[1]).includes("false"),
    `the doc line must name the off switch: ${row.join(" ")}`,
  );
});

Deno.test("--no-watch and --watch=… reach the config, and beat it", async () => {
  // A flag is a decision about THIS run; a config value is the app's standing
  // preference. Both spellings of "off" are accepted, because `--no-x` and
  // `--x=false` are each the obvious one to somebody and refusing either
  // teaches nothing.
  const { parseCli } = await import("../src/server/aio-cli.ts");
  assertEquals(parseCli(["--no-watch"]).watch, false);
  assertEquals(parseCli(["--watch=false"]).watch, false);
  assertEquals(parseCli(["--watch=src/ui"]).watch, ["src/ui"]);
  assertEquals(parseCli(["--watch=src/ui, src/style.css"]).watch, [
    "src/ui",
    "src/style.css",
  ]);
  assertEquals(
    parseCli([]).watch,
    undefined,
    "absent means the config decides",
  );

  // An empty list is a typo, not "watch nothing" — silently watching nothing
  // is indistinguishable from the watcher being broken.
  let threw = "";
  try {
    parseCli(["--watch="]);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(threw.includes("--watch"), `an empty list must be refused: ${threw}`);
});

Deno.test("am help names --cdp and --watch under dev", async () => {
  // The reporter wrote a launcher shim exploiting $ELECTRON_PATH to get a CDP
  // port, because `--cdp` already existed and could not be found (report 7 §4).
  // A second spelling would contradict "one vocabulary"; being findable is the
  // fix.
  const help = await Deno.readTextFile(
    new URL("../src/am/am-help-text.ts", import.meta.url),
  );
  assert(/dev --cdp\[=PORT\]/.test(help), "the dev help must name --cdp");
  assert(
    /DEVTOOLS \/ INSPECT \/ DEBUG/.test(help),
    "…with the words someone would grep for, which is how it was missed",
  );
  assert(/dev --watch=false/.test(help));
});

Deno.test("end to end: `watch` is accepted by a real boot, and reaches the watcher", async () => {
  // Two halves, because `watch` crosses four types on its way from `aio.run()`
  // to `createFileWatcher`, and a correctly written watcher wired to nothing
  // passes every unit test above.
  const { aio, cell } = await import("../mod.ts");
  const { freePort } = await import("../src/testing/server-test.ts");
  const dir = await tempDir("watch-e2e-");
  const c = cell("watchcell", { state: { n: 0 }, methods: {} } as D);
  // 1. The config validator accepts it. An unknown key EXITS the process, so
  //    a boot that returns at all is the assertion.
  const app = await aio.run({
    cells: [c],
    appId: `watche2e-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port: freePort(),
    baseDir: dir,
    watch: ["src/ui"],
  } as D);
  try {
    assert(app, "aio.run({ watch }) did not return");
  } finally {
    await app.close();
    await dropTempDir(dir);
  }

  // 2. The server hands it to the watcher, with the CLI flag winning. This is
  //    the hop a unit test cannot see.
  const src = await Deno.readTextFile(
    new URL("../src/server/aio-server.ts", import.meta.url),
  );
  assert(
    /watch: deps\.cliWatch \?\? config\.watch/.test(src),
    "the server must pass `watch` to the watcher, CLI first — otherwise the " +
      "config key is accepted and does nothing",
  );
});

// `--watch=src/ui,src/style.css` is the CLI's own example, typed from the
// project root of an app whose app dir IS `src/`: it resolved to `src/src/ui`,
// and one missing path failed the whole watch ("hot reload disabled:
// NotFound: No path was found", naming nothing). Found in the folder above
// now; a path found nowhere is named and skipped.
Deno.test("watch: [paths] from the project root work; a missing one is named, not fatal", async () => {
  const dir = await tempDir("watch-root-rel-");
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  try {
    await Deno.mkdir(`${dir}/src/ui`, { recursive: true });
    let roots: readonly string[] = [];
    const { opts } = deps(`${dir}/src`, ["src/ui", "no-such-dir"]);
    opts.savedBeforeWatch = (r: readonly string[]) => {
      roots = r;
      return [];
    };
    const w = createFileWatcher(opts);
    assertEquals(w.start(), true, "one bad path must not disable the watch");
    w.shutdown();
    assertEquals(roots, [join(dir, "src", "ui")]);
    assert(
      warns.some((m) => m.includes('"no-such-dir" does not exist')),
      `the missing path must be named: ${warns.join(" | ")}`,
    );
  } finally {
    console.warn = realWarn;
    await dropTempDir(dir);
  }
});

// A listed FILE was watched by its inode: an atomic save (temp file renamed
// over it — vim, VS Code, `sed -i`, formatters) replaces the inode, so the
// first save reloaded and every later one was never heard.
Deno.test("watch: a listed file keeps reloading across atomic saves", async () => {
  const dir = await tempDir("watch-file-atomic-");
  const css = `${dir}/style.css`;
  await Deno.writeTextFile(css, "a{}");
  const sent: string[] = [];
  const { opts } = deps(dir, ["style.css"]);
  opts.broadcastWs = (m: string) => sent.push(m);
  opts.graphTimeoutMs = 0;
  const w = createFileWatcher(opts);
  const info = console.info;
  console.info = () => {};
  try {
    assertEquals(w.start(), true);
    for (let i = 0; i < 3; i++) {
      await Deno.writeTextFile(`${dir}/.tmp-${i}`, `a{color:#${i}${i}${i}}`);
      await Deno.rename(`${dir}/.tmp-${i}`, css);
      const want = i + 1;
      for (let t = 0; t < 40 && sent.length < want; t++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals(sent.length, want, `save ${want} was not heard`);
    }
  } finally {
    console.info = info;
    w.shutdown();
    await dropTempDir(dir);
  }
});

// `--watch=src/App.tsx` printed "live reload watching <the whole app dir>":
// an edit to another file then did not reload, and the log said it should.
Deno.test("watch: [paths] — the start line names what is watched, not the app dir", async () => {
  const dir = await tempDir("watch-said-");
  await Deno.writeTextFile(`${dir}/App.tsx`, "export default () => null;");
  const infos: string[] = [];
  const info = console.info;
  console.info = (...a: unknown[]) => infos.push(a.join(" "));
  const { opts } = deps(dir, ["App.tsx"]);
  const w = createFileWatcher(opts);
  try {
    assertEquals(w.start(), true);
    const line = infos.find((m) => m.includes("live reload watching"));
    assert(line?.includes(`only ${resolve(dir, "App.tsx")}`), `said: ${line}`);
  } finally {
    console.info = info;
    w.shutdown();
    await dropTempDir(dir);
  }
});

// Every listed path missing: "live reload watching only " — with nothing
// after it — read as if reload were on.
Deno.test("watch: [paths] that all are missing — said as watching NOTHING", async () => {
  const dir = await tempDir("watch-none-");
  const lines: string[] = [];
  const orig = { info: console.info, warn: console.warn };
  console.info = (...a: unknown[]) => lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  const { opts } = deps(dir, ["nope.tsx"]);
  const w = createFileWatcher(opts);
  try {
    w.start();
    assert(
      lines.some((m) => m.includes("live reload watches NOTHING")),
      lines.join("\n"),
    );
    assertEquals(lines.some((m) => /watching only\s*$/.test(m)), false);
  } finally {
    console.info = orig.info;
    console.warn = orig.warn;
    w.shutdown();
    await dropTempDir(dir);
  }
});
