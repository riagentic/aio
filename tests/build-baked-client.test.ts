// A compiled binary boots in the client its TARGET names, not the app's
// deno.json `"client"`.
//
// Field report (real Windows 11, 2026-09-17): an Electron app's `browser`
// target (`mushradar-0.1.2-windows.exe`) booted as `client electron
// (deno.json)`, found no Electron beside it, and started a silent ~100 MB
// download on the user's first double-click. Nothing was baked into the
// binary, so the app's own deno.json decided.
import { assert, assertEquals } from "@std/assert";
import {
  _compileArgv,
  bakedClientArgs,
  compileArgs,
} from "../src/build/build-compile.ts";
import { parseCli } from "../src/server/aio-cli.ts";

type Flag = "doElectron" | "doHeadless" | "doCli" | "doRemote";
const flags = (o: Partial<Record<Flag, boolean>>) => ({
  doElectron: false,
  doHeadless: false,
  doCli: false,
  doRemote: false,
  ...o,
});

Deno.test("baked client: each compiled target names its own client", () => {
  // `--compile` (browser)
  assertEquals(bakedClientArgs(flags({})), ["--client=browser"]);
  // `--compile --service --remote` (server-app): serves its page, opens nothing
  assertEquals(bakedClientArgs(flags({ doRemote: true })), [
    "--client=server-only",
  ]);
  assertEquals(bakedClientArgs(flags({ doElectron: true })), [
    "--client=electron",
  ]);
  assertEquals(bakedClientArgs(flags({ doHeadless: true })), [
    "--client=server-only",
  ]);
  assertEquals(
    bakedClientArgs(flags({ doHeadless: true, doRemote: true })),
    ["--client=server-only"],
  );
  // `cli` compiles the app's aio.run() entry…
  assertEquals(bakedClientArgs(flags({ doCli: true })), ["--client=cli"]);
  // …`cli-client` the app's OWN program, whose argv is its own.
  assertEquals(bakedClientArgs(flags({ doCli: true, doRemote: true })), []);
});

Deno.test("baked client: the args follow the entry, where deno compile bakes them", () => {
  const args = _compileArgv({
    hasDist: true,
    workerInclude: [],
    assets: [],
    excludes: [],
    out: "out/app",
    entry: "src/app.ts",
    runtimeArgs: ["--client=browser"],
  });
  assertEquals(args.slice(-2), ["src/app.ts", "--client=browser"]);
  // Without any, the entry stays last (the pre-existing shape) — and the
  // PUBLIC `compileArgs` never carries the build-only extras, so an app that
  // calls it sees the frozen signature.
  const none = compileArgs({
    hasDist: true,
    workerInclude: [],
    assets: [],
    excludes: [],
    out: "out/app",
    entry: "src/app.ts",
  });
  assertEquals(none.at(-1), "src/app.ts");
  assertEquals(
    none,
    _compileArgv({
      hasDist: true,
      workerInclude: [],
      assets: [],
      excludes: [],
      out: "out/app",
      entry: "src/app.ts",
    }),
  );
});

Deno.test("baked client: a Windows GUI exe gets --no-terminal and its icon", () => {
  const args = _compileArgv({
    hasDist: true,
    workerInclude: [],
    assets: [],
    excludes: [],
    out: "out/app.exe",
    entry: "src/app.ts",
    windowsGui: { icon: "out/app.ico" },
  });
  assert(args.includes("--no-terminal"), args.join(" "));
  assertEquals(args[args.indexOf("--icon") + 1], "out/app.ico");
  // Not on a non-Windows build: the public helper never emits either.
  assert(
    !compileArgs({
      hasDist: true,
      workerInclude: [],
      assets: [],
      excludes: [],
      out: "out/app",
      entry: "src/app.ts",
    }).includes("--no-terminal"),
  );
});

Deno.test("baked client: the user's own --client still wins (baked args come first)", () => {
  // deno compile prepends baked args to the user's argv.
  const argv = [...bakedClientArgs(flags({})), "--client=electron"];
  assertEquals(parseCli(argv).client, "electron");
  assertEquals(parseCli(bakedClientArgs(flags({}))).client, "browser");
});
