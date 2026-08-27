// updates-rebuild.test.ts — taking an update from a repository, against a real
// local git repo and a real build. Nothing here is mocked: the clone, the
// build, the artifact discovery and the data-contract probe are the shipped
// code paths, driven end to end.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  findBuiltArtifact,
  rebuildFromGit,
} from "../src/server/updates-rebuild.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

async function git(args: string[], cwd: string): Promise<void> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  })
    .output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

/** A repository holding a tiny app whose `compile` task emits an executable
 *  that answers `--aio-data-contract` — the shape rebuildFromGit expects. */
async function repo(opts: { contract?: string; buildFails?: boolean } = {}) {
  const root = await Deno.makeTempDir({ prefix: "aio-git-src-" });
  const contract = opts.contract ??
    '{"schema":1,"cells":{"notes":{"version":1,"migratesFrom":1}}}';

  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      imports: { aio: "jsr:@riagentic/aio" },
      tasks: { compile: "deno run -A make.ts" },
    }),
  );
  await Deno.writeTextFile(
    join(root, "make.ts"),
    opts.buildFails
      ? `console.error("the app's own build blew up"); Deno.exit(3);`
      : `
const out = "dist/app";
await Deno.mkdir("dist", { recursive: true });
await Deno.writeTextFile(out, \`#!/bin/sh
if [ "$1" = "--aio-data-contract" ]; then echo '${contract}'; exit 0; fi
echo running
\`);
await Deno.chmod(out, 0o755);
`,
  );
  await git(["init", "-q", "-b", "main"], root);
  await git(["config", "user.email", "t@example.com"], root);
  await git(["config", "user.name", "t"], root);
  await git(["add", "."], root);
  await git(["commit", "-q", "-m", "first"], root);
  return root;
}

Deno.test("git rebuild: clones the ref, builds it, and reports the artifact + contract", async () => {
  const src = await repo();
  const work = await Deno.makeTempDir({ prefix: "aio-git-work-" });
  try {
    const r = await rebuildFromGit({
      source: src,
      ref: "main",
      workDir: work,
      log: silentLog,
    });
    assert(r.ok, r.ok ? "" : r.error);
    if (!r.ok) return;

    assert(/[0-9a-f]{40}/.test(r.sha), "reports the commit it built");
    assertStringIncludes(r.artifact, "dist/app");
    // The data gate's input, asked of the binary that was just built — a
    // repository has no signed manifest to carry the answer.
    assertEquals(r.contract?.cells.notes?.version, 1);
    assertEquals(r.contract?.cells.notes?.migratesFrom, 1);
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(work, { recursive: true });
  }
});

Deno.test("git rebuild: an unreadable data contract is NAMED, not swallowed", async () => {
  // It was swallowed. The gate then reported "not declared", whose standard
  // advice is "re-publish with `aio ship`" — nonsense for a repository, where
  // the answer comes from the binary that was just built. The commonest cause
  // is the app printing something (a banner, a warning) on stdout before aio
  // boots, and nothing said so.
  const src = await repo({ contract: "Starting up...\\n{ oops" });
  const work = await Deno.makeTempDir({ prefix: "aio-git-work-" });
  const lines: string[] = [];
  const log = {
    info: () => {},
    warn: (...a: unknown[]) => lines.push(a.map(String).join(" ")),
    error: () => {},
    debug: () => {},
  } as unknown as Log;
  try {
    const r = await rebuildFromGit({
      source: src,
      ref: "main",
      workDir: work,
      log,
    });
    assert(r.ok, r.ok ? "" : r.error);
    if (!r.ok) return;
    // The build still produced an artifact — the CONTRACT is what is unknown.
    assertEquals(r.contract, undefined);
    assert(r.contractError, "the reason is carried, not dropped");
    assertStringIncludes(r.contractError!, "--aio-data-contract");
    assertStringIncludes(r.contractError!, "not JSON");
    // …and the advice fits a repository, not a published release.
    assert(
      !/aio ship/.test(r.contractError!),
      `advice for a git source must not be "re-publish": ${r.contractError}`,
    );
    assertStringIncludes(r.contractError!, src);
    assert(
      lines.some((l) => l.includes("not JSON")),
      `it is said out loud: ${lines.join(" | ")}`,
    );
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(work, { recursive: true });
  }
});

Deno.test("git rebuild: a failing build reports the app's own reason", async () => {
  const src = await repo({ buildFails: true });
  const work = await Deno.makeTempDir({ prefix: "aio-git-work-" });
  try {
    const r = await rebuildFromGit({
      source: src,
      ref: "main",
      workDir: work,
      log: silentLog,
    });
    assertEquals(r.ok, false);
    // Not "build failed" with nothing to act on.
    if (!r.ok) assertStringIncludes(r.error, "blew up");
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(work, { recursive: true });
  }
});

Deno.test("git rebuild: a missing ref fails before anything is built", async () => {
  const src = await repo();
  const work = await Deno.makeTempDir({ prefix: "aio-git-work-" });
  try {
    const r = await rebuildFromGit({
      source: src,
      ref: "does-not-exist",
      workDir: work,
      log: silentLog,
    });
    assertEquals(r.ok, false);
    if (!r.ok) assertStringIncludes(r.error, "clone failed");
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(work, { recursive: true });
  }
});

Deno.test("git rebuild: a repo with no compile task says so instead of guessing", async () => {
  const src = await Deno.makeTempDir({ prefix: "aio-git-src-" });
  const work = await Deno.makeTempDir({ prefix: "aio-git-work-" });
  try {
    await Deno.writeTextFile(join(src, "deno.json"), '{"name":"x"}');
    await git(["init", "-q", "-b", "main"], src);
    await git(["config", "user.email", "t@example.com"], src);
    await git(["config", "user.name", "t"], src);
    await git(["add", "."], src);
    await git(["commit", "-q", "-m", "first"], src);

    const r = await rebuildFromGit({
      source: src,
      ref: "main",
      workDir: work,
      log: silentLog,
    });
    assertEquals(r.ok, false);
    if (!r.ok) assertStringIncludes(r.error, "compile");
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(work, { recursive: true });
  }
});

Deno.test("artifact discovery: by TIME, and an AppImage wins over a plain binary", async () => {
  // The same rule run.sh uses. A second copy of the framework's naming rules
  // here would go stale silently, so nothing is matched by name.
  const dir = await Deno.makeTempDir({ prefix: "aio-artifacts-" });
  try {
    const old = new Date(2020, 0, 1);
    const stale = join(dir, "stale-binary");
    await Deno.writeTextFile(stale, "");
    await Deno.chmod(stale, 0o755);
    await Deno.utime(stale, old, old);

    const marker = new Date(2021, 0, 1);

    // Non-executable and source files are never candidates.
    await Deno.writeTextFile(join(dir, "build.log"), "x");
    await Deno.writeTextFile(join(dir, "mod.ts"), "x");

    const plain = join(dir, "app");
    await Deno.writeTextFile(plain, "");
    await Deno.chmod(plain, 0o755);

    assertEquals(await findBuiltArtifact(dir, marker), plain);

    // The Electron target emits both; the AppImage is the one to install.
    const appimage = join(dir, "app-x86_64.AppImage");
    await Deno.writeTextFile(appimage, "");
    await Deno.chmod(appimage, 0o755);
    assertEquals(await findBuiltArtifact(dir, marker), appimage);

    // Nothing new since the marker ⇒ nothing to install.
    assertEquals(await findBuiltArtifact(dir, new Date(2030, 0, 1)), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
