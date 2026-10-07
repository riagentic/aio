// `build --smoke`: after building, the artifact is STARTED — from a foreign
// cwd, with a throwaway home — and the build fails when it does not come up
// clean. The verdict rules first (pure), then real builds: one that passes,
// and sabotaged ones that must fail with the line that says why.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  leftRunning,
  logProblems,
  missingGuestPreloads,
  shellGuestPreloads,
  shellUrls,
  smokeBuild,
  smokeElectron,
  smokeExit,
  smokeMode,
  smokePlan,
  type SmokeRow,
  smokeTable,
} from "../src/build/smoke.ts";
import { makeApp, task } from "./e2e-app-harness.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("smoke: the flag wins over deno.json, and a value that is neither is refused", () => {
  const off = { bare: false };
  assertEquals(smokeMode(off, undefined), false);
  assertEquals(smokeMode(off, true), true);
  assertEquals(smokeMode(off, "strict"), "strict");
  assertEquals(smokeMode(off, false), false);
  assertEquals(smokeMode({ bare: true }, undefined), true);
  assertEquals(smokeMode({ bare: false, value: "strict" }, false), "strict");
  assertEquals(smokeMode({ bare: true }, "strict"), true, "the flag wins");
  assertEquals(smokeMode({ bare: true, value: "strict" }, false), "strict");
  assertThrows(
    () => smokeMode({ bare: false, value: "yes" }, undefined),
    Error,
    "--smoke=",
  );
  assertThrows(() => smokeMode(off, "true"), Error, "build.smoke");
});

Deno.test("smoke: what runs on this host runs; everything else is NAMED, never skipped in silence", () => {
  const plan = (
    kind: string,
    platform: string,
    files: string[],
    binary?: string,
    hostOs = "linux",
  ) =>
    smokePlan({
      kind,
      platform,
      hostPlatform: "linux-x64",
      hostOs,
      files,
      binary,
    });
  assertEquals(plan("browser", "linux-x64", ["app-1"], "app-1"), {
    run: "server",
    file: "app-1",
    page: true,
  });
  assertEquals(plan("server-app", "linux-x64", ["a", "a.service"], "a"), {
    run: "server",
    file: "a",
    page: true,
  });
  // Headless: a health route, no page.
  assertEquals(plan("server", "linux-x64", ["a"], "a"), {
    run: "server",
    file: "a",
    page: false,
  });
  assertEquals(plan("cli", "linux-x64", ["a"], "a"), {
    run: "cli",
    file: "a",
    page: false,
  });
  assertEquals(plan("electron", "linux-x64", ["a.AppImage"], undefined), {
    run: "electron",
    file: "a.AppImage",
    page: true,
  });
  const skip = (p: ReturnType<typeof plan>) => "skip" in p ? p.skip : "";
  assertStringIncludes(
    skip(plan("browser", "windows-x64", ["a.exe"], "a.exe")),
    "not smoke-tested here: built for windows-x64",
  );
  assertStringIncludes(
    skip(plan("electron", "linux-x64", ["a.zip"], undefined, "windows")),
    "not smoke-tested here",
  );
  assertStringIncludes(
    skip(plan("cli-client", "linux-x64", ["a"], "a")),
    "needs the server",
  );
  assertStringIncludes(
    skip(plan("android", "linux-x64", ["a.apk"])),
    "does not run on a build host",
  );
  assertStringIncludes(skip(plan("web", "linux-x64", ["a-web"])), "web");
});

Deno.test("smoke: a not-run row fails only under strict; a FAILED row always", () => {
  const row = (status: SmokeRow["status"]): SmokeRow => ({
    target: "t",
    artifact: "a",
    status,
    lines: status === "passed" ? [] : ["why"],
  });
  assertEquals(smokeExit([row("passed")], true), 0);
  assertEquals(smokeExit([row("passed"), row("not smoke-tested")], true), 0);
  assertEquals(
    smokeExit([row("passed"), row("not smoke-tested")], "strict"),
    1,
  );
  assertEquals(smokeExit([row("passed"), row("FAILED")], true), 1);
  const table = smokeTable([row("passed"), row("FAILED")]).join("\n");
  assertStringIncludes(table, "✓ t");
  assertStringIncludes(table, "✗ t");
  assertStringIncludes(table, "      why");
});

