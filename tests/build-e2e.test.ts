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
    }
    const base = `${opts.tls ? "https" : "http"}://127.0.0.1:${port}`;
    const health = await waitForHttp(`${base}/__aio/health`, timeoutMs, client)
      .catch((e) => {
        throw new Error(`${e}\n--- artifact log ---\n${log()}`);
      });
    const body = await waitForHttp(`${base}/`, 10_000, client).catch(() => "");
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

// ── 1. every server-ish compile target ships a binary that boots elsewhere ────

const SERVER_TARGETS = [
  // task, runtime flags (as the target is meant to be launched), serves HTML,
  // and whether the target exposes HTTPS instead of HTTP
  { task: "compile:browser", flags: ["--client=browser"], html: true },
  { task: "compile:service", flags: ["--client=server-only"], html: false },
  // --expose serves HTTPS with a self-signed cert (it refuses plaintext).
  {
    task: "compile:remote:service",
    flags: ["--client=server-only", "--expose"],
    html: false,
    tls: true,
  },
] as const;

for (const t of SERVER_TARGETS) {
  Deno.test({
    name: `artifact: \`${t.task}\` binary boots + serves from a foreign cwd`,
    ignore: !GATE,
    fn: async () => {
      const dir = await makeApp("counter", "build-e2e-");
      try {
        const r = await task(dir, t.task);
        assertEquals(r.code, 0, `${t.task} failed:\n${r.out}\n${r.err}`);

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
// `compile:service` writes a .service file users copy verbatim into
// /etc/systemd/system. If its ExecStart flags don't match the binary's CLI, the
// app dies on `systemctl start` — on the user's server, not here. So: parse the
// unit we generated and boot the binary with EXACTLY those flags.

Deno.test({
  name: "artifact: the generated systemd unit's ExecStart flags really boot it",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-");
    try {
      const r = await task(dir, "compile:service");
      assertEquals(r.code, 0, `compile:service failed:\n${r.err}`);

      const unitName = rootFiles(dir).find((n) => n.endsWith(".service"));
      assert(unitName, "compile:service wrote no .service unit");
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
  name: "artifact: `compile:cli` binary runs from a foreign cwd",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-");
    try {
      const r = await task(dir, "compile:cli");
      assertEquals(r.code, 0, `compile:cli failed:\n${r.out}\n${r.err}`);

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

      const bin = findBinary(dir);
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
  name: "artifact: `compile:electron` packages a complete AppImage " +
    "(AIO_BUILD_ELECTRON=1)",
  ignore: !GATE || !ELECTRON,
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-electron-");
    try {
      const r = await task(dir, "compile:electron");
      assertEquals(r.code, 0, `compile:electron failed:\n${r.out}\n${r.err}`);

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

      const r = await task(dir, "compile:cli");
      assertEquals(r.code, 0, `compile:cli failed:\n${r.out}\n${r.err}`);
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
