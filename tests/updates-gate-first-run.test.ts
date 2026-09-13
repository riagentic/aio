// updates-gate-first-run.test.ts — the data gate judges a FRESH install's data
// during its first run, not only from the second boot on.
//
// The gate was handed `migrationSummary.stored`: the cell versions found on
// disk AT BOOT. A fresh install has none, so for its entire first run the gate
// saw "nothing on disk to protect" and OFFERED a release that cannot migrate
// the v1 data that same run had already written. Restart the same install with
// the same data and the same release became "blocked". Measured through
// examples/updates: boot 1 `"kind":"offer"`, boot 2 `"kind":"blocked" … on disk
// v1`.
//
// A child process, like updates-boot-e2e.test.ts and for the same reason:
// `aio.run` turns updates off under `libraryMode`, which every in-process
// harness sets.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { freePort } from "../src/testing/server-test.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const platform = { os: Deno.build.os, arch: Deno.build.arch };

async function git(dir: string, ...args: string[]) {
  const r = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdout: "null",
    stderr: "piped",
  }).output();
  if (r.code !== 0) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`,
    );
  }
}

Deno.test({
  name:
    "updates gate: a fresh install's first run is not offered a release that cannot read its data",
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "aio-upd-first-run-" });
    const releases = join(root, "releases");
    // The installed build: `notes` v1, no onMigrate.
    await Deno.writeTextFile(
      join(root, "app.ts"),
      `
import { aio } from "${ROOT}mod.ts";
import { cell } from "${ROOT}src/state/cell-create.ts";
cell("notes", {
  version: 1,
  state: { items: [] as string[] },
  methods: { add(s: { items: string[] }, t: string) { s.items.push(t); } },
});
await aio.run({
  appId: "updates-gate-first-run",
  client: "server-only",
  updates: { source: "file://${releases}", channel: "prod", auto: false },
});
`,
    );
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ title: "updates-gate-first-run", version: "1.0" }),
    );
    await Deno.writeTextFile(
      join(root, ".gitignore"),
      "apps/\nreleases/\n.aio/\n",
    );
    await git(root, "init", "-q");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "one");

    // The release: `notes` v2 that migrates only from v2 — it cannot read v1.
    const version = "1.0.9";
    const dir = join(releases, "prod");
    await Deno.mkdir(dir, { recursive: true });
    const bytes = new TextEncoder().encode(`#!/bin/sh\necho ${version}\n`);
    const manifest = await buildShipManifest({
      name: "updates-gate-first-run",
      version,
      buildNumber: 9,
      binary: bytes,
      sources: [],
      sign: await generateSigningKey(),
      channel: "prod",
      target: "binary",
      platform,
      url: `app-${version}`,
      data: { schema: 1, cells: { notes: { version: 2, migratesFrom: 2 } } },
    });
    await Deno.writeFile(join(dir, `app-${version}`), bytes);
    await Deno.writeTextFile(
      join(dir, `${platform.os}-${platform.arch}.json`),
      JSON.stringify(manifest),
    );

    const port = freePort();
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "-c",
        `${ROOT}deno.json`,
        join(root, "app.ts"),
        `--port=${port}`,
      ],
      cwd: root,
      env: { AIO_APPS_DIR: join(root, "apps"), NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let out = "";
    const pump = async (s: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const c of s) out += dec.decode(c);
    };
    const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
    const base = `http://127.0.0.1:${port}/__aio/trojan`;
    const dispatch = async (type: string, payload?: unknown) => {
      const r = await fetch(`${base}/dispatch`, {
        method: "POST",
        headers: { "X-AIO": "1" },
        body: JSON.stringify(
          payload === undefined ? { type } : { type, payload },
        ),
      });
      return await r.text();
    };
    try {
      let up = false;
      for (let i = 0; i < 300 && !up; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/__aio/health`);
          await r.body?.cancel();
          up = r.ok;
        } catch { /* not listening yet */ }
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      assertEquals(up, true, `the app never served\n${out}`);

      // The first run writes v1 data…
      await dispatch("notes:add", { args: ["hello"] });
      await dispatch("updates:check");
      let u: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) {
        const st = await (await fetch(`${base}/state`)).json();
        u = st.updates;
        if (u.status !== "checking" && u.status !== "idle") break;
        await new Promise((res) => setTimeout(res, 50));
      }
      // …and a release that cannot read v1 is NOT offered over it.
      assertEquals(
        u.status,
        "blocked",
        `offered over v1 data it cannot migrate: ${JSON.stringify(u)}\n${out}`,
      );
      assertEquals(u.available, null);
      assertStringIncludes(
        JSON.stringify(u.blocked),
        "on disk v1",
      );
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
      }, 5000);
      await child.status;
      clearTimeout(t);
      await pumps;
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});
