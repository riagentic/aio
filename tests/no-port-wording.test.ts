// Lines that told the reader something untrue about where the app is, or gave
// advice that could not work.
//
// 1. A Windows app on a named pipe logged "launching Electron (…, UDS)".
// 2. An app with NO TCP port (the desktop default: a local socket only) said
//    "server still running at http://localhost:<port>" when its window closed
//    under `--keep-server`, and "open it in a browser" when the window never
//    opened — for a port nothing was listening on.
// 3. The dev verdict printed esbuild's bare `Could not resolve "immer"`; the
//    build already said which command installs it.
// 4. That command — `deno install --entrypoint` — exits 0 and creates no
//    node_modules in a project whose deno.json sets no `nodeModulesDir`
//    (measured, Deno 2.9.7), so the advice now names the setting first.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, resolve } from "@std/path";
import {
  electronClosedPlan,
  electronLaunchFailurePlan,
  electronMissingLines,
  servedWhere,
} from "../src/server/aio-lifecycle.ts";
import { explainMissingPackage } from "../src/build/client-bundle.ts";
import { createProdGraphCheck } from "../src/server/graph-validator.ts";
import { ESBUILD_SPEC } from "../src/build/esbuild-shared.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const URL_ = "http://localhost:49208";
const SOCK = "/run/user/1000/aio/app-1a2b3c4d.sock";

Deno.test("no TCP port: a kept server is said by its socket, never by a URL", () => {
  const closed = { code: 0, signal: null };
  const kept = electronClosedPlan(closed, {
    keepServer: true,
    restarting: false,
    url: URL_,
    socketPath: SOCK,
  });
  assertEquals(
    kept.line,
    `electron closed (code 0) — server still running on its local socket ` +
      `${SOCK} (no TCP port; reach it with am)`,
  );
  assert(!kept.line.includes(URL_), kept.line);
  const failed = electronLaunchFailurePlan(
    new Error("no display"),
    URL_,
    false,
    SOCK,
  ).lines.join("\n");
  assertStringIncludes(failed, `on its local socket ${SOCK} (no TCP port;`);
  assert(!failed.includes(URL_) && !failed.includes("browser"), failed);
  assertStringIncludes(failed, "`am fix` installs a missing Electron.");
});

Deno.test("an app WITH a port: both lines are byte for byte what they were", () => {
  assertEquals(servedWhere(URL_), `at ${URL_}`);
  assertEquals(
    electronClosedPlan({ code: 0, signal: null }, {
      keepServer: true,
      restarting: false,
      url: URL_,
    }).line,
    `electron closed (code 0) — server still running at ${URL_}`,
  );
  assertEquals(
    electronLaunchFailurePlan(new Error("no display"), URL_).lines,
    [
      `electron: the desktop window could not be started — Error: no ` +
      `display. The server is still running at ${URL_}; open it in a ` +
      `browser, or run with --client=browser. \`am fix\` installs a missing ` +
      `Electron.`,
    ],
  );
});

Deno.test("missing Electron: a no-port app is named by its socket; an app with a port reads as it did", () => {
  assertEquals(
    electronMissingLines(URL_)[1],
    `install it with: deno task install:electron (then re-run). The ` +
      `server is up meanwhile at ${URL_} — open it yourself, or run with ` +
      `--client=browser if that is what you want.`,
  );
  const line = electronMissingLines(URL_, false, SOCK)[1]!;
  assertStringIncludes(
    line,
    `server is up meanwhile ${servedWhere(URL_, SOCK)}`,
  );
  assert(!line.includes(URL_) && !line.includes("open it yourself"), line);
});

Deno.test("the lifecycle passes the socket of a no-port app to both plans; the launch line names a pipe a pipe", async () => {
  const life = await Deno.readTextFile(`${ROOT}src/server/aio-lifecycle.ts`);
  assertStringIncludes(life, "socketPath: localSocket,");
  assertStringIncludes(life, "(e, url, windowless, localSocket)");
  assertStringIncludes(
    life,
    "const localSocket = noPort\n    ? udsHandle?.socketPath ?? deps.httpSocketPath\n    : undefined;",
  );
  const spawn = await Deno.readTextFile(
    `${ROOT}src/electron/electron-spawn.ts`,
  );
  assertStringIncludes(
    spawn,
    '? (isPipePath(uds.socketPath) ? "named pipe" : "UDS")',
  );
});

