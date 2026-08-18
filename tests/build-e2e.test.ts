// Build reliability E2E — the gate that proves SHIPPED ARTIFACTS work.
//
// Unit tests prove the build's argv is assembled correctly; only running the
// real thing proves the binary a user downloads actually boots. Every bug that
// reached a user so far (WASM missing from the AppImage, a binary that crashed
// unless launched from its own build dir) built and "succeeded" — the artifact
// was broken, not the build. So these tests assert on ARTIFACTS:
//
//   exists → is executable → boots FROM A FOREIGN CWD → serves → exits clean
//
// The foreign cwd is not incidental: running artifacts from their build dir
// (where dist/ happens to exist) is exactly what hid the portability bug.
//
// REAL builds (esbuild + deno compile, ~1min each), so gated behind
// AIO_BUILD_E2E=1 — run with `deno task test:build`. Electron adds a ~100MB
// download, so its real build is a second opt-in (AIO_BUILD_ELECTRON=1);
// without it the AppImage path is still asserted to be wired.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  assertServesApp,
  buildFlags,
  freePort,
  kill,
  makeApp,
  spawn,
  task,
  waitForHttp,
} from "./e2e-app-harness.ts";
import { versionStamp } from "../src/build/build-bundle.ts";
import { VERSION } from "../src/server/aio-cli.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";
const ELECTRON = Deno.env.get("AIO_BUILD_ELECTRON") === "1";

/** Files sitting in the project root — build artifacts land there. */
function rootFiles(dir: string): string[] {
  return [...Deno.readDirSync(dir)].filter((e) => e.isFile).map((e) => e.name);
}

/** The compiled binary: an extension-less executable in the project root. */
function findBinary(dir: string): string {
  const bin = rootFiles(dir).filter((n) => !n.includes("."));
  assertEquals(
    bin.length,
    1,
    `expected exactly one compiled binary, got: ${bin.join(", ") || "none"}`,
  );
  return join(dir, bin[0]!);
}

/** Boot an artifact from a THROWAWAY cwd and prove it serves. Returns the body
 *  of `/` plus the parsed `/__aio/health` payload. */
async function bootFromForeignCwd(
  bin: string,
  args: string[],
  opts: { tls?: boolean; timeoutMs?: number } = {},
): Promise<{ body: string; health: string }> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  await Deno.chmod(bin, 0o755);
  const runCwd = await Deno.makeTempDir({ prefix: "foreign-cwd-" });
  const port = freePort();
  const { proc, log } = spawn(bin, [...args, `--port=${port}`], runCwd);
  let client: Deno.HttpClient | undefined;
  try {
    // `--expose` refuses to serve plaintext: it generates a self-signed cert and
    // serves HTTPS. Probing it means trusting the cert the server just made —
    // which also proves the cert it generated is actually usable.
    let headers: Record<string, string> | undefined;
    if (opts.tls) {
      const certPath = await waitFor(
        () => log().match(/tls: (?:self-signed cert at|using cert) (\S+)/)?.[1],
        timeoutMs,
      ).catch(() => {
        throw new Error(`server never reported a TLS cert:\n${log()}`);
      });
      client = Deno.createHttpClient({
        caCerts: [await Deno.readTextFile(certPath)],
      });
      // An exposed app is KEYED by default (alpha52): every route — health
      // included (docs/state/lifecycle.md) — sits behind the generated shared
      // key. Read the key the binary just persisted and present it, which
      // also proves the keyed default really engages in a compiled artifact
      // and that the persisted key file is the working credential.
      const keyPath = await waitFor(
        () => log().match(/shared app key \(persisted at (\S+),/)?.[1],
        timeoutMs,
      ).catch(() => {
        throw new Error(
          `exposed artifact never reported its generated app key ` +
            `(alpha52 keyed-by-default):\n${log()}`,
        );
      });
      headers = {
        Authorization: `Bearer ${(await Deno.readTextFile(keyPath)).trim()}`,
      };
    }
    const base = `${opts.tls ? "https" : "http"}://127.0.0.1:${port}`;
    const health = await waitForHttp(
      `${base}/__aio/health`,
      timeoutMs,
      client,
      headers,
    ).catch((e) => {
      throw new Error(`${e}\n--- artifact log ---\n${log()}`);
    });
    const body = await waitForHttp(`${base}/`, 10_000, client, headers)
      .catch(() => "");
    // A binary that fell back to dev mode is the portability bug resurfacing.
    assert(
      !/App\.tsx|dev lint|not found/i.test(log()) || !log().includes("✗"),
      `artifact logged a dev-mode failure:\n${log()}`,
    );
    return { body, health };
  } finally {
    client?.close();
    await kill(proc);
    await Deno.remove(runCwd, { recursive: true }).catch(() => {});
  }
}

