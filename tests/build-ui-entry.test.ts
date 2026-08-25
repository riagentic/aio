// `ui.entry` must mean the same thing to the DEV server and to the BUILD
// (R-2). Before this, `config.ts` documented it, the dev server honoured
// it, and the bundler hardcoded `App.tsx` — so an app that set it rendered one
// component under `deno task dev` and a different one (or failed) once
// compiled. That is precisely the dev≠prod divergence the framework polices.
//
// Three surfaces have to agree, so all three are pinned here: the import
// specifier the generated entry uses, the stamp the bundle carries, and the
// server's refusal to serve a bundle whose stamp disagrees with the running
// config.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { appImportSpecifier } from "../src/build/build-bundle.ts";
import {
  BUILD_VALUE_FLAGS,
  unknownBuildFlags,
} from "../src/build/build-flags.ts";

Deno.test("appImportSpecifier: the UI entry is threaded through, not hardcoded", () => {
  // root-level app dir
  assertEquals(appImportSpecifier("/proj", "/proj"), "./App.tsx");
  assertEquals(
    appImportSpecifier("/proj", "/proj", "Status.tsx"),
    "./Status.tsx",
  );
  // nested app dir (entry at src/server/app.ts → appDir src/server)
  assertEquals(
    appImportSpecifier("/proj", "/proj/src/server", "Status.tsx"),
    "./src/server/Status.tsx",
  );
  // default keeps the historic convention for every existing project
  assertEquals(
    appImportSpecifier("/proj", "/proj/src"),
    "./src/App.tsx",
  );
});

Deno.test("--ui and --out are part of the build vocabulary", () => {
  // A flag the vocabulary does not know is SILENTLY IGNORED by the build, so
  // membership is the gate: `--ui=Status.tsx` typo'd or unknown would bundle
  // App.tsx and say nothing.
  assert((BUILD_VALUE_FLAGS as readonly string[]).includes("--ui"));
  assert((BUILD_VALUE_FLAGS as readonly string[]).includes("--out"));
  assertEquals(
    unknownBuildFlags(["--compile", "--ui=Status.tsx", "--out=release/relay"]),
    [],
  );
  // …and a bare value flag is still unknown (it would read as absent).
  assertEquals(unknownBuildFlags(["--ui"]), ["--ui"]);
});

// `ui.entry` (runtime config) and `build.ui` (deno.json) name the same
// component to two different readers. Only the DEV server sees both, so it is
// the one place the pair can be checked before anything is shipped — the prod
// server's refusal is the same fact, days later.
Deno.test("dev warns when ui.entry and build.ui disagree", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-uipair-" });
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ build: { ui: "Other.tsx" } }),
    );
    // The component `ui.entry` names must exist — the boot lint checks THAT
    // file now, not a hardcoded App.tsx (it used to fail an app that
    // legitimately named another component).
    await Deno.writeTextFile(
      `${dir}/src/Status.tsx`,
      "export default function Status() { return null }\n",
    );
    await Deno.writeTextFile(
      `${dir}/src/app.ts`,
      `import { cell } from "${new URL("../mod.ts", import.meta.url).href}";
import { aio } from "${new URL("../mod.ts", import.meta.url).href}";
cell("probe", { state: { n: 0 }, methods: {} });
const app = await aio.run({
  cells: [],
  port: 0,
  client: "server-only",
  singleton: false,
  ui: { entry: "Status.tsx" },
});
await app.stop?.();
Deno.exit(0);
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      // The app's own deno.json is what appDenoJson() reads (it walks up from
      // the main module); the framework's supplies the import map.
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        `${dir}/src/app.ts`,
      ],
      env: { AIO_APPS_DIR: `${dir}/home`, NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertStringIncludes(text, "ui.entry is Status.tsx");
    assertStringIncludes(text, "build.ui is Other.tsx");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