// An Electron package's helpers exit a few ms after its main process: one
// look right behind `await proc.status` failed a healthy build.
Deno.test("smoke: descendants are given time to exit — only what is REALLY left is reported", async () => {
  let looks = 0;
  let waited = 0;
  const wait = (ms: number) => (waited += ms, Promise.resolve());
  // 11 and 12 are gone by the third look; 13 never exits.
  const alive = (pid: number) => pid === 13 || (pid !== 10 && looks < 6);
  const counting = (pid: number) => (looks++, alive(pid));
  assertEquals(await leftRunning([10, 11, 12], 3000, counting, wait), []);
  assert(
    waited > 0 && waited < 3000,
    `returned when they were gone: ${waited}`,
  );
  looks = 0, waited = 0;
  assertEquals(await leftRunning([10, 11, 13], 3000, counting, wait), [13]);
  assertEquals(waited, 3000, "bounded");
  waited = 0;
  assertEquals(await leftRunning([], 3000, counting, wait), []);
  assertEquals(waited, 0, "nothing to wait for");
});

Deno.test("smoke: a runner that throws is that target's FAILED row — the table prints, the other targets run, the exit is non-zero", async () => {
  const root = await tempDir("smoke-throw-");
  const said: string[] = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a: unknown[]) => {
    said.push(a.join(" "));
  };
  const ran: string[] = [];
  let restoreTemp = () => {};
  try {
    const code = await smokeBuild({
      root,
      outDir: join(root, "dist"),
      mode: true,
      hostPlatform: "linux-x64",
      targets: ["a", "b", "c"].map((target) => ({
        target,
        kind: "server",
        platform: "linux-x64",
        entry: "src/app.ts",
        files: [`${target}-bin`],
        binary: `${target}-bin`,
      })),
      run: (t) => {
        ran.push(t.target);
        if (t.target === "a") {
          return Promise.reject(new TypeError("connection refused (CDP)"));
        }
        return Promise.resolve([]);
      },
    });
    assertEquals(code, 1);
    assertEquals(ran, ["a", "b", "c"], "the targets after the throw still ran");
    const out = said.join("\n");
    assert(/✗ a\s+FAILED\s+a-bin/.test(out), out);
    assertStringIncludes(
      out,
      "the smoke run itself threw: TypeError: connection refused (CDP)",
    );
    assert(/✓ b\s+passed/.test(out) && /✓ c\s+passed/.test(out), out);
    // The real runner, on an artifact that is not there: the same row.
    said.length = 0;
    const gone = (target: string) => ({
      root,
      outDir: join(root, "dist"),
      mode: true as const,
      hostPlatform: "linux-x64",
      targets: [{
        target,
        kind: "server",
        platform: "linux-x64",
        entry: "src/app.ts",
        files: [`${target}-bin`],
        binary: `${target}-bin`,
      }],
    });
    assertEquals(await smokeBuild(gone("gone")), 1);
    assert(/✗ gone\s+FAILED/.test(said.join("\n")), said.join("\n"));
    // …and on one that is there and is no program (a directory, which no OS
    // hands to a shell instead), so the LAUNCH is what
    // throws: the same row, and the throwaway dir made for that launch is
    // gone again. (A spawn that throws never reaches the settle that removes
    // it: every such build left an `aio-smoke-*` in the temp dir, and on
    // Windows — where a missing artifact gets that far too — the suite's
    // leak gate went red on it.) The temp dir is this test's own meanwhile.
    await Deno.mkdir(join(root, "dist", "dud-bin"), { recursive: true });
    const tmp = join(root, "tmp");
    await Deno.mkdir(tmp);
    const vars = ["TMPDIR", "TEMP", "TMP"];
    const was = vars.map((v) => Deno.env.get(v));
    for (const v of vars) Deno.env.set(v, tmp);
    restoreTemp = () =>
      vars.forEach((v, i) =>
        was[i] === undefined ? Deno.env.delete(v) : Deno.env.set(v, was[i]!)
      );
    said.length = 0;
    assertEquals(await smokeBuild(gone("dud")), 1);
    assertStringIncludes(said.join("\n"), "the smoke run itself threw");
    assertEquals(
      [...Deno.readDirSync(tmp)].map((e) => e.name),
      [],
      "the launch that threw left its throwaway dir behind",
    );
  } finally {
    restoreTemp();
    Object.assign(console, real);
    await dropTempDir(root);
  }
});