Deno.test("missing package: a project that sets no nodeModulesDir is told to set it first", () => {
  // Absolute on every OS (`C:\\proj\\app` on Windows): the walk up from `root`
  // hands the `config` seam RESOLVED directories, and a real caller's root is
  // absolute.
  const root = resolve("/proj", "app");
  const text = 'ERROR: Could not resolve "immer"';
  const none = () => false;
  const cmd = `run \`deno install --entrypoint src/App.tsx\` in ${root}`;
  // Declared: the line is what it always was.
  for (const mode of ["auto", "manual"]) {
    assertEquals(
      explainMissingPackage(
        text,
        root,
        "src/App.tsx",
        none,
        (d) => d === root ? { nodeModulesDir: mode } : null,
      ),
      `the package "immer" is not installed in ${
        join(root, "node_modules")
      } — ${cmd}, then build again`,
    );
  }
  // A package.json beside it: Deno creates node_modules without the setting.
  const pj = explainMissingPackage(
    text,
    root,
    "src/App.tsx",
    (p) => p === join(root, "package.json"),
    () => ({}),
  );
  assert(pj && !pj.includes("nodeModulesDir"), String(pj));
  // Absent, or "none": the setting first, in the project's own deno.json.
  for (const cfg of [{}, { nodeModulesDir: "none" }, null]) {
    const line = explainMissingPackage(
      text,
      root,
      "src/App.tsx",
      none,
      () => cfg,
    );
    assert(line, "explained");
    const add = line.indexOf(
      `add \`"nodeModulesDir": "auto"\` to ${join(root, "deno.json")}`,
    );
    assert(add > 0 && add < line.indexOf(`then ${cmd}`), line);
  }
  // A workspace member: the root declares it → nothing to add; the root does
  // not → the setting belongs in the ROOT's file (Deno ignores a member's).
  const ws = resolve("/proj");
  const declared = explainMissingPackage(
    text,
    root,
    "A",
    none,
    (d) => d === ws ? { workspace: ["app"], nodeModulesDir: "auto" } : {},
  );
  assert(declared && !declared.includes("nodeModulesDir"), String(declared));
  const undeclared = explainMissingPackage(
    text,
    root,
    "A",
    none,
    (d) => d === ws ? { workspace: ["app"] } : {},
  );
  assertStringIncludes(String(undeclared), `to ${join(ws, "deno.json")} (`);
  // Never above the repository the app lives in.
  const repo = explainMissingPackage(
    text,
    root,
    "A",
    (p) => p === join(root, ".git"),
    (d) => d === ws ? { nodeModulesDir: "auto" } : {},
  );
  assertStringIncludes(String(repo), `to ${join(root, "deno.json")} (`);
});

Deno.test({
  name:
    "dev verdict: an uninstalled package is said with the command, not only esbuild's line",
  sanitizeOps: false, // aio-ok: esbuild's service is a shared child stopped once per test
  sanitizeResources: false, // aio-ok: same service
  fn: async () => {
    const dir = await tempDir("aio-missing-pkg-");
    try {
      // No node_modules and no nodeModulesDir: the app's own import of a
      // package cannot be resolved from here.
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
          imports: {
            "aio": `${spec(ROOT)}mod.ts`,
            "aio/jsx-runtime": `${spec(ROOT)}src/jsx-runtime.ts`,
            "immer": "npm:immer@10.2.0",
            "aio-test-absent-pkg": "npm:aio-test-absent-pkg@1",
          },
        }),
      );
      await Deno.mkdir(`${dir}/.git`); // the walk stops at the project
      await Deno.writeTextFile(
        `${dir}/App.tsx`,
        `import { cell } from "aio";
import "aio-test-absent-pkg/sub.js";
export const c = cell("c", { state: { n: 0 }, methods: {} });
export default function App() { return <div>{c.n}</div>; }
`,
      );
      const judge = createProdGraphCheck({
        absBaseDir: dir,
        uiEntry: "App.tsx",
      });
      const { errors } = await judge("missing-pkg");
      const said = errors.map((e) => e.message).join("\n");
      assertStringIncludes(said, 'Could not resolve "aio-test-absent-pkg');
      assertStringIncludes(
        said,
        `the package "aio-test-absent-pkg" is not installed in ${dir}`,
      );
      assertStringIncludes(said, '"nodeModulesDir": "auto"');
      assertStringIncludes(said, "`deno install --entrypoint App.tsx`");
    } finally {
      await (await import(ESBUILD_SPEC)).stop();
      await dropTempDir(dir);
    }
  },
});