/** Poll a synchronous probe until it yields a value, or the deadline passes. */
async function waitFor<T>(probe: () => T | undefined, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
}

// ── 0. the binary carries THIS app, and needs nothing else on the machine ────
//
// "It boots" is the weakest thing an artifact can prove, and it is all the rest
// of this file asks for. Two failures walk straight past it:
//
//   WRONG APP — every target bundles to the same `dist/app.js`, and one repo can
//   hold two apps (per-target `entry`). A binary serving the OTHER app's UI
//   boots, serves HTML and exits clean. The cache key was `out` alone once, and
//   that is exactly what shipped.
//
//   NEEDS THE BUILD TREE — a user downloads the binary and nothing else. Booting
//   from a foreign cwd while the project still sits on the same disk cannot tell
//   an embedded asset from one that was read back out of the source tree.
//
// So: mark the UI, delete the ENTIRE project after building, and read the
// marker back out of what the running binary serves.
Deno.test({
  name:
    "artifact: the binary serves THIS app's UI with the source tree DELETED",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-identity-");
    const keep = await Deno.makeTempDir({ prefix: "artifact-only-" });
    try {
      const marker = `UI_MARKER_${crypto.randomUUID().slice(0, 8)}`;
      const app = await Deno.readTextFile(join(dir, "src", "App.tsx"));
      await Deno.writeTextFile(
        join(dir, "src", "App.tsx"),
        app.replace("AIO Counter", marker),
      );
      assertEquals((await buildFlags(dir, "--compile")).code, 0);

      // Move the artifact somewhere else, then destroy the project — sources,
      // dist/, deno.json, node_modules, the framework symlink, all of it.
      const bin = join(keep, "app");
      await Deno.copyFile(findBinary(dir), bin);
      await Deno.remove(dir, { recursive: true });

      const { body, health } = await bootFromForeignCwd(bin, [
        "--client=browser",
      ]);
      assert(health.length > 0, "artifact did not serve health");
      assertServesApp(body);

      // The decisive read: the JS the binary hands a browser is THIS app's
      // bundle, stamped by THIS aio — not a leftover from another app or an
      // older framework that happened to be sitting in dist/.
      const port = freePort();
      const { proc, log } = spawn(bin, [`--port=${port}`], keep);
      try {
        const js = await waitForHttp(
          `http://127.0.0.1:${port}/app.js`,
          45_000,
        ).catch((e) => {
          throw new Error(`${e}\n--- artifact log ---\n${log()}`);
        });
        assertStringIncludes(
          js,
          marker,
          "the binary serves a bundle that is not this app's UI",
        );
        assertStringIncludes(js, versionStamp(VERSION).trim());
      } finally {
        await kill(proc);
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await Deno.remove(keep, { recursive: true }).catch(() => {});
    }
  },
});