Deno.test("smoke: the log lines that mean 'did not come up clean' — and the ordinary ones that do not", () => {
  const log = [
    `2026-10-06 19:04:39.746+02:00  WARN   aio         heap ceiling is 4.1 GB, so it cannot be raised from here`,
    `2026-10-06 19:04:39.808+02:00  INFO   app         started  cells=counter port=34857 errors=0`,
    `2026-10-06 19:04:40.152+02:00  INFO   aio         [aio] refused a stop request (POST /__aio/trojan/shutdown)`,
    `2026-10-06 19:04:41.000+02:00  ERROR  app         BOOT-ERROR-9931`,
    `2026-10-06 19:04:41.000+02:00  ERROR  app         BOOT-ERROR-9931  (boom.ts:2)`,
    `[aio:electron] declared guest preload missing — REFUSED at startup: src/guest/preload.cjs — gone`,
    `error: Uncaught (in promise) TypeError: x is not a function`,
  ].join("\n");
  assertEquals(logProblems(log), [
    `2026-10-06 19:04:41.000+02:00  ERROR  app         BOOT-ERROR-9931`,
    `[aio:electron] declared guest preload missing — REFUSED at startup: src/guest/preload.cjs — gone`,
    `error: Uncaught (in promise) TypeError: x is not a function`,
  ]);
});

Deno.test("smoke: a declared guest preload the packaged shell does not list is a refusal", () => {
  const log = (names: string) =>
    `x\n2026-10-06 19:04:41.000+02:00  INFO   electron    [aio:electron] guest preloads present in /p/dist/guest-preloads: ${names}  (electron-spawn.ts:3)\n`;
  assertEquals(shellGuestPreloads(log("a.cjs, src/g/b.cjs")), [
    "a.cjs",
    "src/g/b.cjs",
  ]);
  assertEquals(missingGuestPreloads(["a.cjs"], log("a.cjs")), []);
  assertEquals(missingGuestPreloads([], ""), []);
  const lost = missingGuestPreloads(["a.cjs", "b.cjs"], log("a.cjs"));
  assertEquals(lost.length, 1);
  assertStringIncludes(lost[0]!, "guest preload REFUSED in the package: b.cjs");
  assertStringIncludes(missingGuestPreloads(["a.cjs"], "")[0]!, "it has: none");
});

Deno.test("smoke: the URLs the served shell names", () => {
  assertEquals(
    shellUrls(
      `<link rel="icon" href="/__aio/icon"><link rel=stylesheet href='/style.css?v=1'>` +
        `<script type="module" src="/app.js"></script><img src="//cdn.example/x.png">` +
        `<a href="/about">about</a><script src="https://example.com/x.js"></script>`,
    ),
    ["/__aio/icon", "/style.css?v=1", "/app.js"],
  );
});

// ── real builds ─────────────────────────────────────────────────────────────
const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";

