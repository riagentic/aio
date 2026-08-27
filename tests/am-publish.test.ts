// `am publish` — the verb that was missing.
//
// Every piece of a release existed (`deno task build`, `aio ship`,
// `--channel-dir`) and the LAYOUT that ties them together lived only in prose:
// "copy these two files into <base>/<channel>/". Both documented flows were
// wrong in practice, and both fail the same way — silently, permanently, on the
// users' machines ("no updates available"). A layout that is knowledge is a
// layout that is sometimes wrong; this makes it a command.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { cmdPublish } from "../src/am/am-cmd-publish.ts";

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

Deno.test("am publish: writes the channel layout a client actually fetches", async () => {
  const orig = Deno.cwd();
  const dir = await project([{ target: "browser", file: "notes" }]);
  try {
    Deno.chdir(dir);
    const lines = await capture(() =>
      cmdPublish(["--no-build", "--dir=release"], { json: true })
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
