// run.ps1 / install.ps1, the parts that can be RUN: on Windows the scripts are
// dot-sourced under Windows PowerShell (which defines their functions and
// installs nothing) and the functions are called. Elsewhere the same facts
// are read from the text.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { readSfxTrailer, SFX_MAGIC } from "../src/build/sfx-trailer.ts";
import {
  appendSfxPayload,
  prebuiltStubPath,
} from "../src/build/build-windows-exe.ts";
import { fakeSigned } from "./sfx-sign-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dirname!, "..");
const WINDOWS = Deno.build.os === "windows";

/** Dot-source `script`, run `body`, return what it printed. */
async function ps(
  script: string,
  body: string,
  env: Record<string, string | undefined> = {},
): Promise<string> {
  const full = { ...Deno.env.toObject() } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete full[k];
    else full[k] = v;
  }
  const o = await new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `. '${join(ROOT, script)}'; ${body}`,
    ],
    clearEnv: true,
    env: { ...full, NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(o.stdout);
  assertEquals(o.code, 0, out + new TextDecoder().decode(o.stderr));
  return out.replaceAll("\r\n", "\n").trim();
}

/** {@linkcode ps}, with what it wrote to stderr as well. */
async function psRaw(
  script: string,
  body: string,
  env: Record<string, string> = {},
): Promise<{ out: string; err: string }> {
  const o = await new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `. '${join(ROOT, script)}'; ${body}`,
    ],
    env: { ...env, NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const t = (b: Uint8Array) =>
    new TextDecoder().decode(b).replaceAll("\r\n", "\n").trim();
  assertEquals(o.code, 0, t(o.stdout) + t(o.stderr));
  return { out: t(o.stdout), err: t(o.stderr) };
}

// The newest .exe of an Electron build IS the one-click installer. run.ps1
// copied it under Programs\ and made a shortcut to the copy — which, run,
// installed the app a second time under aio-sfx\ with a second shortcut.
Deno.test("run.ps1: a one-click .exe is recognised by its trailer and is not installed a second time", async () => {
  const text = await Deno.readTextFile(join(ROOT, "run.ps1"));
  // The magic the script looks for is the one the packer writes.
  assertStringIncludes(text, `-like '${SFX_MAGIC.slice(0, -1)}?'`);
  // The Programs\ install (copy, shortcut) is skipped for it…
  assertStringIncludes(text, "if (-not $NoInstall -and -not $oneClick) {");
  // …unless an install made the 1.0.19 way is there (it keeps being
  // updated: its shortcut opens that copy), or -NoRun meets a stub that
  // cannot install without starting the app (1.0.19's -NoRun: the copy).
  const decide = text.slice(
    text.indexOf("$oneClick = (-not $NoInstall)"),
    text.lastIndexOf("if ($oneClick) {"),
  );
  assertStringIncludes(decide, "if (Test-Path -LiteralPath $stable) {");
  assertStringIncludes(
    decide,
    "} elseif ($NoRun -and -not (Test-OneClickInstallSwitch $artifact.FullName)) {",
  );
  assertEquals(decide.split("$oneClick = $false").length - 1, 2);
  assert(!decide.includes("exit "), "a compatible path is not a failure");
  // …it is still recorded, so am installed / upgrade / remove know it…
  const branch = text.slice(
    text.lastIndexOf("if ($oneClick) {"),
    text.indexOf("if (-not $NoInstall -and -not $oneClick) {"),
  );
  assertStringIncludes(branch, "Write-InstallRecord $AioHome");
  assert(!branch.includes("CreateShortcut"), "a second shortcut");
  assert(!branch.includes("Copy-Item"), "a second copy of the program");
  // …and under -NoRun (what `am upgrade` passes) only after the .exe has
  // installed itself without starting the app: one that says it did not
  // records nothing and exits 1. (One that CANNOT — an older stub — never
  // gets here: see `decide` above.)
  const noRun = branch.indexOf("if ($NoRun) {");
  assert(noRun > 0 && noRun < branch.indexOf("Write-InstallRecord"));
  const held = branch.slice(noRun, branch.indexOf("Write-InstallRecord"));
  assertStringIncludes(held, "-ArgumentList '--aio-sfx-install' -Wait");
  assertEquals(held.split("exit 1").length - 1, 1);
  assertStringIncludes(held, "if ($p.ExitCode -ne 0) {");
  assertStringIncludes(branch, "is NOT installed");
});