async function setCfg(
  dir: string,
  edit: (cfg: Record<string, any>) => void, // deno-lint-ignore no-explicit-any
): Promise<void> {
  const p = join(dir, "deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(p));
  edit(cfg);
  await Deno.writeTextFile(p, JSON.stringify(cfg, null, 2));
}

Deno.test({
  name:
    "build e2e --smoke: a clean app passes; a removed asset and an ERROR at boot each FAIL the build with their line; nothing is left running",
  ignore: !GATE,
  sanitizeResources: false, // aio-ok: the build is a child process this test awaits
  sanitizeOps: false, // aio-ok: the build is a child process this test awaits
  async fn() {
    const dir = await makeApp("counter", "build-e2e-smoke-");
    try {
      await Deno.writeTextFile(
        join(dir, "src", "logo.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>`,
      );
      await Deno.writeTextFile(
        join(dir, "src", "App.tsx"),
        `export default function App() {\n  return <main><h1>smoke</h1>` +
          `<img src="/logo.svg" alt="" /></main>;\n}\n`,
      );
      await setCfg(dir, (c) => c.compile = { include: ["src/logo.svg"] });
      const said = (r: { out: string; err: string }) => r.out + r.err;

      // 1. Clean: built, started, fetched, stopped — exit 0.
      const clean = await task(dir, "compile", "--smoke");
      assertEquals(clean.code, 0, said(clean));
      assert(/✓ browser\s+passed/.test(said(clean)), said(clean));

      // 2. The asset the page names is no longer embedded.
      await setCfg(dir, (c) => delete c.compile);
      const noAsset = await task(dir, "compile", "--smoke");
      assert(noAsset.code !== 0, `the build passed:\n${said(noAsset)}`);
      assert(/✗ browser\s+FAILED/.test(said(noAsset)), said(noAsset));
      assertStringIncludes(said(noAsset), "GET /logo.svg → 404");

      // 3. The server logs an ERROR at boot — declared in deno.json this
      //    time, so the config key is the thing that ran the smoke.
      await setCfg(dir, (c) => {
        c.compile = { include: ["src/logo.svg"] };
        c.build.smoke = true;
      });
      await Deno.writeTextFile(
        join(dir, "src", "boom.ts"),
        `import { log } from "aio";\nlog.error("BOOT-ERROR-9931");\n`,
      );
      await Deno.writeTextFile(
        join(dir, "src", "app.ts"),
        `import "./boom.ts";\n`,
        { append: true },
      );
      const boom = await task(dir, "compile");
      assert(boom.code !== 0, `the build passed:\n${said(boom)}`);
      assertStringIncludes(said(boom), "its log:");
      assertStringIncludes(said(boom), "BOOT-ERROR-9931");

      // Nothing of the three runs is still alive: each binary's path is
      // unique to this test's dir.
      if (Deno.build.os === "linux") {
        const ps = await new Deno.Command("pgrep", {
          args: ["-f", join(dir, "dist")],
          stdout: "piped",
        }).output();
        assertEquals(new TextDecoder().decode(ps.stdout).trim(), "");
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

const DECLARED = "src/guest/preload.cjs";

Deno.test({
  name:
    "build e2e --smoke (electron): the packaged app passes with its declared guest preload; the same package with that file removed FAILS on the shell's own refusal",
  ignore: !GATE || Deno.env.get("AIO_BUILD_ELECTRON") !== "1" ||
    Deno.build.os !== "linux" || !testDisplayEnv().DISPLAY,
  sanitizeResources: false, // aio-ok: real Electron children; the smoke stops and awaits them
  sanitizeOps: false, // aio-ok: real Electron children; the smoke stops and awaits them
  async fn() {
    const dir = await makeApp("counter", "build-e2e-smoke-el-");
    const box = await tempDir("build-e2e-smoke-extract-");
    try {
      await Deno.mkdir(join(dir, "src", "guest"), { recursive: true });
      await Deno.writeTextFile(join(dir, DECLARED), `// guest preload\n`);
      await setCfg(dir, (c) => c.build.guestPreloads = [DECLARED]);

      const r = await task(dir, "compile", "--targets=electron", "--smoke");
      const said = r.out + r.err;
      assertEquals(r.code, 0, said);
      assert(/✓ electron\s+passed/.test(said), said);

      // The seam: the package as shipped, minus the declared file.
      const image = [...Deno.readDirSync(join(dir, "dist"))]
        .map((e) => e.name).find((n) => /\.appimage$/i.test(n));
      assert(image, "no AppImage in dist/");
      const ex = await new Deno.Command(join(dir, "dist", image), {
        args: ["--appimage-extract"],
        cwd: box,
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(ex.success, new TextDecoder().decode(ex.stderr));
      const staged = join(
        box,
        "squashfs-root",
        "dist",
        "guest-preloads",
        DECLARED,
      );
      await Deno.remove(staged);
      const fails = await smokeElectron({
        file: join(box, "squashfs-root", "AppRun"),
        guestPreloads: [DECLARED],
      });
      assert(Array.isArray(fails), JSON.stringify(fails));
      assert(
        fails.some((f) =>
          f.includes("guest preload REFUSED in the package") &&
          f.includes(DECLARED)
        ),
        `no refusal line:\n${fails.join("\n")}`,
      );
    } finally {
      await dropTempDir(dir);
      await dropTempDir(box);
    }
  },
});
