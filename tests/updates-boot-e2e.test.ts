// tests/updates-boot-e2e.test.ts — the update feature through the REAL boot.
//
// Every other updates test drives `createUpdatesRuntime` directly, or installs
// a stub runtime under the cell. Both are the right shape for what they check
// — and neither can see the wiring between them. `aio.run` is what decides
// that `updates:` in a config becomes a registered cell, a resolved config, a
// runtime with the app's OWN name/version/data dir, and a cell whose state a
// client can read. That decision has no unit under it.
//
// This is the lesson alpha68 paid for: two sync bugs shipped in a release
// whose unit tests were green, because the boot path assembled the pieces
// differently than the units did. `tests/sync-migration-e2e.test.ts` closed
// that hole for sync; this closes it for updates.
//
// It has to be a CHILD PROCESS, not `testServer`: `aio.run` deliberately
// disables updates under `libraryMode` ("a test or a host app owns this
// process; nothing it did should replace a binary"), which every in-process
// harness sets. So the only way to observe the real wiring is to run a real
// app the way a user does, and ask it over its own control API.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import {
  type BuildVersion,
  readTreeFacts,
  resolveBuildVersion,
} from "../src/build/build-version.ts";
import { freePort } from "../src/testing/server-test.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const platform = { os: Deno.build.os, arch: Deno.build.arch };

/** An app that is a real aio app: one cell, updates configured, nothing else.
 *  `auto: false` — this test observes the OFFER, and an app that installed a
 *  new binary mid-test would be a different (and much worse) test.
 *
 *  No `appVersion` (retired in alpha70): the version is deno.json `version`
 *  (`major.minor`) plus the commit count, derived by the boot exactly as a
 *  build would derive it — see {@link project}. */
function appSource(releases: string, withUpdates: boolean): string {
  return `
import { aio } from "${ROOT}mod.ts";
import { cell } from "${ROOT}src/state/cell-create.ts";

cell("notes", {
  state: { items: [] as string[] },
  methods: { add(s: { items: string[] }, t: string) { s.items.push(t); } },
});

await aio.run({
  appId: "updates-boot-e2e",
  client: "server-only",
${
    withUpdates
      ? `  updates: { source: "file://${releases}", channel: "prod", auto: false },`
      : ""
  }
});
`;
}

const APP_BASE = "1.0";

/** Make `dir` the app's PROJECT the way a user's is: a deno.json declaring
 *  `version: "major.minor"` and a git history to count — the two facts the
 *  runtime derives its version from (`major.minor.<commit count>`). The app
 *  entry is committed too, so the tree is CLEAN and the version is a release,
 *  not a `-dirty.*` prerelease. Returns what the boot must report, resolved by
 *  the same rule the boot uses. */
async function project(dir: string, src: string): Promise<BuildVersion> {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ title: "updates-boot-e2e", version: APP_BASE }),
  );
  // The data dir and the release channel live inside the temp root; neither
  // is part of the tree a version is derived from.
  await Deno.writeTextFile(
    join(dir, ".gitignore"),
    "apps/\nreleases/\n.aio/\n",
  );
  await Deno.writeTextFile(join(dir, "app.ts"), src);
  const git = async (...args: string[]) => {
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
  };
  await git("init", "-q");
  await git("add", ".");
  await git("commit", "-q", "-m", "one");
  await git("commit", "-q", "--allow-empty", "-m", "two");
  await git("commit", "-q", "--allow-empty", "-m", "three");
  const installed = resolveBuildVersion(APP_BASE, await readTreeFacts(dir));
  assertEquals(installed.version, `${APP_BASE}.3`, "a clean tree, 3 commits");
  return installed;
}

/** Publish a signed release the way a CI job would: artifact and manifest side
 *  by side under `<channel>/`. `version` is a DERIVED build version
 *  (`major.minor.<build>`), and the manifest carries its build number. */
