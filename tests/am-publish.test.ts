// `am publish` — the verb that was missing.
//
// Every piece of a release existed (`deno task build`, `aio ship`,
// `--channel-dir`) and the LAYOUT that ties them together lived only in prose:
// "copy these two files into <base>/<channel>/". Both documented flows were
// wrong in practice, and both fail the same way — silently, permanently, on the
// users' machines ("no updates available"). A layout that is knowledge is a
// layout that is sometimes wrong; this makes it a command.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  choiceList,
  cmdPublish,
  notProbedHere,
  pickUpdateArtifact,
} from "../src/am/am-cmd-publish.ts";
import { hostPlatform } from "../src/build/platforms.ts";

/** Capture stdout (am writes its JSON document to console.log). */
async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return lines;
}

/** A project with a finished build in `dist/` — the `--no-build` starting point. */
async function project(
  targets: { target: string; file: string; platform?: string }[],
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "am-publish-" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      appId: "notes",
      version: "2.1.0",
      entry: "src/app.ts",
      build: { targets: targets.map((t) => t.target), out: "dist" },
    }),
  );
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(join(dir, "src", "app.ts"), `fetch("x");`);
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  for (const t of targets) {
    await Deno.writeTextFile(join(dir, "dist", t.file), `#!/bin/sh\nexit 0\n`);
  }
  await Deno.writeTextFile(
    join(dir, "dist", "manifest.json"),
    JSON.stringify({
      app: "notes",
      targets: targets.map((t) => ({
        target: t.target,
        ok: true,
        // Not runnable here: a stub file is not a binary, and a cross-compiled
        // artifact is the real version of the same situation.
        host: false,
        platform: t.platform ?? "linux",
        artifacts: [{ file: t.file }],
      })),
    }),
  );
  return dir;
}

/** Run with HOME pointed at a fresh dir: `am publish` signs with
 *  `~/.aio/keys/<app>-release-key.json` when it exists, so a key on the
 *  developer's machine must not decide what this test sees. */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await Deno.makeTempDir({ prefix: "aio-publish-home-" });
  const prev = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prev);
    await Deno.remove(home, { recursive: true });
  }
}

/** console.error lines, alongside capture()'s console.log ones. */
async function captureErr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return lines;
}

