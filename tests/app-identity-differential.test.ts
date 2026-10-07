// One app, ONE id — in dev and once compiled.
//
// A compiled binary must never read the cwd's deno.json (it would adopt an
// unrelated project's identity), so it infers its appId from its own filename —
// which the BUILD chose. That makes "name the binary" and "resolve the appId"
// one decision, and for a long time it was two: the build read
// `title ?? basename(root)` and ignored `appId` entirely. A deno.json with
// `appId: "wallet"` in a directory called `thing` was `~/.wallet` in dev and
// `~/.thing` compiled — the data directory MOVED when you compiled, which is
// exactly the asterisk `app-dirs.ts` promises does not exist.
//
// Dev had the mirror-image bug: it read deno.json from the launch CWD only, so
// the same project was a different app depending on where `deno run` started.
// Dev is therefore driven here the way it runs — a real entry inside the
// project, launched from an UNRELATED cwd — and resolves THE project rule
// (`projectAppId`) the build names the binary with.
//
// This is a DIFFERENTIAL test, not a pair of unit tests: it runs both resolvers
// over the same project shapes and fails on any disagreement. Extend the shapes
// when the identity chain grows — never hand-reason about equivalence.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basename, fromFileUrl, join } from "@std/path";
import { spec } from "./module-spec-helper.ts";
import {
  appIdFromConfig,
  projectAppId,
  slugify,
} from "../src/server/single-instance-lock.ts";

const AIO_ROOT = fromFileUrl(new URL("..", import.meta.url));

/** What a compiled artifact ends up with: the build names the binary, and
 *  `resolveAppId` slugifies that name out of the `deno-compile-<name>` segment
 *  of the binary's VFS path. Mirrors build-config.ts's `defaultName`. */
function compiledAppId(
  cfg: Record<string, unknown> | null,
  root: string,
): string {
  const binaryName = projectAppId(root, cfg);
  return slugify(binaryName); // what the compiled binary infers from its name
}

/** What a dev run ends up with, driven through the REAL resolver: the
 *  project's declared entry (the default `src/app.ts` — what the build
 *  compiles), launched from a cwd that is NOT the project. */
async function devAppId(
  cfg: Record<string, unknown> | null,
  dir: string,
): Promise<string> {
  if (cfg) {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(cfg));
  }
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  const entry = join(dir, "src", "app.ts");
  await Deno.writeTextFile(
    entry,
    `import { resolveAppId } from ${
      JSON.stringify(
        spec(join(AIO_ROOT, "src/server/single-instance-lock.ts")),
      )
    };\nconsole.log("IDPROBE " + resolveAppId());\n`,
  );
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `--config=${join(AIO_ROOT, "deno.json")}`, entry],
    cwd: AIO_ROOT, // a foreign project with an identity of its own ("aio")
    // Homes are looked at (legacyIdFallback) — never the real HOME's.
    env: { AIO_APPS_DIR: join(dir, "apps") },
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
  return line.slice("IDPROBE ".length).trim();
}

const SHAPES: Array<{ what: string; cfg: Record<string, unknown> }> = [
  { what: "scaffold default (title only)", cfg: { title: "Wallet" } },
  { what: "title needing a slug", cfg: { title: "My Wallet!" } },
  {
    what: "explicit appId — the one that used to be ignored",
    cfg: { appId: "wallet" },
  },
  {
    what: "appId AND title disagree — appId wins, in both",
    cfg: { appId: "wallet", title: "My Wallet" },
  },
  { what: "jsr name only", cfg: { name: "@me/wallet" } },
  {
    what: "name + title — title wins, in both",
    cfg: { name: "@me/wallet", title: "Ledger" },
  },
  {
    what: "appId beats both",
    cfg: { appId: "vault", name: "@me/wallet", title: "Ledger" },
  },
  // No identity field: both fall back to the PROJECT folder's name — dev used
  // to take the launch cwd's deno.json (or the entry's folder) instead.
  { what: "no identity field — the project folder's name", cfg: {} },
];

Deno.test("app identity: dev and compiled resolve the SAME id", async (t) => {
  for (const { what, cfg } of SHAPES) {
    await t.step(what, async () => {
      // The directory name deliberately matches NOTHING in the config: a rule
      // that quietly falls back to it is the bug this test exists for.
      const dir = Deno.makeTempDirSync({ prefix: "aio-identity-thing-" });
      try {
        const dev = await devAppId(cfg, dir);
        const compiled = compiledAppId(cfg, dir);
        assertEquals(
          compiled,
          dev,
          `${what}: dev=${dev} compiled=${compiled} — the data directory ` +
            `would move when this app is compiled`,
        );
      } finally {
        Deno.removeSync(dir, { recursive: true });
      }
    });
  }
});

Deno.test("app identity: the compiled binary's NAME is the app's id", () => {
  // Not a coincidence to preserve by accident — `--print-app-tmpdir` and every
  // "where is my data" answer depend on it.
  for (const { cfg } of SHAPES) {
    const binaryName = appIdFromConfig(cfg);
    if (binaryName === null) continue; // named by its folder — not a config id
    assertEquals(
      slugify(binaryName),
      binaryName,
      "the binary name is already an id",
    );
  }
});

Deno.test("appIdFromConfig: the chain, and nothing to infer", () => {
  assertEquals(appIdFromConfig({ appId: "A", title: "B", name: "@x/c" }), "a");
  assertEquals(appIdFromConfig({ title: "B", name: "@x/c" }), "b");
  assertEquals(appIdFromConfig({ name: "@x/c" }), "c");
  assertEquals(appIdFromConfig({}), null);
  assertEquals(appIdFromConfig(null), null);
  assertEquals(appIdFromConfig(undefined), null);
});

Deno.test("app identity: the build uses the SHARED decider, not its own copy", async () => {
  // The differential above mirrors the build's rule; a mirror only proves
  // anything while the original still points at the same function. This is the
  // half that fails when build-config.ts grows a second chain of its own.
  const src = await Deno.readTextFile(
    join(import.meta.dirname ?? ".", "..", "src", "build", "build-config.ts"),
  );
  assertStringIncludes(
    src,
    "projectAppId(\n    root,\n    mainConfig",
    "the binary name must come from the shared project rule (projectAppId)",
  );
  assert(
    !/slugify\(\s*appTitle\s*\?\?/.test(src),
    "the build must not resolve identity from `title` on its own again",
  );
});