async function publish(
  releases: string,
  bv: Pick<BuildVersion, "version" | "build">,
  keys: { publicKey: JsonWebKey; privateKey: JsonWebKey },
  notes?: string,
): Promise<void> {
  const version = bv.version;
  const dir = join(releases, "prod");
  await Deno.mkdir(dir, { recursive: true });
  const fileName = `app-${version}`;
  const bytes = new TextEncoder().encode(
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\n`,
  );
  const manifest = await buildShipManifest({
    name: "updates-boot-e2e",
    version,
    buildNumber: bv.build,
    binary: bytes,
    sources: [],
    sign: keys,
    channel: "prod",
    target: "binary",
    platform,
    url: fileName,
    notes,
    data: { schema: 1, cells: { notes: { version: 1, migratesFrom: 1 } } },
  });
  await Deno.writeFile(join(dir, fileName), bytes);
  await Deno.chmod(join(dir, fileName), 0o755);
  await Deno.writeTextFile(
    join(dir, `${platform.os}-${platform.arch}.json`),
    JSON.stringify(manifest, null, 2),
  );
}

type App = {
  port: number;
  state: () => Promise<Record<string, Record<string, unknown>>>;
  dispatch: (type: string, payload?: unknown) => Promise<Response>;
  stop: () => Promise<void>;
  output: () => string;
};

/** Boot a real app in a real process and wait until it SERVES. A boot that
 *  merely started proves nothing — the whole point here is the assembled
 *  runtime, which does not exist until the server is answering. */
async function boot(dir: string, src: string): Promise<App> {
  const port = freePort();
  await Deno.writeTextFile(join(dir, "app.ts"), src);
  const child = new Deno.Command(Deno.execPath(), {
    // `-c` because the app lives in a temp dir with no deno.json of its own:
    // without it the framework's own `@std/*` imports do not resolve and the
    // process dies before it can serve. `AIO_APPS_DIR` keeps the data, lock
    // and trust store inside the temp root — a real boot writes real files,
    // and this test must not touch the developer's own.
    args: [
      "run",
      "-A",
      "-c",
      `${ROOT}deno.json`,
      join(dir, "app.ts"),
      `--port=${port}`,
    ],
    cwd: dir,
    env: { AIO_APPS_DIR: join(dir, "apps"), NO_COLOR: "1" },
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
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__aio/health`);
      await r.body?.cancel();
      up = r.ok;
    } catch { /* not listening yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
    await child.status;
    await pumps;
    throw new Error(`the app never served on :${port}\n${out}`);
  }

  return {
    port,
    state: async () => {
      const r = await fetch(`${base}/state`);
      return await r.json();
    },
    dispatch: (type, payload) =>
      fetch(`${base}/dispatch`, {
        method: "POST",
        // The control API's CSRF guard: a POST from a browser form cannot set
        // a custom header, so a page a developer happens to have open cannot
        // drive their app's cells. `am` sends exactly this.
        headers: { "X-AIO": "1" },
        body: JSON.stringify(
          payload === undefined ? { type } : {
            type,
            payload,
          },
        ),
      }),
    stop: async () => {
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
    },
    output: () => out,
  };
}

Deno.test({
  name: "updates boot e2e: a real `aio.run` offers a real published release",
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "aio-upd-boot-" });
    const releases = join(root, "releases");
    const keys = await generateSigningKey();
    // `installed` is what this app IS — 1.0.<commit count>, derived from its
    // own tree; `newer` is the next commit's build, what it must find.
    const src = appSource(releases, true);
    const installed = await project(root, src);
    const newer = resolveBuildVersion(APP_BASE, {
      repo: true,
      count: installed.build + 1,
      commit: "0badc0de",
      hash: null,
    });
    assertEquals(newer.version, `${APP_BASE}.${installed.build + 1}`);
    await publish(releases, installed, keys);
    await publish(releases, newer, keys, "faster");

    const app = await boot(root, src);
    try {
      // The cell exists because `updates:` was configured — the registration
      // that happens BEFORE the registry is read, and that a dynamic import
      // once deadlocked at boot with no banner.
      const before = await app.state();
      assert(
        before.updates,
        `no "updates" cell in a real boot's state — the config never reached ` +
          `the registry:\n${JSON.stringify(Object.keys(before))}`,
      );
      assertEquals(
        before.updates.enabled,
        true,
        `the cell booted DISABLED with a configured source, so the runtime ` +
          `was never installed: ${JSON.stringify(before.updates)}`,
      );
      // The runtime knows the app's own identity — not a default, not the
      // file name, not an `appVersion:` literal (retired): the version the
      // boot DERIVED from deno.json + the commit count, one string with the
      // build's. A manifest for another app must not install here, and that
      // check is only as good as the name the boot handed it.
      assertEquals(before.updates.current, installed.version);
      assertEquals(before.updates.channel, "prod");

      const r = await app.dispatch("updates:check");
      const body = await r.text();
      // `ok: true` from this route means EXECUTED, not merely accepted — an
      // unknown method is an error here, so a green status is itself part of
      // the proof that the cell's method is really bound in a real boot.
      assertEquals(r.status, 200, body);
      assertEquals(JSON.parse(body).ok, true, body);

      // `checking` is a real, documented intermediate state (.katana/updates.md:
      // "intermediate states are observable by a client, or they do not exist
      // in the type"), so the check is not finished when the dispatch returns.
      // Poll for the TERMINAL state rather than sleeping a guessed interval.
      let u: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) {
        u = (await app.state()).updates!;
        if (u.status !== "checking") break;
        await new Promise((res) => setTimeout(res, 50));
      }
      assertEquals(
        u.status,
        "available",
        `a signed ${newer.version} sitting in the channel was not offered: ` +
          `${JSON.stringify(u)}\n${app.output()}`,
      );
      const available = u.available as Record<string, unknown>;
      // The offer is the derived `major.minor.build` of the NEXT build — one
      // build number above the installed one, same base.
      assertEquals(available.version, newer.version);
      assertEquals(available.version, `${APP_BASE}.${installed.build + 1}`);
      assertEquals(available.notes, "faster");
      // Transparency travels with the offer, through the real boot too.
      assertEquals(available.signed, true);
    } finally {
      await app.stop();
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "updates boot e2e: no `updates:` key means no updates cell at all",
  fn: async () => {
    // The opt-in has to be real in BOTH directions. A framework that registers
    // its own cell into every app is exactly the "nothing you did not ask for"
    // regression alpha63 shipped a release to undo.
    const root = await Deno.makeTempDir({ prefix: "aio-upd-boot-off-" });
    const app = await boot(root, appSource(join(root, "releases"), false));
    try {
      const s = await app.state();
      assert(
        !s.updates,
        `an app that never configured updates carries an "updates" cell: ` +
          `${JSON.stringify(s.updates)}`,
      );
      assert(
        s.notes,
        "the app's own cell is missing — this boot proves nothing",
      );
    } finally {
      await app.stop();
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});