Deno.test("am publish: writes the channel layout a client actually fetches", async () => {
  const orig = Deno.cwd();
  const dir = await project([{ target: "browser", file: "notes" }]);
  try {
    Deno.chdir(dir);
    let errs: string[] = [];
    const lines = await withHome(() =>
      capture(async () => {
        errs = await captureErr(() =>
          cmdPublish(["--no-build", "--dir=release"], { json: true })
        );
      })
    );
    // The warning reaches a CI log too — json mode used to emit
    // `"signed":false` and nothing else.
    assert(
      errs.some((l) => l.includes("warning: UNSIGNED")),
      `json mode warns on stderr: ${errs.join("|")}`,
    );
    const doc = JSON.parse(lines.at(-1)!) as {
      channel: string;
      signed: boolean;
      releases: { manifest: string; artifact: string; name: string }[];
    };
    assertEquals(doc.channel, "prod");
    assertEquals(doc.signed, false, "unsigned unless a key is given");
    // THE thing that was only ever prose: the manifest at the path the client
    // requests, and the artifact BESIDE it.
    assertEquals(doc.releases[0]!.manifest, "prod/linux-x86_64.json");
    assertEquals(doc.releases[0]!.artifact, "prod/notes");
    // …and the release is named for the APP, not the file that was built.
    assertEquals(doc.releases[0]!.name, "notes");
    for (const f of ["prod/linux-x86_64.json", "prod/notes"]) {
      assert(
        (await Deno.stat(join(dir, "release", f))).isFile,
        `${f} must exist — a manifest without its artifact is a 404 at ` +
          `download time`,
      );
    }
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

// A client fetches ONE manifest per platform. Two artifacts built for the same
// platform (a browser binary and a cli binary, both linux-x86_64) claim one
// name, and publishing both would leave only the last — silently.
Deno.test("am publish: refuses two artifacts for one platform, and says how to choose", async () => {
  const orig = Deno.cwd();
  const dir = await project([
    { target: "browser", file: "notes" },
    { target: "cli", file: "notes-cli" },
  ]);
  const exit = Deno.exit;
  let code: number | undefined;
  try {
    Deno.chdir(dir);
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = (c?: number) => {
      code = c;
      throw new Error("exited");
    };
    const lines = await capture(async () => {
      try {
        await cmdPublish(["--no-build", "--dir=release"], { json: true });
      } catch { /* the stubbed exit */ }
    });
    assertEquals(code, 1);
    const err = JSON.parse(lines.at(-1)!) as { error: string };
    assert(err.error.includes("ONE manifest per platform"), err.error);
    assert(err.error.includes("--target=cli"), err.error);
    assert(err.error.includes("--target=browser"), err.error);

    // …and naming one publishes exactly that one.
    code = undefined;
    const ok = await capture(() =>
      cmdPublish(["--no-build", "--dir=release", "--target=cli"], {
        json: true,
      })
    );
    const doc = JSON.parse(ok.at(-1)!) as {
      releases: { target: string; artifact: string }[];
    };
    assertEquals(doc.releases.length, 1);
    assertEquals(doc.releases[0]!.target, "cli");
    assertEquals(doc.releases[0]!.artifact, "prod/notes-cli");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = exit;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

// A fleet entry can produce COMPANION files beside its program: the
// `server`/`server-app` targets emit a systemd unit next to the binary. Those
// two files arrived at the one-manifest-per-platform guard as two competing
// targets, so it refused — with a message whose suggested fix was already in
// effect ("both build for linux … --target=server (or --target=server)").
// `server` and `server-app` were therefore impossible to publish at all, and
// the message could not have told anyone why.
Deno.test("am publish: a companion file beside the binary is not a rival release", async () => {
  const orig = Deno.cwd();
  const dir = await Deno.makeTempDir({ prefix: "am-publish-server-" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      appId: "notes",
      version: "2.1.0",
      entry: "src/app.ts",
      build: { targets: ["server"], out: "dist" },
    }),
  );
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(join(dir, "src", "app.ts"), `fetch("x");`);
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(join(dir, "dist", "notes"), `#!/bin/sh\nexit 0\n`);
  // The unit file: real text, no program magic — exactly what the build writes.
  await Deno.writeTextFile(
    join(dir, "dist", "notes.service"),
    `[Unit]\nDescription=notes\n\n[Service]\nExecStart=/usr/local/bin/notes\n`,
  );
  await Deno.writeTextFile(
    join(dir, "dist", "manifest.json"),
    JSON.stringify({
      app: "notes",
      targets: [{
        target: "server",
        ok: true,
        host: false,
        platform: "linux",
        artifacts: [{ file: "notes" }, { file: "notes.service" }],
      }],
    }),
  );
  try {
    Deno.chdir(dir);
    const lines = await capture(() =>
      cmdPublish(["--no-build", "--dir=release"], { json: true })
    );
    const res = JSON.parse(lines.at(-1)!) as {
      releases: { artifact: string }[];
      skipped: string[];
    };
    assertEquals(res.releases.length, 1, JSON.stringify(res));
    assertEquals(res.releases[0]!.artifact, join("prod", "notes"));
    // Not silently dropped — a file the publisher built and this command chose
    // not to publish is reported, or "published" reads as "published all of it".
    assertEquals(res.skipped, ["notes.service"]);
    // The program is in the channel; the companion is not.
    await Deno.stat(join(dir, "release", "prod", "notes"));
    await assertRejects(() =>
      Deno.stat(join(dir, "release", "prod", "notes.service"))
    );
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// The data contract is a property of the SOURCE, not of the platform.
//
// `am publish` used to hand a contract only to artifacts it could execute, so
// publishing linux+windows+macos from a Linux box left the Windows and macOS
// manifests with none — and every install of those that already held data
// refused every release, permanently, with a message telling the publisher to
// re-publish with `aio ship`, which is exactly what they had just done. The
// same `cell()` declarations compile into every artifact of one build, so the
// host answer IS the answer.
Deno.test("am publish: one build's contract is stamped into every platform", async () => {
  const orig = Deno.cwd();
  const dir = await Deno.makeTempDir({ prefix: "am-publish-xplat-" });
  const CONTRACT = {
    schema: 1,
    cells: { vault: { version: 2, migratesFrom: 1 } },
  };
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.mkdir(join(dir, "dist"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ appId: "notes", version: "2.1.0", entry: "src/app.ts" }),
    );
    await Deno.writeTextFile(join(dir, "src", "app.ts"), `fetch("x");`);
    // The host artifact ANSWERS the probe; the other two cannot run here.
    await Deno.writeTextFile(
      join(dir, "dist", "notes"),
      `#!/bin/sh\nif [ "$1" = "--aio-data-contract" ]; then\n  echo '${
        JSON.stringify(CONTRACT)
      }'\n  exit 0\nfi\nexit 0\n`,
    );
    await Deno.chmod(join(dir, "dist", "notes"), 0o755);
    await Deno.writeTextFile(join(dir, "dist", "notes.exe"), "MZ fake windows");
    await Deno.writeTextFile(
      join(dir, "dist", "manifest.json"),
      JSON.stringify({
        app: "notes",
        targets: [
          // Deliberately NOT host-first, so the ordering is what fixes it.
          {
            target: "windows",
            ok: true,
            host: false,
            platform: "windows",
            artifacts: [{ file: "notes.exe" }],
          },
          {
            target: "browser",
            ok: true,
            host: true,
            platform: "linux",
            artifacts: [{ file: "notes" }],
          },
        ],
      }),
    );
    Deno.chdir(dir);
    const lines = await capture(() =>
      cmdPublish(["--no-build", "--dir=release"], { json: true })
    );
    const res = JSON.parse(lines.at(-1)!) as {
      releases: { artifact: string }[];
      contractStampedInto: string[];
      noContract: string[];
    };
    assertEquals(res.releases.length, 2);
    // The cross-compiled manifest carries the host's contract…
    assertEquals(res.contractStampedInto, ["notes.exe"]);
    // …and nothing went out contract-less, which is the whole point.
    assertEquals(res.noContract, []);
    const wrote = [...Deno.readDirSync(join(dir, "release", "prod"))].map((e) =>
      e.name
    ).sort();
    assertEquals(
      wrote.filter((n) => n.endsWith(".json")),
      ["linux-x86_64.json", "windows-x86_64.json"],
      "one manifest per platform, each under the name its client requests",
    );
    const win = JSON.parse(
      await Deno.readTextFile(
        join(dir, "release", "prod", "windows-x86_64.json"),
      ),
    ) as { data?: unknown };
    assertEquals(win.data, CONTRACT, "the Windows manifest must carry it");
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// `--data` / `--no-data` are the operator's answer for a directly-run artifact
// too: they were silently ignored there (only a `.app` honoured them), the
// artifact was run anyway, and --data=<file> was never read. Without either
// flag it is still asked, as before.
Deno.test("am publish: --data and --no-data outrank running the host artifact; no flag still runs it", async () => {
  if (Deno.build.os === "windows") return; // the stub artifact is a shell script
  const orig = Deno.cwd();
  const dir = await tempDir("am-publish-exec-flags-");
  const asked = { schema: 1, cells: { notes: { version: 4 } } };
  const given = { schema: 1, cells: { notes: { version: 9 } } };
  const ran = join(dir, "ran");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.mkdir(join(dir, "dist"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ appId: "notes", version: "2.1.0", entry: "src/app.ts" }),
    );
    await Deno.writeTextFile(join(dir, "src", "app.ts"), `fetch("x");`);
    await Deno.writeTextFile(
      join(dir, "dist", "notes"),
      `#!/bin/sh\nif [ "$1" = "--aio-data-contract" ]; then\n  echo x >> '${ran}'\n  echo '${
        JSON.stringify(asked)
      }'\nfi\nexit 0\n`,
    );
    await Deno.chmod(join(dir, "dist", "notes"), 0o755);
    await Deno.writeTextFile(join(dir, "contract.json"), JSON.stringify(given));
    await Deno.writeTextFile(
      join(dir, "dist", "manifest.json"),
      JSON.stringify({
        app: "notes",
        targets: [{
          target: "browser",
          ok: true,
          host: true,
          platform: "linux",
          artifacts: [{ file: "notes" }],
        }],
      }),
    );
    Deno.chdir(dir);
    for (
      const [i, flags, want, runs] of [
        [1, ["--data=contract.json"], given, false],
        [2, ["--no-data"], undefined, false],
        [3, [], asked, true],
      ] as const
    ) {
      await Deno.remove(ran).catch(() => {});
      const r = await publishExit(["--no-build", ...flags, `--dir=rel-${i}`]);
      assertEquals(r.code, undefined, [...r.out, ...r.err].join("\n"));
      const doc = JSON.parse(r.out.at(-1)!) as {
        releases: { manifest: string }[];
      };
      const m = JSON.parse(
        await Deno.readTextFile(
          join(dir, `rel-${i}`, doc.releases[0]!.manifest),
        ),
      ) as { data?: unknown };
      assertEquals(m.data, want, flags.join(" ") || "no flag");
      assertEquals(
        await Deno.stat(ran).then(() => true, () => false),
        runs,
        `${flags.join(" ") || "no flag"}: the artifact was ${
          runs ? "not " : ""
        }run`,
      );
    }
  } finally {
    Deno.chdir(orig);
    await dropTempDir(dir);
  }
});

// ── The key `ship keygen` wrote is the key publish uses ──────────────
//
// `defaultKeyPath(app)` is where keygen writes and what every hint names, yet
// publish ignored it unless the same path was typed back as --key: a release
// went out unsigned one command after the key was made.
Deno.test("am publish: signs with the keygen default key when it exists, and says so", async () => {
  const orig = Deno.cwd();
  const dir = await project([{ target: "browser", file: "notes" }]);
  try {
    Deno.chdir(dir);
    await withHome(async (home) => {
      const { defaultKeyPath, generateSigningKey } = await import(
        "../src/build/ship.ts"
      );
      const keyPath = defaultKeyPath("notes");
      assert(keyPath.startsWith(home), "keyed on HOME");
      await Deno.mkdir(join(home, ".aio", "keys"), { recursive: true });
      await Deno.writeTextFile(
        keyPath,
        JSON.stringify(await generateSigningKey()),
      );
      let errs: string[] = [];
      const lines = await capture(async () => {
        errs = await captureErr(() =>
          cmdPublish(["--no-build", "--dir=release"], { json: true })
        );
      });
      const doc = JSON.parse(lines.at(-1)!) as {
        signed: boolean;
        key: { path: string; source: string } | null;
      };
      assertEquals(doc.signed, true, "the default key signs");
      assertEquals(doc.key, { path: keyPath, source: "default" });
      assert(
        errs.some((l) => l.includes(`signed with ${keyPath}`)),
        `says which key: ${errs.join("|")}`,
      );
      assert(!errs.some((l) => l.includes("UNSIGNED")));
    });
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

// ── macOS: the .dmg is the first download, the .app.tar.gz is the update ────

/** A macOS Electron build as the Mac host leaves it: a disk image (known only
 *  by its `koly` trailer) and, when the Mac signed the bundle, the sealed
 *  `.app.tar.gz` beside it. */
async function macProject(
  withTarball: boolean,
  built: { host: boolean; builtOn?: string; platform?: string | null } = {
    host: false,
  },
): Promise<string> {
  const dir = await tempDir("am-publish-mac-");
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      appId: "notes",
      version: "2.1.0",
      entry: "src/app.ts",
      build: { targets: ["electron"], out: "dist" },
    }),
  );
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(join(dir, "src", "app.ts"), `fetch("x");`);
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  const dmg = new Uint8Array(8192);
  dmg.set(new TextEncoder().encode("koly"), dmg.length - 512);
  await Deno.writeFile(join(dir, "dist", "notes-2.1.0-mac-x64.dmg"), dmg);
  const files = ["notes-2.1.0-mac-x64.dmg"];
  if (withTarball) {
    await Deno.writeFile(
      join(dir, "dist", "notes-2.1.0-mac-x64.app.tar.gz"),
      new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]),
    );
    files.push("notes-2.1.0-mac-x64.app.tar.gz");
  }
  await Deno.writeTextFile(
    join(dir, "dist", "manifest.json"),
    JSON.stringify({
      app: "notes",
      ...(built.builtOn ? { builtOn: built.builtOn } : {}),
      targets: [{
        target: "electron",
        ok: true,
        host: built.host,
        ...(built.platform === null
          ? {}
          : { platform: built.platform ?? "macos" }),
        triple: "x86_64-apple-darwin",
        artifacts: files.map((file) => ({ file })),
      }],
    }),
  );
  return dir;
}

type MacDoc = {
  releases: { artifact: string; manifest: string }[];
  skipped: string[];
  downloads: string[];
  stranded: string[];
};

Deno.test("am publish: a .dmg is the download, the .app.tar.gz is the electron-app release", async () => {
  const orig = Deno.cwd();
  const dir = await macProject(true);
  try {
    Deno.chdir(dir);
    let errs: string[] = [];
    const lines = await withHome(() =>
      capture(async () => {
        errs = await captureErr(() =>
          cmdPublish(["--no-build", "--no-data", "--dir=release"], {
            json: true,
          })
        );
      })
    );
    const doc = JSON.parse(lines.at(-1)!) as MacDoc;
    // Before: the dmg (no magic in its first bytes) landed in `skipped` and
    // the release went out with no macOS at all.
    assertEquals(doc.skipped, []);
    assertEquals(doc.downloads, ["notes-2.1.0-mac-x64.dmg"]);
    assertEquals(doc.stranded, []);
    assertEquals(doc.releases.length, 1);
    assertEquals(
      doc.releases[0]!.artifact,
      join("prod", "notes-2.1.0-mac-x64.app.tar.gz"),
    );
    const m = JSON.parse(
      await Deno.readTextFile(join(dir, "release", doc.releases[0]!.manifest)),
    ) as { target: string; url: string; platform: { os: string } };
    assertEquals(m.target, "electron-app");
    assertEquals(m.platform.os, "darwin");
    assertEquals(m.url, "notes-2.1.0-mac-x64.app.tar.gz");
    // The dmg sits beside it, for a first install.
    await Deno.stat(join(dir, "release", "prod", "notes-2.1.0-mac-x64.dmg"));
    assert(!errs.some((l) => l.includes("NO update manifest")), errs.join("|"));
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

// A NATIVE Mac build records `host: true`. Its `.app.tar.gz` used to be exec'd
// for its data contract — on the Mac (an archive is no program) and from
// Linux (another machine's host) alike — and refused as a "BROKEN BUILD".
Deno.test("am publish: a Mac-built .app.tar.gz takes --data, never an exec of the archive", async () => {
  for (const builtOn of ["macos", hostPlatform()]) {
    const orig = Deno.cwd();
    const dir = await macProject(true, { host: true, builtOn });
    try {
      Deno.chdir(dir);
      const contract = { schema: 1, cells: { notes: { version: 3 } } };
      await Deno.writeTextFile("contract.json", JSON.stringify(contract));
      const lines = await withHome(() =>
        capture(() =>
          cmdPublish(
            ["--no-build", "--data=contract.json", "--dir=release"],
            { json: true },
          )
        )
      );
      const doc = JSON.parse(lines.at(-1)!) as MacDoc;
      assertEquals(doc.releases.length, 1, `${builtOn}: ${lines.at(-1)}`);
      const m = JSON.parse(
        await Deno.readTextFile(
          join(dir, "release", doc.releases[0]!.manifest),
        ),
      ) as { target: string; data: unknown };
      assertEquals(m.target, "electron-app");
      assertEquals(m.data, contract, builtOn);
    } finally {
      Deno.chdir(orig);
      await Deno.remove(dir, { recursive: true });
    }
  }
});

// `host` is the BUILD machine's word. A Mac binary built natively and published
// from here cannot be run here to ask its contract.
Deno.test("am publish: another machine's host binary is not exec'd here", async () => {
  const other = hostPlatform() === "linux" ? "macos" : "linux";
  const orig = Deno.cwd();
  const dir = await tempDir("am-publish-builton-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ appId: "notes", version: "2.1.0", entry: "src/app.ts" }),
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "app.ts"), `fetch("x");`);
    await Deno.mkdir(join(dir, "dist"));
    // Mach-O / ELF magic, then nothing runnable.
    const magic = other === "macos"
      ? [0xcf, 0xfa, 0xed, 0xfe]
      : [0x7f, 0x45, 0x4c, 0x46];
    await Deno.writeFile(
      join(dir, "dist", "notes"),
      new Uint8Array([...magic, 0, 0, 0, 0]),
    );
    await Deno.writeTextFile(
      join(dir, "dist", "manifest.json"),
      JSON.stringify({
        app: "notes",
        builtOn: other,
        targets: [{
          target: "cli",
          ok: true,
          host: true,
          platform: other,
          artifacts: [{ file: "notes" }],
        }],
      }),
    );
    await Deno.writeTextFile(join(dir, "c.json"), `{"schema":1,"cells":{}}`);
    Deno.chdir(dir);
    const lines = await withHome(() =>
      capture(() =>
        cmdPublish(["--no-build", "--data=c.json", "--dir=release"], {
          json: true,
        })
      )
    );
    const doc = JSON.parse(lines.at(-1)!) as { releases: unknown[] };
    assertEquals(doc.releases.length, 1, lines.at(-1));
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("am publish: a .dmg with no signed .app beside it is refused, naming the fix", async () => {
  const orig = Deno.cwd();
  const dir = await macProject(false);
  const exit = Deno.exit;
  let code: number | undefined;
  try {
    Deno.chdir(dir);
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = (c?: number) => {
      code = c;
      throw new Error("exited");
    };
    const lines = await withHome(() =>
      capture(async () => {
        try {
          await cmdPublish(["--no-build", "--no-data", "--dir=release"], {
            json: true,
          });
        } catch { /* the stubbed exit */ }
      })
    );
    assertEquals(code, 1);
    const err = (JSON.parse(lines.at(-1)!) as { error: string }).error;
    // Not the old "no artifact for --target=undefined".
    assert(!err.includes("undefined"), err);
    assertStringIncludes(err, "notes-2.1.0-mac-x64.dmg");
    assertStringIncludes(err, ".app.tar.gz");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = exit;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("am publish: a .dmg whose platform got no manifest is warned on stderr", async () => {
  const orig = Deno.cwd();
  const dir = await macProject(false);
  try {
    // A linux program in the same build, so there IS something to publish.
    await Deno.writeTextFile(join(dir, "dist", "notes"), "#!/bin/sh\nexit 0\n");
    const bm = JSON.parse(
      await Deno.readTextFile(join(dir, "dist", "manifest.json")),
    );
    bm.targets.push({
      target: "browser",
      ok: true,
      host: false,
      platform: "linux",
      artifacts: [{ file: "notes" }],
    });
    await Deno.writeTextFile(
      join(dir, "dist", "manifest.json"),
      JSON.stringify(bm),
    );
    Deno.chdir(dir);
    let errs: string[] = [];
    const lines = await withHome(() =>
      capture(async () => {
        errs = await captureErr(() =>
          cmdPublish(["--no-build", "--no-data", "--dir=release"], {
            json: true,
          })
        );
      })
    );
    const doc = JSON.parse(lines.at(-1)!) as MacDoc;
    assertEquals(doc.stranded, ["notes-2.1.0-mac-x64.dmg"]);
    assert(
      errs.some((l) =>
        l.includes("notes-2.1.0-mac-x64.dmg") &&
        l.includes("NO update manifest")
      ),
      errs.join("|"),
    );
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("am publish: the human summary names a skipped file loudly", async () => {
  const orig = Deno.cwd();
  const dir = await project([{ target: "browser", file: "notes" }]);
  const real = Deno.stdout.isTerminal;
  try {
    await Deno.writeTextFile(join(dir, "dist", "notes.sha256"), "abc  notes\n");
    const bm = JSON.parse(
      await Deno.readTextFile(join(dir, "dist", "manifest.json")),
    );
    bm.targets[0].artifacts.push({ file: "notes.sha256" });
    await Deno.writeTextFile(
      join(dir, "dist", "manifest.json"),
      JSON.stringify(bm),
    );
    Deno.chdir(dir);
    Deno.stdout.isTerminal = () => true; // the pretty branch
    const lines = await withHome(() =>
      capture(async () => {
        await captureErr(() =>
          cmdPublish(["--no-build", "--no-data", "--dir=release"], {})
        );
      })
    );
    const text = lines.join("\n");
    assertStringIncludes(text, "⚠ NOT published");
    assertStringIncludes(text, "notes.sha256");
  } finally {
    Deno.stdout.isTerminal = real;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

// The Windows Electron target builds TWO programs for one platform — the
// self-contained `.exe` and the `.zip`. The guard claimed the platform per
// ARTIFACT, read them as two rival targets, and refused every multi-platform
// build that included Windows with "--target=electron (or --target=electron)"
// — a choice that is the same string twice, which no flag could satisfy.
Deno.test("am publish: Windows electron's exe + zip: the exe is the platform's update, the zip gets its own kind manifest", async () => {
  const orig = Deno.cwd();
  const dir = await tempDir("am-publish-win-");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.mkdir(join(dir, "dist"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        appId: "notes",
        version: "2.1.0",
        entry: "src/app.ts",
        build: { targets: ["electron"], platforms: ["linux", "windows"] },
      }),
    );
    await Deno.writeTextFile(join(dir, "src", "app.ts"), `fetch("x");`);
    await Deno.writeTextFile(
      join(dir, "dist", "notes-x86_64.AppImage"),
      "\x7fELF fake appimage",
    );
    await Deno.writeTextFile(
      join(dir, "dist", "notes-win-x64.zip"),
      "PK\x03\x04 fake zip",
    );
    await Deno.writeTextFile(
      join(dir, "dist", "notes-win-x64.exe"),
      "MZ fake exe",
    );
    await Deno.writeTextFile(
      join(dir, "dist", "manifest.json"),
      JSON.stringify({
        app: "notes",
        targets: [
          {
            target: "electron",
            ok: true,
            host: false,
            platform: "linux",
            artifacts: [{ file: "notes-x86_64.AppImage" }],
          },
          {
            target: "electron",
            ok: true,
            host: false,
            platform: "windows",
            // The order the build records them in: zip first.
            artifacts: [{ file: "notes-win-x64.zip" }, {
              file: "notes-win-x64.exe",
            }],
          },
        ],
      }),
    );
    Deno.chdir(dir);
    const lines = await withHome(() =>
      capture(() =>
        cmdPublish(["--no-build", "--dir=release", "--channel=test"], {
          json: true,
        })
      )
    );
    const doc = JSON.parse(lines.at(-1)!) as {
      downloads: string[];
      stranded: string[];
      kindManifests: string[];
      releases: { manifest: string; artifact: string; kind: string }[];
    };
    assertEquals(
      doc.releases.map((r) => [r.manifest, r.artifact, r.kind]).sort(),
      [
        [
          join("test", "linux-x86_64.json"),
          join("test", "notes-x86_64.AppImage"),
          "electron-appimage",
        ],
        // The zip — an install unpacked from it is `electron-zip` and refuses
        // the exe's `binary` release, so it gets its OWN manifest.
        [
          join("test", "windows-x86_64.electron-zip.json"),
          join("test", "notes-win-x64.zip"),
          "electron-zip",
        ],
        // The exe — the double-click download, which updates as `binary`.
        [
          join("test", "windows-x86_64.json"),
          join("test", "notes-win-x64.exe"),
          "binary",
        ],
      ],
    );
    assertEquals(doc.downloads, []);
    assertEquals(doc.kindManifests, [
      join("test", "windows-x86_64.electron-zip.json"),
    ]);
    assertEquals(doc.stranded, []);
    const win = JSON.parse(
      await Deno.readTextFile(
        join(dir, "release", "test", "windows-x86_64.json"),
      ),
    ) as { target: string; url: string };
    assertEquals([win.target, win.url], ["binary", "notes-win-x64.exe"]);
    const zip = JSON.parse(
      await Deno.readTextFile(
        join(dir, "release", "test", "windows-x86_64.electron-zip.json"),
      ),
    ) as { target: string; url: string; platform: { os: string } };
    assertEquals(
      [zip.target, zip.url, zip.platform.os],
      ["electron-zip", "notes-win-x64.zip", "windows"],
    );
    // The dist copy of the exe's manifest is not overwritten by the zip's.
    const distWin = JSON.parse(
      await Deno.readTextFile(join(dir, "dist", "windows-x86_64.json")),
    ) as { target: string };
    assertEquals(distWin.target, "binary");
    await Deno.stat(join(dir, "release", "test", "notes-win-x64.zip"));
  } finally {
    Deno.chdir(orig);
    await dropTempDir(dir);
  }
});

Deno.test("am publish: pickUpdateArtifact — a program beats an archive; a real tie is refused by FILE", () => {
  assertEquals(pickUpdateArtifact(["a.zip", "a.exe"]), {
    file: "a.exe",
    downloads: ["a.zip"],
  });
  // A lone archive is still THE artifact (macOS without a Mac: the `.app` zip).
  assertEquals(pickUpdateArtifact(["a-mac-x64.zip"]), {
    file: "a-mac-x64.zip",
    downloads: [],
  });
  const tie = pickUpdateArtifact(["a", "a-cli"]);
  assert("error" in tie);
  assert(tie.error.includes(`a and a-cli`), tie.error);
});

Deno.test("am publish: choiceList never offers the same choice twice", () => {
  const t = (x: string) => `--target=${x}`;
  assertEquals(
    choiceList(["electron", "electron"], t, "or"),
    "--target=electron",
  );
  assertEquals(
    choiceList(["cli", "browser"], t, "or"),
    "--target=cli or --target=browser",
  );
  assertEquals(choiceList(["a", "b", "a", "c"], (x) => x, "and"), "a, b and c");
});

/** Run cmdPublish with Deno.exit stubbed; returns the exit code (undefined
 *  when it did not exit) and the stdout/stderr lines. */
async function publishExit(
  args: string[],
  deps: Parameters<typeof cmdPublish>[2] = {},
): Promise<{ code?: number; out: string[]; err: string[] }> {
  const exit = Deno.exit;
  let code: number | undefined;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    code = c;
    throw new Error("exited");
  };
  let err: string[] = [];
  try {
    const out = await withHome(() =>
      capture(async () => {
        err = await captureErr(async () => {
          try {
            await cmdPublish(args, { json: true }, deps);
          } catch (e) {
            if (code === undefined) throw e;
          }
        });
      })
    );
    return { code, out, err };
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = exit;
  }
}

// A dist/manifest.json that records ONE target twice for one platform (a
// hand-merged or corrupted build record) is not a choice between targets:
// offering "--target=browser or --target=browser" is no way out.
Deno.test("am publish: one target recorded twice for a platform says rebuild, not pick", async () => {
  const orig = Deno.cwd();
  const dir = await project([
    { target: "browser", file: "notes" },
    { target: "browser", file: "notes-2" },
  ]);
  try {
    Deno.chdir(dir);
    const r = await publishExit(["--no-build", "--dir=release"]);
    assertEquals(r.code, 1);
    const err = (JSON.parse(r.out.at(-1)!) as { error: string }).error;
    assertStringIncludes(err, `records "browser" twice for linux`);
    assertStringIncludes(err, "rebuild (deno task build)");
    assert(!err.includes("Pick which one"), err);
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

/** A real `.app.tar.gz`: `notes.app/Contents/{Info.plist,MacOS/notes}`,
 *  whose executable answers `--aio-data-contract` like an aio binary. */
async function packMacApp(dir: string, contract: unknown): Promise<void> {
  const stage = join(dir, "stage");
  const macos = join(stage, "notes.app", "Contents", "MacOS");
  await Deno.mkdir(macos, { recursive: true });
  await Deno.writeTextFile(
    join(stage, "notes.app", "Contents", "Info.plist"),
    `<?xml version="1.0"?><plist><dict>\n<key>CFBundleExecutable</key>\n` +
      `<string>notes</string>\n</dict></plist>\n`,
  );
  await Deno.writeTextFile(
    join(macos, "notes"),
    `#!/bin/sh\nif [ "$1" = "--aio-data-contract" ]; then\n  echo '${
      JSON.stringify(contract)
    }'\n  exit 0\nfi\nexit 3\n`,
  );
  await Deno.chmod(join(macos, "notes"), 0o755);
  const tar = await new Deno.Command("tar", {
    args: [
      "-czf",
      join(dir, "dist", "notes-2.1.0-mac-x64.app.tar.gz"),
      "-C",
      stage,
      "notes.app",
    ],
  }).output();
  assert(tar.success, "tar");
  await Deno.remove(stage, { recursive: true });
}

// A native Mac build's `.app.tar.gz` is an archive, so it was never asked its
// contract: with no other artifact and no --data, it went out `noData`, and
// every Mac install holding data refused every release. On a Mac it is now
// unpacked and its own executable asked.
Deno.test("am publish: on a Mac, a Mac-built .app.tar.gz is unpacked and asked its data contract", async () => {
  const orig = Deno.cwd();
  const dir = await macProject(true, { host: true, builtOn: "macos" });
  const contract = { schema: 1, cells: { notes: { version: 4 } } };
  try {
    await packMacApp(dir, contract);
    Deno.chdir(dir);
    const r = await publishExit(["--no-build", "--dir=release"], {
      hostPlatform: () => "macos",
    });
    assertEquals(r.code, undefined, r.out.join("\n"));
    const doc = JSON.parse(r.out.at(-1)!) as MacDoc & {
      noContract: string[];
    };
    assertEquals(doc.noContract, []);
    const m = JSON.parse(
      await Deno.readTextFile(join(dir, "release", doc.releases[0]!.manifest)),
    ) as { target: string; data: unknown };
    assertEquals(m.target, "electron-app");
    assertEquals(m.data, contract);
    assert(!r.err.some((l) => l.includes("WITHOUT a data contract")));
  } finally {
    Deno.chdir(orig);
    await dropTempDir(dir);
  }
});

// `--data` / `--no-data` are the operator stating the contract: the bundle's
// own answer used to override both — `--data` was ignored, and `--no-data`
// published a contract anyway.
Deno.test("am publish: on a Mac, --data and --no-data outrank asking the .app", async () => {
  const orig = Deno.cwd();
  const dir = await macProject(true, { host: true, builtOn: "macos" });
  const asked = { schema: 1, cells: { notes: { version: 4 } } };
  const given = { schema: 1, cells: { notes: { version: 9 } } };
  try {
    await packMacApp(dir, asked);
    await Deno.writeTextFile(join(dir, "contract.json"), JSON.stringify(given));
    Deno.chdir(dir);
    for (
      const [flag, want] of [
        ["--data=contract.json", given],
        ["--no-data", undefined],
      ] as const
    ) {
      const r = await publishExit(
        ["--no-build", flag, `--dir=release-${flag.length}`],
        { hostPlatform: () => "macos" },
      );
      assertEquals(r.code, undefined, r.out.join("\n"));
      const doc = JSON.parse(r.out.at(-1)!) as MacDoc;
      const m = JSON.parse(
        await Deno.readTextFile(
          join(dir, `release-${flag.length}`, doc.releases[0]!.manifest),
        ),
      ) as { data?: unknown };
      assertEquals(m.data, want, flag);
    }
  } finally {
    Deno.chdir(orig);
    await dropTempDir(dir);
  }
});

// A `host` artifact is the BUILD machine's: another Mac (another arch) is not
// that machine, so its bundle is not exec'd here as if it were.
Deno.test("am publish: a host .app built on another Mac is not asked on this one", async () => {
  const orig = Deno.cwd();
  const dir = await macProject(true, {
    host: true,
    builtOn: "macos",
    platform: null,
  });
  try {
    await packMacApp(dir, { schema: 1, cells: {} });
    Deno.chdir(dir);
    const r = await publishExit(["--no-build", "--dir=release"], {
      hostPlatform: () => "macos-arm64",
    });
    assertEquals(r.code, 1, r.out.join("\n"));
    const err = (JSON.parse(r.out.at(-1)!) as { error: string }).error;
    assertStringIncludes(
      err,
      "a .app built on macos, and this Mac is macos-arm64",
    );
  } finally {
    Deno.chdir(orig);
    await dropTempDir(dir);
  }
});

// Where nothing can ask it (not a Mac, nothing else in the build), a Mac
// `.app` is refused the way `aio ship` refuses: no silent contract-less
// release. `--no-data` publishes on purpose, and the warning — the reason
// per file, never the false "no artifact runs on this machine" — is on
// stderr in --json mode too.
Deno.test("am publish: a Mac .app nobody here can ask is refused without --data/--no-data", async () => {
  const orig = Deno.cwd();
  const dir = await macProject(true, { host: true, builtOn: "macos" });
  try {
    Deno.chdir(dir);
    const refused = await publishExit(["--no-build", "--dir=release"], {
      hostPlatform: () => "linux",
    });
    assertEquals(refused.code, 1);
    const err = (JSON.parse(refused.out.at(-1)!) as { error: string }).error;
    assertStringIncludes(err, "notes-2.1.0-mac-x64.app.tar.gz");
    assertStringIncludes(err, "only a Mac can unpack and run it");
    assertStringIncludes(err, "--no-data");
    assertStringIncludes(err, "--data=contract.json");

    const ok = await publishExit(["--no-build", "--no-data", "--dir=release"], {
      hostPlatform: () => "linux",
    });
    assertEquals(ok.code, undefined, ok.out.join("\n"));
    const doc = JSON.parse(ok.out.at(-1)!) as { noContract: string[] };
    assertEquals(doc.noContract, ["notes-2.1.0-mac-x64.app.tar.gz"]);
    const warn = ok.err.find((l) => l.includes("WITHOUT a data contract"));
    assert(warn, `json mode warns on stderr: ${ok.err.join("|")}`);
    assertStringIncludes(warn, "notes-2.1.0-mac-x64.app.tar.gz (--no-data)");
    assert(!warn.includes("runs on this machine"), warn);
  } finally {
    Deno.chdir(orig);
    await dropTempDir(dir);
  }
});

Deno.test("am publish: notProbedHere names the precise reason", () => {
  const base = { format: null, builtOn: undefined, here: "linux" };
  assertStringIncludes(
    notProbedHere({ ...base, file: "a.app.tar.gz", platform: "macos" }),
    "only a Mac can unpack and run it, and this machine is linux",
  );
  assertStringIncludes(
    notProbedHere({
      ...base,
      file: "a.app.tar.gz",
      platform: "macos-arm64",
      here: "macos",
    }),
    "a macos-arm64 .app, and this Mac is macos",
  );
  assertEquals(
    notProbedHere({ ...base, file: "a.zip", format: "ZIP", platform: "linux" }),
    "an archive, not a program",
  );
  assertEquals(
    notProbedHere({
      ...base,
      file: "a.exe",
      format: "PE",
      platform: "windows",
    }),
    "built for windows, and this machine is linux",
  );
  assertEquals(
    notProbedHere({
      ...base,
      file: "a",
      format: "ELF",
      platform: "linux",
      builtOn: "macos",
    }),
    "built on macos, and this machine is linux",
  );
});
