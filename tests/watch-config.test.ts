// `aio.run({ watch })` — the cheap escape hatch from a reload that costs real
// money.
//
// Dev watches the whole app directory, so a `deno fmt` over the repo triggered
// full reloads repeatedly (watcher §3). aio starts from a good position — cell
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
  // port, because `--cdp` already existed and could not be found (watcher §4).
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