// The bundle is REPRODUCIBLE: same sources in, same bytes out. A build that
// varies run to run makes every freshness/cache question unanswerable — you can
// never tell a stale artifact from a differently-ordered fresh one — and it is
// what lets a signed release manifest (`aio ship`) mean anything.
Deno.test({
  name: "artifact: two builds of the same sources produce the same bundle",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-repro-");
    try {
      const build = () =>
        new Deno.Command("deno", {
          args: ["run", "-A", "./dep/aio/src/build.ts", "--force"],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
      assertEquals((await build()).code, 0);
      const first = await Deno.readFile(join(dir, "dist", "app.js"));
      assertEquals((await build()).code, 0);
      const second = await Deno.readFile(join(dir, "dist", "app.js"));
      assertEquals(
        [first.length, ...first].join(),
        [second.length, ...second].join(),
        "dist/app.js is not reproducible — rebuilding the same sources " +
          "changed the bytes",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── 1. every server-ish compile target ships a binary that boots elsewhere ────

const SERVER_TARGETS = [
  // target label, single-target build flags, runtime flags (as the target is
  // meant to be launched), serves HTML, and whether it exposes HTTPS
  {
    target: "browser",
    build: ["--compile"],
    flags: ["--client=browser"],
    html: true,
  },
  {
    target: "server (local)",
    build: ["--compile", "--service", "--headless"],
    flags: ["--client=server-only"],
    html: false,
  },
  // --expose serves HTTPS with a self-signed cert (it refuses plaintext).
  {
    target: "server",
    build: ["--compile", "--service", "--headless", "--remote"],
    flags: ["--client=server-only", "--expose"],
    html: false,
    tls: true,
  },
] as const;

for (const t of SERVER_TARGETS) {
  Deno.test({
    name: `artifact: \`${t.target}\` binary boots + serves from a foreign cwd`,
    ignore: !GATE,
    fn: async () => {
      const dir = await makeApp("counter", "build-e2e-");
      try {
        const r = await buildFlags(dir, ...t.build);
        assertEquals(r.code, 0, `${t.target} failed:\n${r.out}\n${r.err}`);

        const bin = findBinary(dir);
        assert(
          (await Deno.stat(bin)).size > 1_000_000,
          "binary is suspiciously small",
        );

        // A bundling target's dist/app.js must carry THIS aio's version stamp:
        // it is what makes a bundle left over from an older framework detectable
        // (and what lets the client name its build in the protocol handshake).
        if (t.html) {
          const js = await Deno.readTextFile(join(dir, "dist", "app.js"));
          assertStringIncludes(js, versionStamp(VERSION).trim());
        }

        const { body, health } = await bootFromForeignCwd(bin, [...t.flags], {
          tls: "tls" in t ? t.tls : false,
        });
        assert(health.length > 0, "health endpoint returned nothing");
        if (t.html) assertServesApp(body);
      } finally {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    },
  });
}

// ── 2. the systemd unit we ship actually launches the binary ─────────────────
// The server target's build writes a .service file users copy verbatim into
// /etc/systemd/system. If its ExecStart flags don't match the binary's CLI, the
// app dies on `systemctl start` — on the user's server, not here. So: parse the
// unit we generated and boot the binary with EXACTLY those flags.

Deno.test({
  name: "artifact: the generated systemd unit's ExecStart flags really boot it",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-");
    try {
      const r = await buildFlags(dir, "--compile", "--service", "--headless");
      assertEquals(r.code, 0, `server build failed:\n${r.err}`);

      const unitName = rootFiles(dir).find((n) => n.endsWith(".service"));
      assert(unitName, "the server build wrote no .service unit");
      const unit = await Deno.readTextFile(join(dir, unitName));
      const exec = unit.match(/^ExecStart=(.*)$/m)?.[1];
      assert(exec, "unit has no ExecStart");

      // Take the flags, drop the (install-path) binary and the trailing comment
      // — the port is supplied by the harness.
      const flags = exec.split("#")[0]!.trim().split(/\s+/).slice(1)
        .filter((f) => f.startsWith("--") && !f.startsWith("--port"));
      // The runtime spelling of "server, no UI" — NOT the build flag
      // `--headless`, which the binary does not parse (it shipped that once).
      assert(
        flags.includes("--client=server-only"),
        `unit does not put the binary in server-only mode: ${exec}`,
      );

      const { health } = await bootFromForeignCwd(findBinary(dir), flags);
      assert(health.length > 0, "unit flags produced a non-serving process");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── 3. the CLI target ships a runnable binary ────────────────────────────────

Deno.test({
  name: "artifact: `cli` binary runs from a foreign cwd",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-");
    try {
      const r = await buildFlags(dir, "--compile", "--cli");
      assertEquals(r.code, 0, `cli build failed:\n${r.out}\n${r.err}`);

      const bin = findBinary(dir);
      await Deno.chmod(bin, 0o755);
      const runCwd = await Deno.makeTempDir({ prefix: "foreign-cwd-" });
      try {
        // --help is the one CLI path guaranteed to terminate; it proves the
        // binary loads its whole module graph (a missing include crashes here).
        const p = await new Deno.Command(bin, {
          args: ["--help"],
          cwd: runCwd,
          stdout: "piped",
          stderr: "piped",
        }).output();
        const out = new TextDecoder().decode(p.stdout) +
          new TextDecoder().decode(p.stderr);
        assertEquals(p.code, 0, `cli binary failed to run:\n${out}`);
        assert(out.trim().length > 0, "cli binary printed nothing");
      } finally {
        await Deno.remove(runCwd, { recursive: true }).catch(() => {});
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── 4. data assets (.wasm) survive the REAL pipeline into a running binary ────
// The reported bug: an app compiled fine, the AppImage shipped, and at runtime
// it reported "wasm not available" — `deno compile` can't see files read via
// `new URL(…, import.meta.url)`. tests/build.test.ts covers the discovery
// (assetIncludes) and the argv (compileArgs) in isolation; this proves the
// whole chain end to end — scaffolded app → `deno task compile` → binary run
// from elsewhere → the WASM actually instantiates.

Deno.test({
  name:
    "artifact: a .wasm asset is embedded by `deno task compile` and loads " +
    "at runtime (foreign cwd)",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-wasm-");
    try {
      // A minimal valid module: magic ("\0asm") + version 1.
      await Deno.writeFile(
        join(dir, "src", "probe.wasm"),
        new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
      );
      // Load it during boot, the way an app would, and report on the health
      // surface via stdout so the assertion doesn't need app plumbing.
      const app = await Deno.readTextFile(join(dir, "src", "app.ts"));
      await Deno.writeTextFile(
        join(dir, "src", "app.ts"),
        `const _wasmBytes = await Deno.readFile(\n` +
          `  new URL("./probe.wasm", import.meta.url),\n` +
          `);\n` +
          `await WebAssembly.compile(_wasmBytes);\n` +
          `console.log("WASM_OK");\n` + app,
      );

      const r = await task(dir, "compile");
      assertEquals(r.code, 0, `compile failed:\n${r.out}\n${r.err}`);
      // The build must SAY it embedded the asset — silence here means the
      // discovery step regressed even if a stale binary still works.
      assertStringIncludes(r.out + r.err, "probe.wasm");

      // `compile` is the fleet pipeline narrowed to the default target: the
      // binary lands in dist/ (flat), beside manifest.json.
      const distFiles = [...Deno.readDirSync(join(dir, "dist"))]
        .filter((e) => e.isFile && !e.name.includes("."))
        .map((e) => e.name);
      assertEquals(
        distFiles.length,
        1,
        `expected exactly one compiled binary in dist/, got: ${
          distFiles.join(", ") || "none"
        }`,
      );
      const bin = join(dir, "dist", distFiles[0]!);
      await Deno.chmod(bin, 0o755);
      const runCwd = await Deno.makeTempDir({ prefix: "foreign-cwd-" });
      const port = freePort();
      const { proc, log } = spawn(
        bin,
        ["--client=browser", `--port=${port}`],
        runCwd,
      );
      try {
        await waitForHttp(`http://127.0.0.1:${port}/__aio/health`, 45_000)
          .catch((e) => {
            throw new Error(`${e}\n--- artifact log ---\n${log()}`);
          });
        // Without the asset embedded this is a NotFound crash, not a warning.
        assertStringIncludes(
          log(),
          "WASM_OK",
          "the .wasm did not load inside the compiled binary",
        );
      } finally {
        await kill(proc);
        await Deno.remove(runCwd, { recursive: true }).catch(() => {});
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── 5. the fleet build: dist/ + manifest describe REAL, working artifacts ─────

Deno.test({
  name:
    "fleet: `deno task build` assembles dist/ + an accurate manifest, and " +
    "the artifacts boot",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-fleet-");
    try {
      const r = await task(dir, "build", "--targets=browser,cli");
      assertEquals(r.code, 0, `fleet build failed:\n${r.out}\n${r.err}`);

      const dist = join(dir, "dist");
      const manifest = JSON.parse(
        await Deno.readTextFile(join(dist, "manifest.json")),
      ) as {
        targets: Array<{
          target: string;
          ok: boolean;
          error?: string;
          artifacts: Array<{ file: string; bytes: number }>;
        }>;
      };

      assertEquals(
        manifest.targets.map((t) => t.target).sort(),
        ["browser", "cli"],
        "manifest must list exactly the requested targets",
      );

      // Every manifest entry must be a real file of the stated size — a
      // manifest that describes artifacts that aren't there is worse than none.
      for (const t of manifest.targets) {
        assert(t.ok, `${t.target} failed: ${t.error ?? "unknown"}`);
        assert(t.artifacts.length > 0, `${t.target} recorded no artifact`);
        for (const a of t.artifacts) {
          const st = await Deno.stat(join(dist, a.file));
          assert(st.isFile, `${t.target}: ${a.file} missing from dist/`);
          assertEquals(st.size, a.bytes, `${t.target}: manifest size is stale`);
        }
      }

      // Collisions are disambiguated, never overwritten: distinct files.
      const files = manifest.targets.flatMap((t) =>
        t.artifacts.map((a) => a.file)
      );
      assertEquals(new Set(files).size, files.length, "artifacts collided");

      // The build cleans up after itself: no artifacts stranded in the project
      // root, no staging dir left behind.
      const stray = rootFiles(dir).filter((n) => !n.includes("."));
      assertEquals(stray, [], `artifacts left in the project root: ${stray}`);
      const aioDir = join(dir, ".aio");
      const staging = await Array.fromAsync(Deno.readDir(aioDir))
        .catch(() => [] as Deno.DirEntry[]);
      for (const e of staging) {
        assert(
          !e.name.startsWith("build-staging-"),
          `staging dir not cleaned: ${e.name}`,
        );
      }

      // …and the fleet's server artifact genuinely runs.
      const browser = manifest.targets.find((t) => t.target === "browser")!;
      const { body, health } = await bootFromForeignCwd(
        join(dist, browser.artifacts[0]!.file),
        ["--client=browser"],
      );
      assert(health.length > 0, "fleet artifact did not serve health");
      assertServesApp(body);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── 6. AppImage packaging — DUAL MODE ────────────────────────────────────────
// The FUSE fix (appimageEnv) is unit-asserted in build.test.ts; here we prove
// the packaged AppImage is COMPLETE. Its payload is inspected by extraction
// rather than execution because Electron needs a display — extraction still
// catches the failure that shipped (assets missing from the image).

Deno.test({
  name: "artifact: `electron` packages a complete AppImage " +
    "(AIO_BUILD_ELECTRON=1)",
  ignore: !GATE || !ELECTRON,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-electron-");
    try {
      const r = await buildFlags(dir, "--compile", "--electron");
      assertEquals(r.code, 0, `electron build failed:\n${r.out}\n${r.err}`);

      const image = rootFiles(dir).find((n) =>
        n.toLowerCase().endsWith(".appimage")
      );
      assert(image, "no AppImage produced");
      const imagePath = join(dir, image);
      await Deno.chmod(imagePath, 0o755);

      // Extract (never mounts → works on FUSE-less hosts, same reason the build
      // itself sets APPIMAGE_EXTRACT_AND_RUN).
      const outDir = await Deno.makeTempDir({ prefix: "appimage-extract-" });
      const x = await new Deno.Command(imagePath, {
        args: ["--appimage-extract"],
        cwd: outDir,
        stdout: "null",
        stderr: "piped",
      }).output();
      assertEquals(
        x.code,
        0,
        `--appimage-extract failed:\n${new TextDecoder().decode(x.stderr)}`,
      );

      const squash = join(outDir, "squashfs-root");
      const present = [...Deno.readDirSync(squash)].map((e) => e.name);
      assert(present.includes("AppRun"), "AppImage has no AppRun");
      assert(
        present.some((n) => n.endsWith(".desktop")),
        "AppImage has no .desktop entry",
      );
      // The Electron runtime and the app's browser bundle must both be inside —
      // an AppImage missing either starts and then shows nothing.
      assert(
        (await Deno.stat(join(squash, "electron", "electron"))).isFile,
        "Electron runtime missing from the AppImage",
      );
      assert(
        (await Deno.stat(join(squash, "dist", "app.js"))).size > 0,
        "dist/app.js missing from the AppImage",
      );
      await Deno.remove(outDir, { recursive: true }).catch(() => {});
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// Always-on guard so this file is never a silent no-op: the electron target
// must stay wired to the AppImage packager.
Deno.test("build-e2e: the electron target is wired to AppImage packaging", async () => {
  const src = await Deno.readTextFile(
    join(import.meta.dirname ?? ".", "..", "src", "build", "build-electron.ts"),
  );
  assertStringIncludes(src, "ensureAppimagetool");
  assertStringIncludes(src, "appimageEnv(arch)");
});

// ── worker cells survive compilation ─────────────────────────────────────────
// `worker: true` runs a cell's methods on their own Deno worker, and the worker
// boots by RE-IMPORTING the app entry. That was believed impossible in a
// compiled binary — the pool's fallback still says "Compiled binaries don't
// support cell workers yet" — so the constraint went into the roadmap and was
// never re-checked. It is checkable: Deno embeds the entry in the binary, and
// the entry is exactly the module a cell worker needs.
//
// The property is ISOLATION, so the test measures it rather than trusting a log
// line: a method that blocks its thread for over a second must not stop the
// main isolate's timer from firing. In-isolate execution cannot pass this.
Deno.test({
  name:
    "artifact: a `worker: true` cell still runs off-isolate in a compiled binary",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-worker-");
    try {
      await Deno.writeTextFile(
        `${dir}/src/app.ts`,
        `import { aio, cell } from "aio";

export const heavy = cell("heavy", {
  worker: true,
  state: { runs: 0 },
  methods: {
    burn(s: { runs: number }, ms: number) {
      const end = performance.now() + ms;
      while (performance.now() < end) { /* busy */ }
      s.runs++;
      return "burned";
    },
  },
});

const app = await aio.run({
  appId: "worker-compiled-probe",
  client: "server-only",
  persist: false,
});
let ticks = 0;
const t = setInterval(() => ticks++, 20);
await heavy.burn(1200);
clearInterval(t);
// >20 ticks means the main isolate kept running while the cell burned.
console.log("PROBE ticks=" + ticks + " runs=" + heavy.runs);
await app.close();
Deno.exit(0);
`,
      );

      const r = await buildFlags(dir, "--compile", "--cli");
      assertEquals(r.code, 0, `cli build failed:\n${r.out}\n${r.err}`);
      const bin = findBinary(dir);
      await Deno.chmod(bin, 0o755);

      const runCwd = await Deno.makeTempDir({ prefix: "foreign-cwd-" });
      try {
        const p = await new Deno.Command(bin, {
          args: ["--client=server-only"],
          cwd: runCwd,
          stdout: "piped",
          stderr: "piped",
        }).output();
        const out = new TextDecoder().decode(p.stdout) +
          new TextDecoder().decode(p.stderr);
        const m = out.match(/PROBE ticks=(\d+) runs=(\d+)/);
        assert(m, `probe never reported:\n${out}`);
        assertEquals(m[2], "1", "the worker cell committed its state home");
        assert(
          Number(m[1]) > 20,
          `main isolate stalled during the burn (${m[1]} ticks) — the cell ` +
            `ran in-isolate:\n${out}`,
        );
        assert(
          !out.includes("cannot host worker cells"),
          `the pool refused to host the worker:\n${out}`,
        );
      } finally {
        await Deno.remove(runCwd, { recursive: true }).catch(() => {});
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── the compiled binary can still read its own deno.json ─────────────────────
// `resolveTitle` reads deno.json from the cwd, inside a catch-all `try` that
// turns ANY failure into the "AIO App" fallback — a title that silently
// degrades looks identical to a deno.json with no `title` field, so nothing
// about it would ever be noticed.
//
// This started as a regression test for a suspected compiled-binary failure
// (`resolveTitle` used to reach for `join` via `await import("@std/path")`, a
// bare specifier `deno compile` cannot trace). The suspicion was WRONG, and
// this test is what proved it: the binary resolves that import fine, because
// @std/path is in the graph via other static imports. It earns its place
// anyway — the swallowing catch is real, and this is the only check that the
// title survives compilation at all. Run the binary WHERE ITS deno.json IS,
// which is what a user compiling in their own project does, and read the title
// off the page it serves.
Deno.test({
  name: "artifact: a compiled binary reads `title` from deno.json beside it",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-title-");
    try {
      const declared = JSON.parse(
        await Deno.readTextFile(`${dir}/deno.json`),
      ).title as string;
      assert(declared, "the scaffold declares a title");

      const r = await buildFlags(dir, "--compile");
      assertEquals(r.code, 0, `browser build failed:\n${r.out}\n${r.err}`);
      const bin = findBinary(dir);
      await Deno.chmod(bin, 0o755);

      const port = freePort();
      // cwd is the APP dir — the case a foreign-cwd boot cannot cover, since
      // there is no deno.json there to read at all.
      const { proc, log } = spawn(bin, [`--port=${port}`], dir);
      try {
        const body = await waitForHttp(`http://127.0.0.1:${port}/`, 45_000)
          .catch((e) => {
            throw new Error(`${e}\n--- artifact log ---\n${log()}`);
          });
        const title = body.match(/<title>([^<]*)<\/title>/)?.[1];
        assertEquals(
          title,
          declared,
          `served title should come from deno.json, not the fallback:\n${log()}`,
        );
      } finally {
        await kill(proc);
      }

      // The app's VERSION travelling inside the binary is proven
      // without a second boot of this same artifact, which would contend for
      // its singleton lock: `tests/build.test.ts` asserts deno.json is in the
      // compile includes, and `tests/app-version-identity.test.ts` asserts the
      // runtime resolves it from the entry module and never from the cwd.
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── cross-platform: one machine, one command, every OS ────────────────────
//
// The failure mode a unit test cannot catch is a build that SUCCEEDS while
// emitting the host's binary under a foreign platform's name. Only the file's
// own format can settle it, so this reads the artifact's magic bytes: a PE
// executable starts "MZ" and carries a "PE\0\0" header; an ELF starts \x7fELF;
// a Mach-O has its own magic. A mislabeled host binary fails here.
Deno.test({
  name: "artifact: `deno task build` cross-compiles a real foreign binary",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-xplat-");
    try {
      const { hostPlatform } = await import("../src/build/platforms.ts");
      // Pick a platform that is definitely NOT this machine.
      const foreign = hostPlatform() === "windows" ? "linux" : "windows";
      const r = await task(
        dir,
        "build",
        "--targets=cli",
        `--platforms=host,${foreign}`,
      );
      assertEquals(r.code, 0, `cross build failed:\n${r.out}\n${r.err}`);

      const dist = join(dir, "dist");
      const manifest = JSON.parse(
        await Deno.readTextFile(join(dist, "manifest.json")),
      ) as {
        builtOn: string;
        platforms: string[];
        targets: Array<{
          target: string;
          platform: string;
          host: boolean;
          triple: string | null;
          ok: boolean;
          artifacts: Array<{ file: string; bytes: number }>;
        }>;
      };

      assertEquals(manifest.builtOn, hostPlatform(), "manifest names the host");
      assertEquals(
        manifest.targets.map((t) => t.platform).sort(),
        [foreign, hostPlatform()].sort(),
        "one entry per platform",
      );

      const cross = manifest.targets.find((t) => t.platform === foreign)!;
      assertEquals(cross.ok, true);
      assertEquals(cross.host, false, "it is flagged as NOT runnable here");
      assert(cross.triple, "and records the triple it was built for");
      const file = cross.artifacts[0]?.file;
      assert(file, "the cross build produced an artifact");
      assert(
        file!.includes(foreign),
        `a cross artifact must name its platform: ${file}`,
      );

      // The decisive check: the bytes are the FOREIGN platform's format.
      const bytes = await Deno.readFile(join(dist, file!));
      if (foreign === "windows") {
        assertEquals([bytes[0], bytes[1]], [0x4d, 0x5a], "PE files start MZ");
        const peOff = new DataView(bytes.buffer).getUint32(0x3c, true);
        assertEquals(
          [bytes[peOff], bytes[peOff + 1], bytes[peOff + 2], bytes[peOff + 3]],
          [0x50, 0x45, 0x00, 0x00],
          "…and carry a PE\\0\\0 header — this is not a renamed host binary",
        );
      } else {
        assertEquals(
          [bytes[0], bytes[1], bytes[2], bytes[3]],
          [0x7f, 0x45, 0x4c, 0x46],
          "ELF magic — this is not a renamed host binary",
        );
      }

      // The host artifact is still the bare name, and still runs.
      const hostEntry = manifest.targets.find((t) => t.host)!;
      const hostFile = hostEntry.artifacts[0]!.file;
      assert(
        !hostFile.includes(foreign),
        "the host artifact keeps its plain name",
      );
      const bin = join(dist, hostFile);
      await Deno.chmod(bin, 0o755);
      const run = await new Deno.Command(bin, {
        args: ["--help"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertStringIncludes(
        new TextDecoder().decode(run.stdout) +
          new TextDecoder().decode(run.stderr),
        "aio",
        "the host binary still boots",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "artifact: a platform that cannot cross-compile is refused, not faked",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-xplat-skip-");
    try {
      const { hostPlatform } = await import("../src/build/platforms.ts");
      // Electron cross-builds to Windows/macOS from any host now (the runtime
      // is a download — see platforms.ts), so "another OS" is no longer the
      // refused case. The refusal that REMAINS is a tool constraint: a Linux
      // Electron package is an AppImage, and appimagetool is a native binary
      // for the arch it assembles — so a Linux host is refused the OTHER
      // Linux arch, and a non-Linux host is refused Linux entirely.
      const host = hostPlatform();
      const foreign = host === "linux"
        ? "linux-arm64"
        : host === "linux-arm64"
        ? "linux"
        : "linux";
      const r = await task(
        dir,
        "build",
        "--targets=electron",
        `--platforms=${foreign}`,
      );
      assertStringIncludes(
        r.out + r.err,
        "skipped",
        "the refusal is reported, not silent",
      );
      const leaked = [...Deno.readDirSync(dir)].some((e) =>
        e.name.includes(foreign)
      );
      assertEquals(leaked, false, "no artifact wearing the foreign platform");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
