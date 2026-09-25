// A compiled binary reads ITS OWN embedded config and serves ITS OWN embedded
// assets — from any cwd, under any file name, whatever the config's spelling.
//
// Two field bugs, one artifact:
//  1. `_embeddedDenoJson` (single-instance-lock.ts) read only `deno.json`, with
//     `JSON.parse`. A `deno.jsonc` app — or a `deno.json` with one comment —
//     found no identity inside its own binary and took the appId from the FILE
//     NAME: `dist/app-a1-2.3.2` ran as `app-a1-2-3-2`, in `~/.app-a1-2-3-2/`,
//     so every new version started from empty state.
//  2. `aio.run({ assets: { "/media": "./media" } })` resolved against the CWD
//     only. The build EMBEDS the folder, but a binary launched from anywhere
//     but its project directory never looked at that copy: every file 404'd.
//
// Real `deno compile`, real server, foreign cwd, sandboxed HOME — no mocks.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { assetIncludes } from "../src/build/build-compile.ts";
import { assetDirCandidates } from "../src/server/paths.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AIO_ROOT = join(import.meta.dirname!, "..");

const APP = `import { aio, cell } from "../dep/aio/mod.ts";
import { resolveAppId } from "../dep/aio/src/server/single-instance-lock.ts";
const c = cell("c", { state: { n: 0 }, methods: {} });
const port = Number(Deno.env.get("PROBE_PORT"));
await aio.run({
  cells: [c],
  client: "server-only",
  port,
  assets: { "/media": "./media" },
});
const get = async (f: string) => {
  const r = await fetch(\`http://127.0.0.1:\${port}/media/\${f}\`);
  return r.status + " " + (await r.text()).trim();
};
const r = await fetch(\`http://127.0.0.1:\${port}/media/x.txt\`);
console.log("PROBE " + JSON.stringify({
  id: resolveAppId(),
  status: r.status,
  body: (await r.text()).trim(),
  live: await get("live.txt"),
  shippedOnly: await get("shipped-only.txt"),
}));
Deno.exit(0);
`;

