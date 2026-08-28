// share.test.ts — the sanctioned workspace share (deno.json `share`).
//
// Two apps in one repo, one `shared/`. The declaration is ONE fact read by
// both worlds: the dev server serves `/<basename>/…` from it, the bundler
// resolves the same import to the same directory. What stays refused: a share
// outside the repository, one that does not exist, an UNDECLARED symlink out
// of the app root, and a symlink out of the share itself.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  matchShare,
  repoRootOf,
  resolveShare,
} from "../src/server/app-dirs.ts";
import {
  createStaticHandler,
  type StaticDeps,
} from "../src/server/server-static.ts";

const ROOT = new URL("..", import.meta.url).pathname;

// ── the resolver ─────────────────────────────────────────────────────────────

Deno.test("share: resolves to /<basename> inside the repo; refuses missing, escaping and colliding entries", () => {
  const dirs = new Set([
    "/repo/shared",
    "/repo/lib/shared",
    "/repo/apps/a",
    "/elsewhere/shared",
  ]);
  const probe = {
    isDirectory: (p: string) => dirs.has(p),
    realPath: (p: string) => p,
    repoRoot: "/repo",
  };
  assertEquals(resolveShare("/repo/apps/a", undefined, probe), []);
  assertEquals(resolveShare("/repo/apps/a", ["../../shared"], probe), [
    { prefix: "/shared", dir: "/repo/shared", declared: "../../shared" },
  ]);

  const refuse = (raw: unknown) => {
    let msg = "";
    try {
      resolveShare("/repo/apps/a", raw, probe);
    } catch (e) {
      msg = String(e);
    }
    assert(msg, `expected a refusal for ${JSON.stringify(raw)}`);
    return msg;
  };
  assertStringIncludes(refuse(["../../nope"]), "is not a directory");
  assertStringIncludes(refuse(["../../nope"]), "/repo/nope");
  const out = refuse(["../../../elsewhere/shared"]);
  assertStringIncludes(out, "OUTSIDE the repository root /repo");
  const dup = refuse(["../../shared", "../../lib/shared"]);
  assertStringIncludes(dup, 'would both be served as "/shared/');
  assertStringIncludes(refuse("../shared"), "must be an array");
  assertStringIncludes(refuse([""]), "must be an array");

  // A symlink INSIDE the repo that points OUT is refused by its real path.
  const real = {
    ...probe,
    realPath: (p: string) => p === "/repo/shared" ? "/elsewhere/shared" : p,
  };
  assertStringIncludes(
    (() => {
      try {
        resolveShare("/repo/apps/a", ["../../shared"], real);
        return "";
      } catch (e) {
        return String(e);
      }
    })(),
    "OUTSIDE the repository root",
  );

  // Matching is by prefix + "/", never by string prefix alone.
  const shares = resolveShare("/repo/apps/a", ["../../shared"], probe);
  assertEquals(matchShare(shares, "/shared/x/y.ts"), {
    share: shares[0]!,
    rel: "x/y.ts",
  });
  assertEquals(matchShare(shares, "/sharedx/y.ts"), null);
  assertEquals(matchShare(shares, "/other/y.ts"), null);
});

Deno.test("share: the repository root is the nearest .git, else the project root itself", () => {
  const has = new Set(["/repo/.git"]);
  assertEquals(repoRootOf("/repo/apps/a/src", (p) => has.has(p)), "/repo");
  assertEquals(repoRootOf("/repo", (p) => has.has(p)), "/repo");
  assertEquals(repoRootOf("/lonely/app", () => false), "/lonely/app");
});

// ── the dev server ───────────────────────────────────────────────────────────

function deps(over: Partial<StaticDeps>): StaticDeps {
  return {
    prod: false,
    debug: () => {},
    title: "T",
    absBaseDir: "/tmp",
    absDistDir: null,
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    getVitalsExtra: () => ({ payloadStats: new Map(), clientBackpressure: {} }),
    getTrojanDeps: () => ({}),
    ...over,
  };
}