// In Windows PowerShell `--commit=(git …)` is TWO arguments and
// `--aio=$conf.aioVersion` keeps ".aioVersion" as text (measured on 5.1), and
// the write's exit code was thrown away with its output.
Deno.test("run.ps1: the install record is written through ONE checked writer, each field one argument", async () => {
  const text = (await Deno.readTextFile(join(ROOT, "run.ps1")))
    .replace(/^\s*#.*$/gm, "");
  assertEquals(text.split('install-record.ts") write').length - 1, 1);
  assertEquals(text.split("Write-InstallRecord $AioHome").length - 1, 2);
  assert(!/--\w+=\(/.test(text), "--k=(expr) is two arguments");
  assert(!/--\w+=\$\w+\.\w/.test(text), "--k=$obj.prop is not expanded");
  const fn = /function Write-InstallRecord[\s\S]*?\n}\n/.exec(text)![0];
  assertStringIncludes(fn, "if ($LASTEXITCODE -ne 0) {");
  assertStringIncludes(fn, "was NOT written");
});

Deno.test({
  name:
    "run.ps1 (run under Windows PowerShell): Write-InstallRecord passes each field whole, and says a failed write",
  ignore: !WINDOWS, // Windows PowerShell exists only there
  async fn() {
    const dir = await tempDir("run-ps1-record-");
    try {
      await Deno.mkdir(join(dir, "src", "server"), { recursive: true });
      const seen = join(dir, "seen.json");
      await Deno.writeTextFile(
        join(dir, "src", "server", "install-record.ts"),
        `Deno.writeTextFileSync(${
          JSON.stringify(seen)
        }, JSON.stringify(Deno.args));
Deno.exit(Number(Deno.env.get("ZZ_EXIT") ?? 0));\n`,
      );
      const call =
        `$conf = '{"aioVersion":"v9.9.9-beta"}' | ConvertFrom-Json; ` +
        `$r = Write-InstallRecord '${dir}' ([ordered]@{ name = 'zz'; ` +
        `artifact = [IO.Path]::GetFileName('C:\\x\\a b.exe'); ` +
        `commit = (cmd /c "echo abc123"); none = (cmd /c "exit 0"); ` +
        `aio = $conf.aioVersion }); "R=$r"`;
      assertEquals(await ps("run.ps1", call), "R=True");
      assertEquals(JSON.parse(await Deno.readTextFile(seen)), [
        "write",
        "--name=zz",
        "--artifact=a b.exe",
        "--commit=abc123",
        "--none=",
        "--aio=v9.9.9-beta",
      ]);
      const failed = await psRaw("run.ps1", call, { ZZ_EXIT: "3" });
      assertEquals(failed.out, "R=False");
      assertStringIncludes(
        failed.err,
        "the install record for zz was NOT written (install-record.ts exited 3)",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

// Windows PowerShell 5.1 + `$ErrorActionPreference = 'Stop'`: a REDIRECTED
// native stderr line is a terminating error. `git clone … 2>&1` threw on
// "Cloning into …" and `git rev-parse HEAD 2>$null` threw in every app that
// is not a git repository (both measured on Windows 11).
Deno.test("install.ps1 + run.ps1: every redirected native call goes through Quiet", async () => {
  for (const script of ["install.ps1", "run.ps1"]) {
    const code = (await Deno.readTextFile(join(ROOT, script)))
      .replace(/\`\r?\n\s*/g, " ") // a continued line is one statement
      .split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
    const redirected = code.filter((l) => /2>(\$null|&1)/.test(l));
    assert(redirected.length >= 7, `${script}: ${redirected.length}`);
    for (const line of redirected) {
      assert(/Quiet \{[^}]*2>(\$null|&1)/.test(line), `${script}: ${line}`);
    }
    assertStringIncludes(
      code.join("\n"),
      "function Quiet([scriptblock]$run) { $ErrorActionPreference = 'Continue'; & $run }",
    );
  }
});

Deno.test({
  name:
    "install.ps1 + run.ps1 (run under Windows PowerShell): a stderr line of a redirected program does not end the script inside Quiet — and does outside",
  ignore: !WINDOWS, // Windows PowerShell exists only there
  async fn() {
    const noisy = `cmd /c "echo progress 1>&2 & echo value& exit 3"`;
    for (const script of ["install.ps1", "run.ps1"]) {
      assertEquals(
        await ps(
          script,
          `$v = (Quiet { ${noisy} 2>$null }); "v=$v code=$LASTEXITCODE"`,
        ),
        "v=value code=3",
        script,
      );
      // The control: this is what every such line did before.
      assertEquals(
        await ps(
          script,
          `try { $v = (${noisy} 2>$null); "survived" } catch { "threw" }`,
        ),
        "threw",
        script,
      );
    }
  },
});

/** An app `zzapp` under `dir` whose compile task is `makeTs`, and how to run
 *  run.ps1 in it with every write kept under `dir`. */
async function flow(dir: string, makeTs: string) {
  const app = join(dir, "zzapp");
  const bin = join(dir, "bin");
  const inst = join(dir, "inst");
  const local = join(dir, "Local");
  await Deno.mkdir(app);
  await Deno.mkdir(bin);
  await Deno.writeTextFile(join(bin, "am.cmd"), "@exit /b 0\r\n");
  await Deno.writeTextFile(join(bin, "noop.cmd"), "@exit /b 0\r\n");
  const setVersion = (version: string) =>
    Deno.writeTextFile(
      join(app, "deno.json"),
      JSON.stringify({
        aioVersion: "v9.9.9-beta",
        version,
        // aio's own config: make.ts may import the builder, whose imports
        // are names only that file maps.
        tasks: {
          compile: `deno run -A --config ${
            join(ROOT, "deno.json").replaceAll("\\", "/")
          } make.ts`,
        },
      }),
    );
  await setVersion("1.0.4");
  await Deno.writeTextFile(join(app, "make.ts"), makeTs);
  const run = async (...flags: string[]) => {
    const o = await new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(ROOT, "run.ps1"),
        ...flags,
      ],
      cwd: app,
      env: {
        PATH: `${bin};${Deno.env.get("PATH")}`,
        AIO_HOME: ROOT,
        AIO_INSTALL: join(bin, "noop.cmd"),
        AIO_INSTALL_ROOT: inst,
        HOME: dir,
        USERPROFILE: dir,
        LOCALAPPDATA: local,
        APPDATA: join(dir, "Roaming"),
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: o.code,
      out: new TextDecoder().decode(o.stdout),
      err: new TextDecoder().decode(o.stderr),
    };
  };
  const records = async () => {
    const found: string[] = [];
    const walk = async (d: string) => {
      for await (const e of Deno.readDir(d)) {
        if (e.isDirectory) await walk(join(d, e.name));
        else if (e.name === "installed.json") found.push(join(d, e.name));
      }
    };
    await walk(inst).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
    return found;
  };
  return { app, local, run, records, setVersion };
}

// The whole script, for real, around a stand-in build: real PowerShell, real
// deno (so the real install-name and install-record rules answer), a compile
// task that drops a one-click-shaped .exe (a harmless system program with the
// trailer's magic appended), stand-ins for \`am\` and the installer.
Deno.test({
  name:
    "run.ps1 (run under Windows PowerShell): a one-click build whose stub cannot install without starting is, under -NoRun, installed as 1.0.19 installed it — exit 0, not started; run on a fresh profile, it is recorded and started",
  ignore: !WINDOWS, // Windows PowerShell exists only there
  async fn() {
    // The stand-in program leaves a file when it runs, and its last bytes
    // are the trailer's magic (it echoes it): one-click-shaped, no switch.
    const make = (marker: string) =>
      `import { programBytes } from ${
        JSON.stringify(
          toFileUrl(join(ROOT, "tests", "fake-program-helper.ts")).href,
        )
      };
Deno.mkdirSync("dist", { recursive: true });
Deno.writeFileSync("dist\\\\zzapp-win-x64.exe", await programBytes(${
        JSON.stringify(`#!/bin/sh\ntouch "${marker}"\necho ${SFX_MAGIC}`)
      }));\n`;
    const record = async (recs: string[]) =>
      JSON.parse(await Deno.readTextFile(recs[0]!));

    // What `am upgrade` runs. 1.0.19's run.ps1, measured on Windows 11 with
    // the same fixture: the copy under <root>\zzapp\versions\<ver>\, the
    // stable <root>\zzapp\zzapp.exe, a Start Menu zzapp.lnk to it, "Run it:"
    // and exit 0 — the .exe not run.
    const dir = await tempDir("run-ps1-flow-");
    try {
      const marker = join(dir, "it-ran");
      const { run, records, setVersion } = await flow(dir, make(marker));
      const stable = join(dir, "inst", "zzapp", "zzapp.exe");
      const lnk = join(
        dir,
        "Roaming",
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "zzapp.lnk",
      );
      const held = await run("-NoRun");
      assertEquals(held.code, 0, held.out + held.err);
      assert(!(held.out + held.err).includes("NOT installed"), held.err);
      assertStringIncludes(held.out, `Run it: ${stable}`);
      assert(existsSync(stable) && existsSync(lnk), held.out + held.err);
      assert(
        existsSync(
          join(dir, "inst", "zzapp", "versions", "1.0.4", "zzapp.exe"),
        ),
      );
      assertEquals((await record(await records())).version, "1.0.4");
      assert(!existsSync(marker), "it was run");

      // That install is there now: every later run updates it THERE — the
      // shortcut made for it must not go on opening an old version.
      await setVersion("1.0.5");
      const up = await run("-NoRun");
      assertEquals(up.code, 0, up.out + up.err);
      assertStringIncludes(up.out, "an install made by an earlier run");
      assert(
        existsSync(
          join(dir, "inst", "zzapp", "versions", "1.0.5", "zzapp.exe"),
        ),
      );
      const recs = await records();
      assertEquals(recs.length, 1, "a second record");
      assertEquals((await record(recs)).version, "1.0.5");
      assert(!existsSync(join(dir, "Local", "aio-sfx")), "a second install");
      // …and without -NoRun: updated there and started from there.
      await setVersion("1.0.6");
      const ran = await run();
      assertEquals(ran.code, 0, ran.out + ran.err);
      assertStringIncludes(ran.out, `running ${stable}`);
      assertEquals((await record(await records())).version, "1.0.6");
      assert(existsSync(marker), ran.out + ran.err);
    } finally {
      await dropTempDir(dir);
    }

    // A profile with no such install, run: recorded with every field whole,
    // nothing copied under the install root, then started.
    const fresh = await tempDir("run-ps1-flow-");
    try {
      const marker = join(fresh, "it-ran");
      const { app, run, records } = await flow(fresh, make(marker));
      const ran = await run();
      assertEquals(ran.code, 0, ran.out + ran.err);
      const recs = await records();
      assertEquals(recs.length, 1, ran.out + ran.err);
      const rec = await record(recs);
      assertEquals(
        [rec.name, rec.version, rec.artifact, rec.target, rec.aioVersion],
        ["zzapp", "1.0.4", "zzapp-win-x64.exe", "electron", "v9.9.9-beta"],
      );
      assertEquals(rec.source, app);
      assertEquals(rec.commit, undefined);
      assert(!existsSync(join(fresh, "inst", "zzapp", "zzapp.exe")));
      // …and here it ran.
      assert(existsSync(marker), ran.out + ran.err);
    } finally {
      await dropTempDir(fresh);
    }
  },
});

// What `am upgrade <app>` does to a one-click install: the real stub, a small
// payload whose app is a copy of cmd.exe (started, `/c` would leave a file).
Deno.test({
  name:
    "run.ps1 (run under Windows PowerShell): -NoRun installs a one-click .exe without starting it — a newer and an older build alike — and records the version; a refused install records nothing",
  ignore: !WINDOWS, // Windows PowerShell exists only there
  async fn() {
    const dir = await tempDir("run-ps1-upgrade-");
    try {
      const mod = toFileUrl(join(ROOT, "src", "build", "build-windows-exe.ts"));
      const { local, run, records, setVersion } = await flow(
        dir,
        `import { ensureWindowsSfxStub, packAppDirTarZstd, writeWindowsSfxExe } from ${
          JSON.stringify(mod.href)
        };
const version = JSON.parse(Deno.readTextFileSync("deno.json")).version;
Deno.mkdirSync("stage/electron", { recursive: true });
Deno.mkdirSync("dist", { recursive: true });
Deno.copyFileSync(Deno.env.get("WINDIR") + "\\\\System32\\\\cmd.exe", "stage/zzapp.exe");
Deno.writeTextFileSync("stage/electron/electron.exe", "e");
Deno.writeTextFileSync("stage/holds.txt", version);
await packAppDirTarZstd("stage", "payload.tar.zst");
await writeWindowsSfxExe({
  stubPath: await ensureWindowsSfxStub(),
  payloadPath: "payload.tar.zst",
  payloadFormat: "tar.zstd",
  outPath: "dist/zzapp-win-x64.exe",
  binaryName: "zzapp",
  archStr: "x64",
  version,
});\n`,
      );
      const install = join(local, "aio-sfx", "zzapp", "win-x64");
      const version = async () =>
        JSON.parse(await Deno.readTextFile((await records())[0]!)).version;
      const held = () => Deno.readTextFile(join(install, "holds.txt"));

      const first = await run("-NoRun");
      assertEquals(first.code, 0, first.out + first.err);
      assertStringIncludes(first.out, "installed 1.0.4 to ");
      assertStringIncludes(first.out, `Run it: ${join(install, "zzapp.exe")}`);
      assertEquals(await held(), "1.0.4");
      assertEquals(await version(), "1.0.4");

      await setVersion("1.0.5");
      const up = await run("-NoRun");
      assertEquals(up.code, 0, up.out + up.err);
      assertEquals(await held(), "1.0.5");
      assertEquals(await version(), "1.0.5");

      // While the app runs from the install the .exe refuses (exit 3), and so
      // does this: nothing changed, nothing recorded.
      await setVersion("1.0.6");
      const app = new Deno.Command(join(install, "zzapp.exe"), {
        args: ["/k"],
        cwd: install,
        stdin: "piped",
        stdout: "null",
        stderr: "null",
      }).spawn();
      try {
        const busy = await run("-NoRun");
        assertEquals(busy.code, 1, busy.out + busy.err);
        assertStringIncludes(busy.err, "zzapp is running, so this version");
        assertStringIncludes(
          busy.err,
          "version 1.0.6 is NOT installed: zzapp is running",
        );
        assertEquals(await held(), "1.0.5");
        assertEquals(await version(), "1.0.5", "a version nobody installed");
      } finally {
        app.kill();
        await app.stdin.close().catch(() => {});
        await app.status;
      }

      // Back to an older build: it goes in, and the .exe's remark is passed on.
      await setVersion("1.0.3");
      const down = await run("-NoRun");
      assertEquals(down.code, 0, down.out + down.err);
      assertStringIncludes(
        down.err,
        "replaced the newer zzapp 1.0.5 with 1.0.3",
      );
      assertEquals(await held(), "1.0.3");
      assertEquals(await version(), "1.0.3");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "run.ps1 (run under Windows PowerShell): Test-OneClickExe reads the file, not its name",
  ignore: !WINDOWS, // Windows PowerShell exists only there
  async fn() {
    const dir = await tempDir("run-ps1-oneclick-");
    try {
      const sfx = join(dir, "plain-name.exe");
      const plain = join(dir, "app-win-x64.exe");
      const pad = new Uint8Array(4096).fill(0x4d);
      await Deno.writeFile(
        sfx,
        new Uint8Array([...pad, ...new TextEncoder().encode(SFX_MAGIC)]),
      );
      await Deno.writeFile(plain, pad);
      await Deno.writeFile(join(dir, "tiny.exe"), new Uint8Array([1, 2]));
      const out = await ps(
        "run.ps1",
        `"$(Test-OneClickExe '${sfx}') $(Test-OneClickExe '${plain}') ` +
          `$(Test-OneClickExe '${join(dir, "tiny.exe")}') ` +
          `$(Test-OneClickExe '${join(dir, "absent.exe")}')"`,
      );
      assertEquals(out, "True False False False");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "install.ps1 + run.ps1 (run under Windows PowerShell): the home is HOME when set, else USERPROFILE; a checkout already under USERPROFILE stays the one used — and a mismatch is said",
  ignore: !WINDOWS, // Windows PowerShell exists only there
  async fn() {
    for (const script of ["install.ps1", "run.ps1"]) {
      assertEquals(
        await ps(script, "Get-AioUserHome", {
          HOME: "D:\\custom home",
          USERPROFILE: "C:\\Users\\me",
        }),
        "D:\\custom home",
        script,
      );
      assertEquals(
        await ps(script, "Get-AioUserHome", {
          HOME: undefined,
          USERPROFILE: "C:\\Users\\me",
        }),
        "C:\\Users\\me",
        script,
      );
      const two = await ps(script, "Show-AioHome 'X:\\aio'", {
        HOME: "D:\\h",
        USERPROFILE: "C:\\Users\\me",
      });
      assertStringIncludes(two, "aio: X:\\aio - app data: D:\\h\\.<appId>");
      assertStringIncludes(
        two,
        "%HOME% (D:\\h) differs from %USERPROFILE% (C:\\Users\\me)",
      );
      assert(!two.includes("aio checkout stays"), two);
      // A checkout an earlier installer left under %USERPROFILE% (where
      // every install before 1.0.20 went, whatever HOME said) stays THE
      // checkout — and that is said. Without one, HOME's.
      const prof = await tempDir("ps1-old-home-");
      try {
        const env = { HOME: "D:\\h", USERPROFILE: prof, AIO_HOME: undefined };
        assertEquals(
          await ps(script, "Get-AioDefaultHome", env),
          "D:\\h\\.local\\lib\\aio",
          script,
        );
        const old = join(prof, ".local", "lib", "aio");
        await Deno.mkdir(join(old, ".git"), { recursive: true });
        assertEquals(await ps(script, "Get-AioDefaultHome", env), old, script);
        assertEquals(
          await ps(script, "Get-AioDefaultHome", { ...env, HOME: undefined }),
          old,
          script,
        );
        const said = await ps(script, `Show-AioHome '${old}'`, env);
        assertStringIncludes(
          said,
          `the aio checkout stays at ${old}, where an earlier install put it - it is the one used and updated`,
        );
        assert(!said.includes("NOT the one used"), said);
        // AIO_HOME chosen by hand: where aio lives was said, not derived.
        assert(
          !(await ps(script, "Show-AioHome 'X:\\aio'", {
            ...env,
            AIO_HOME: "X:\\aio",
          })).includes("aio checkout stays"),
        );
      } finally {
        await dropTempDir(prof);
      }
      // One home, spelled two ways: one line, no note.
      const one = await ps(script, "Show-AioHome 'X:\\aio'", {
        HOME: "C:/Users/me/",
        USERPROFILE: "C:\\Users\\me",
      });
      assert(!one.includes("differs"), one);
    }
  },
});

/** A one-click `.exe` in memory: the committed stub, a payload of `n` bytes
 *  (its length sets the padding a signature adds), and the trailer. */
async function oneClickBytes(n: number): Promise<Uint8Array> {
  return appendSfxPayload(
    await Deno.readFile(prebuiltStubPath()),
    new Uint8Array(n).fill(0x50),
    { sha256: "ab", binary: "zz", arch: "x64", format: "tar.zstd" },
  );
}

// A SIGNED one-click .exe has its certificate table after the trailer.
// run.ps1 looked for the magic in the file's last 8 bytes: such a file was
// "not a one-click .exe" and was copied under Programs\ as a second install.
Deno.test("run.ps1 + am publish: a one-click .exe is found by the PE's own structure — signed or not, one rule with the stub", async () => {
  const text = await Deno.readTextFile(join(ROOT, "run.ps1"));
  const fn = (name: string) => {
    const at = text.indexOf(`function ${name}(`);
    assert(at > 0, name);
    return text.slice(at, text.indexOf("\nfunction ", at + 1));
  };
  // Both questions go through the one finder; neither reads the file's end.
  for (const name of ["Test-OneClickExe", "Test-OneClickInstallSwitch"]) {
    assertStringIncludes(fn(name), "Get-SfxTrailerEnd $fs");
    assert(!fn(name).includes("[IO.SeekOrigin]::End"), name);
  }
  // The finder's constants are the stub's (format.rs `cert_table_offset`).
  const rust = await Deno.readTextFile(
    join(ROOT, "src/build/windows-sfx-stub/src/format.rs"),
  );
  for (const constant of ["0x3c", "0x20b", "0x10b"]) {
    assertStringIncludes(fn("Get-SfxTrailerEnd"), constant);
    assertStringIncludes(rust, constant);
  }
  assertStringIncludes(fn("Get-SfxTrailerEnd"), "$pad -lt 8");
  assertStringIncludes(rust, "for pad in 0..8");
  // The TypeScript reader (am publish) by the same rule, on real bytes.
  for (const n of [64, 61]) { // aligned, and 3 pad bytes
    const exe = await oneClickBytes(n);
    const signed = fakeSigned(exe);
    assert(new TextDecoder().decode(signed.subarray(-8)) !== SFX_MAGIC);
    assertEquals(readSfxTrailer(signed), readSfxTrailer(exe));
    assertEquals(readSfxTrailer(exe)?.payloadLength, n);
    // Bytes after the trailer that no security directory accounts for are
    // not a signature, and the file is not a one-click .exe.
    assertEquals(
      readSfxTrailer(Uint8Array.from([...exe, ...new Uint8Array(4096)])),
      null,
    );
  }
});

Deno.test({
  name:
    "run.ps1 (run under Windows PowerShell): a signed one-click .exe is recognised, and its install switch is read from its stub",
  ignore: !WINDOWS, // Windows PowerShell exists only there
  async fn() {
    const dir = await tempDir("run-ps1-signed-");
    try {
      const names: string[] = [];
      const pads = new Set<number>();
      // Three payload lengths: three different paddings before the table.
      for (const n of [64, 61, 57]) {
        const exe = await oneClickBytes(n);
        pads.add((8 - exe.length % 8) % 8);
        await Deno.writeFile(join(dir, `plain${n}.exe`), exe);
        await Deno.writeFile(join(dir, `signed${n}.exe`), fakeSigned(exe));
        names.push(`plain${n}.exe`, `signed${n}.exe`);
      }
      assertEquals(pads.size, 3, "fixture: one padding only");
      const exe = await oneClickBytes(64);
      await Deno.writeFile(
        join(dir, "junk.exe"),
        Uint8Array.from([...exe, ...new Uint8Array(4096)]),
      );
      // A program that is no one-click .exe, signed: the stub alone.
      await Deno.writeFile(
        join(dir, "other.exe"),
        fakeSigned(await Deno.readFile(prebuiltStubPath())),
      );
      names.push("junk.exe", "other.exe");
      const out = await ps(
        "run.ps1",
        names.map((n) =>
          `"${n} $(Test-OneClickExe '${join(dir, n)}') ` +
          `$(Test-OneClickInstallSwitch '${join(dir, n)}')"`
        ).join("; "),
      );
      assertEquals(out.split("\n"), [
        "plain64.exe True True",
        "signed64.exe True True",
        "plain61.exe True True",
        "signed61.exe True True",
        "plain57.exe True True",
        "signed57.exe True True",
        "junk.exe False False",
        "other.exe False False",
      ]);
    } finally {
      await dropTempDir(dir);
    }
  },
});

// `& $installed; exit $LASTEXITCODE` does not wait for a window program and
// never sets $LASTEXITCODE: the script exited with whatever git had left.
Deno.test("run.ps1: a one-click .exe is started through its stub's own exit code, never a stale $LASTEXITCODE", async () => {
  const text = await Deno.readTextFile(join(ROOT, "run.ps1"));
  const tail = text.slice(text.lastIndexOf('Info "running $installed"'));
  const oneClick = tail.indexOf("if (Test-OneClickExe $installed) {");
  assert(oneClick > 0, tail);
  assertStringIncludes(tail, "$code = Start-OneClickExe $installed $AppArgs");
  assertStringIncludes(tail, "exit $code");
  assert(oneClick < tail.indexOf("& $installed @AppArgs"));
  const start = text.slice(
    text.indexOf("function Start-OneClickExe("),
    text.indexOf("function Invoke-AioRun"),
  );
  // The stub is waited for alone: `Start-Process -Wait` waits for the app.
  assertStringIncludes(start, "$p.WaitForExit()");
  assertStringIncludes(start, "$p = Start-Process @with");
  assert(!start.includes("Wait = ") && !start.includes("NoNewWindow = "));
  assertStringIncludes(start, "return $p.ExitCode");
});

Deno.test({
  name:
    "run.ps1 (run under Windows PowerShell): ConvertTo-NativeArg quotes what Start-Process would split",
  ignore: !WINDOWS, // Windows PowerShell exists only there
  async fn() {
    const out = await ps(
      "run.ps1",
      `ConvertTo-NativeArg 'plain'; ConvertTo-NativeArg 'two words'; ` +
        `ConvertTo-NativeArg ''; ConvertTo-NativeArg 'say "hi"'; ` +
        `ConvertTo-NativeArg 'C:\\dir with space\\'; ConvertTo-NativeArg 'C:\\plain\\'`,
    );
    assertEquals(out.split("\n"), [
      "plain",
      '"two words"',
      '""',
      '"say \\"hi\\""',
      '"C:\\dir with space\\\\"',
      "C:\\plain\\",
    ]);
  },
});