Deno.test({
  name:
    "compiled binary: a deno.jsonc app keeps its appId under a versioned file name, and serves its embedded assets from a foreign cwd",
  sanitizeResources: false, // aio-ok: compiled binaries run as child processes; their pipes and timers are not this test's
  sanitizeOps: false, // aio-ok: compiled binaries run as child processes; their pipes and timers are not this test's
  async fn() {
    const root = await tempDir("compiled-jsonc-");
    const sandbox = await tempDir("compiled-jsonc-home-");
    try {
      await Deno.mkdir(join(root, "src"));
      await Deno.mkdir(join(root, "media"));
      await Deno.mkdir(join(root, "dep"));
      await Deno.symlink(AIO_ROOT, join(root, "dep", "aio"));
      // A comment: exactly what plain JSON.parse refuses and Deno accepts.
      await Deno.writeTextFile(
        join(root, "deno.jsonc"),
        `{\n  // the app's identity\n  "appId": "wallet-x",\n  "version": "2.3.2",\n` +
          `  "assets": { "/media": "media" }\n}\n`,
      );
      await Deno.writeTextFile(join(root, "media", "x.txt"), "shipped\n");
      await Deno.writeTextFile(join(root, "media", "shipped-only.txt"), "s2\n");
      await Deno.writeTextFile(join(root, "src", "app.ts"), APP);

      // The build's OWN include list (config + declared asset dirs), plus the
      // db worker a binary always needs.
      const includes = await assetIncludes(root);
      const bin = join(root, "app-a1-2.3.2"); // a versioned install name
      const built = await new Deno.Command(Deno.execPath(), {
        args: [
          "compile",
          "-A",
          "--no-check",
          `--config=${join(AIO_ROOT, "deno.json")}`,
          ...includes,
          "--include",
          "dep/aio/src/db/db-worker.ts",
          "--output",
          bin,
          "src/app.ts",
        ],
        cwd: root,
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(built.success, new TextDecoder().decode(built.stderr));

      const cwd = join(sandbox, "elsewhere");
      await Deno.mkdir(cwd);
      const h = join(sandbox, "home");
      const env: Record<string, string> = {
        PATH: Deno.env.get("PATH") ?? "",
        HOME: h,
        AIO_HOME: join(h, "aio"),
        AIO_VERSIONS_DIR: join(h, "versions"),
        AIO_FEEDBACK_DIR: join(h, "feedback"),
        AIO_INSTALL_ROOT: join(h, "install"),
        AIO_APPS_DIR: join(h, "apps"),
        PROBE_PORT: String(freePort()),
      };
      const probe = async (cwd: string) => {
        const run = await new Deno.Command(bin, {
          cwd,
          env: { ...env, PROBE_PORT: String(freePort()) },
          clearEnv: true, // no DISPLAY / WAYLAND_DISPLAY, no real HOME
          stdout: "piped",
          stderr: "piped",
        }).output();
        const out = new TextDecoder().decode(run.stdout);
        const line = out.split("\n").find((l) => l.startsWith("PROBE "));
        assert(
          line,
          `no PROBE line (exit ${run.code})\n${out}\n${
            new TextDecoder().decode(run.stderr)
          }`,
        );
        return JSON.parse(line.slice(6));
      };
      const got = await probe(cwd);
      assertEquals(
        got.id,
        "wallet-x",
        "the embedded deno.jsonc decides the id — never the binary's file name",
      );
      assertEquals(
        { status: got.status, body: got.body },
        { status: 200, body: "shipped" },
        "the embedded /media copy is served from a foreign cwd",
      );

      // A live cwd folder WINS — what the running app wrote there is served,
      // never a stale build-time copy — and only a file it lacks falls back
      // to the embedded one.
      const live = join(sandbox, "live");
      await Deno.mkdir(join(live, "media"), { recursive: true });
      await Deno.writeTextFile(join(live, "media", "x.txt"), "live\n");
      await Deno.writeTextFile(join(live, "media", "live.txt"), "written\n");
      const g2 = await probe(live);
      assertEquals(
        { x: `${g2.status} ${g2.body}`, live: g2.live, only: g2.shippedOnly },
        { x: "200 live", live: "200 written", only: "200 s2" },
      );
    } finally {
      await dropTempDir(root);
      await dropTempDir(sandbox);
    }
  },
});

Deno.test("assetDirCandidates: compiled → the live cwd folder first, embedded copy after; otherwise the cwd alone", () => {
  const opts = { cwd: "/run/here", embeddedRoot: "/vfs/app" };
  assertEquals(
    assetDirCandidates("./media", { ...opts, compiled: true }),
    ["/run/here/media", "/vfs/app/media"],
  );
  assertEquals(
    assetDirCandidates("./media", { ...opts, compiled: false }),
    ["/run/here/media"],
  );
  assertEquals(
    assetDirCandidates("/abs/media", { ...opts, compiled: true }),
    ["/abs/media"],
  );
  assertEquals(
    assetDirCandidates("media", {
      ...opts,
      compiled: true,
      embeddedRoot: null,
    }),
    ["/run/here/media"],
  );
});

Deno.test("am fix: a deno.jsonc app's pinned version is advised on, not reported ok", async () => {
  // The version check read only `deno.json`: a `deno.jsonc` app had no version
  // at all, so a pinned (or refused) one there came back "ok".
  const dir = await tempDir("fix-jsonc-version-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.jsonc"),
      `{\n  // pinned on purpose\n  "name": "pinned",\n  "version": "1.0.0",\n` +
        `  "tasks": { "dev": "deno run -A src/app.ts" }\n}\n`,
    );
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      `import { aio } from "aio";\nawait aio.run({ ui: {} });\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        join(AIO_ROOT, "src", "am.ts"),
        "fix",
        "--dry-run",
        "--json",
      ],
      cwd: dir,
      env: {
        HOME: join(dir, "home"),
        AIO_HOME: join(dir, "home", "aio"),
        AIO_VERSIONS_DIR: join(dir, "home", "versions"),
        AIO_FEEDBACK_DIR: join(dir, "home", "feedback"),
        AIO_INSTALL_ROOT: join(dir, "home", "install"),
        AIO_APPS_DIR: dir,
        PATH: Deno.env.get("PATH") ?? "",
        DENO_DIR: Deno.env.get("DENO_DIR") ??
          join(Deno.env.get("HOME") ?? "", ".cache", "deno"),
      },
      stdout: "piped",
      stderr: "null",
    }).output();
    const r = JSON.parse(new TextDecoder().decode(out.stdout)) as {
      results: { name: string; outcome: string; note?: string }[];
    };
    const v = r.results.find((x) => x.name === "app version");
    assertEquals(v?.outcome, "advise", JSON.stringify(v));
    assert(v?.note?.includes("1.0.0 is a PIN"), v?.note);
  } finally {
    await dropTempDir(dir);
  }
});