Deno.test("share: the dev server serves a declared share, still refuses an undeclared symlink out of the app root, and a symlink out of the share", async () => {
  const repo = await Deno.makeTempDir({ prefix: "aio-share-repo-" });
  const outside = await Deno.makeTempDir({ prefix: "aio-share-outside-" });
  try {
    await Deno.mkdir(join(repo, ".git"));
    const app = join(repo, "apps", "a", "src");
    await Deno.mkdir(app, { recursive: true });
    await Deno.mkdir(join(repo, "shared"));
    await Deno.writeTextFile(join(repo, "shared", "util.css"), "/* shared */");
    await Deno.writeTextFile(join(outside, "secret.css"), "/* outside */");
    // Undeclared: a symlink from the app root to somewhere outside it.
    await Deno.symlink(outside, join(app, "linked"));
    // Declared share, but a symlink INSIDE it escapes the repo.
    await Deno.symlink(outside, join(repo, "shared", "escape"));

    const share = resolveShare(join(repo, "apps", "a"), ["../../shared"]);
    const { serveStatic } = createStaticHandler(
      deps({ absBaseDir: app, share }),
    );

    const ok = await serveStatic("/shared/util.css");
    assertEquals(ok.status, 200);
    assertEquals(await ok.text(), "/* shared */");

    // The undeclared symlink out of the app root: refused, as before.
    const linked = await serveStatic("/linked/secret.css");
    assertEquals(linked.status, 403);
    await linked.body?.cancel();

    // A symlink out of the SHARE: the share is a root, and roots contain.
    const escape = await serveStatic("/shared/escape/secret.css");
    assertEquals(escape.status, 403);
    await escape.body?.cancel();

    // Traversal out of the share: refused.
    const up = await serveStatic("/shared/../apps/a/src/App.tsx");
    assert(up.status === 403 || up.status === 404, String(up.status));
    await up.body?.cancel();

    // Without the declaration nothing under /shared is served.
    const undeclared = createStaticHandler(deps({ absBaseDir: app }));
    const none = await undeclared.serveStatic("/shared/util.css");
    assert(none.status !== 200, `served an undeclared share: ${none.status}`);
    await none.body?.cancel();
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

// ── the bundler ──────────────────────────────────────────────────────────────

/** A minimal real repo: `.git`, `shared/`, and an app under `apps/a` whose
 *  UI imports from the share. Bundled by the real `runBundle` in a subprocess
 *  (it exits the process on refusal). */
async function makeRepo(opts: { share?: string[]; importPath: string }) {
  const repo = await Deno.makeTempDir({ prefix: "aio-share-bundle-" });
  await Deno.mkdir(join(repo, ".git"));
  await Deno.mkdir(join(repo, "shared"));
  await Deno.writeTextFile(
    join(repo, "shared", "greet.ts"),
    `export const GREETING = "SHARED_${"MARK"}_OK";`,
  );
  const app = join(repo, "apps", "a");
  await Deno.mkdir(join(app, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify({
      title: "Share Probe",
      nodeModulesDir: "auto",
      ...(opts.share ? { share: opts.share } : {}),
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "aio",
        lib: ["deno.ns", "dom", "dom.iterable"],
      },
      imports: {
        "aio": `${ROOT}mod.ts`,
        "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
        "immer": "npm:immer@10.2.0",
      },
    }),
  );
  await Deno.symlink(`${ROOT}node_modules`, join(app, "node_modules"));
  await Deno.writeTextFile(
    join(app, "src", "App.tsx"),
    `import { GREETING } from "${opts.importPath}";
export default function App() { return <p>{GREETING}</p>; }`,
  );
  return { repo, app };
}

async function bundle(app: string) {
  const runner = join(app, ".aio-build", "runner.ts");
  await Deno.mkdir(join(app, ".aio-build"), { recursive: true });
  await Deno.writeTextFile(
    runner,
    `import { runBundle } from "${ROOT}src/build/build-bundle.ts";
import { resolveAppDir } from "${ROOT}src/build/build-config.ts";
const root = ${JSON.stringify(app)};
const mainConfig = JSON.parse(await Deno.readTextFile(root + "/deno.json"));
const configEntry = mainConfig.entry ?? "src/app.ts";
await runBundle({
  root, dist: root + "/dist", out: root + "/dist/app.js",
  frameworkSrcDir: ${JSON.stringify(ROOT + "src")},
  isRemote: false, doAndroid: false, doForce: true,
  configEntry, appDir: resolveAppDir(root, configEntry), uiEntry: "App.tsx",
  // deno-lint-ignore no-explicit-any
} as any, mainConfig);
`,
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", runner],
    cwd: app,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return {
    code: out.code,
    stderr: d.decode(out.stderr) + d.decode(out.stdout),
    js: await Deno.readTextFile(join(app, "dist", "app.js")).catch(() => ""),
  };
}

Deno.test({
  name:
    "share: a bundled import from a declared share resolves — the same /shared/… spelling the dev server serves",
  fn: async () => {
    const { repo, app } = await makeRepo({
      share: ["../../shared"],
      importPath: "/shared/greet.ts",
    });
    try {
      const r = await bundle(app);
      assertEquals(r.code, 0, r.stderr);
      assertStringIncludes(r.js, "SHARED_MARK_OK");
    } finally {
      await Deno.remove(repo, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "share: an undeclared /shared/… import is refused by name, with the deno.json line to add",
  fn: async () => {
    const { repo, app } = await makeRepo({ importPath: "/shared/greet.ts" });
    try {
      const r = await bundle(app);
      assertEquals(r.code, 1, "the build must refuse");
      assertStringIncludes(r.stderr, 'no share is declared for "/shared"');
      assertStringIncludes(r.stderr, '"share": ["../shared"]');
    } finally {
      await Deno.remove(repo, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "share: a share outside the repository, or one that does not exist, is refused before esbuild runs",
  fn: async () => {
    const outside = await Deno.makeTempDir({ prefix: "aio-share-out-" });
    const { repo, app } = await makeRepo({
      share: [outside],
      importPath: "/shared/greet.ts",
    });
    try {
      const r = await bundle(app);
      assertEquals(r.code, 1, "the build must refuse");
      assertStringIncludes(r.stderr, "OUTSIDE the repository root");

      const cfg = JSON.parse(await Deno.readTextFile(join(app, "deno.json")));
      cfg.share = ["../../nope"];
      await Deno.writeTextFile(join(app, "deno.json"), JSON.stringify(cfg));
      const r2 = await bundle(app);
      assertEquals(r2.code, 1, "the build must refuse");
      assertStringIncludes(r2.stderr, "is not a directory");
    } finally {
      await Deno.remove(repo, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  },
});
