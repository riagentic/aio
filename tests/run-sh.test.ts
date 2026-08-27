// run.sh — fast, always-on checks (no network, no build). The full
// build-and-run path lives in tests/run-sh-e2e.test.ts behind the onboard gate.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(fromFileUrl(import.meta.url)).replace(/\/tests$/, "");
const dec = new TextDecoder();

Deno.test("run.sh: valid POSIX syntax (sh -n)", async () => {
  const p = await new Deno.Command("sh", {
    args: ["-n", join(REPO_ROOT, "run.sh")],
    stderr: "piped",
  }).output();
  assertEquals(p.code, 0, dec.decode(p.stderr));
});

Deno.test("run.sh: an unknown flag fails loud, before touching anything", async () => {
  const p = await new Deno.Command("sh", {
    args: [join(REPO_ROOT, "run.sh"), "--bogus"],
    cwd: await Deno.makeTempDir(),
    stderr: "piped",
    stdout: "piped",
  }).output();
  assertEquals(p.code, 1);
  const err = dec.decode(p.stderr);
  assert(err.includes("unknown flag: --bogus"), err);
  assert(err.includes("--dev"), "the error names the valid flags");
});

Deno.test("run.sh: --git without a URL fails loud", async () => {
  const p = await new Deno.Command("sh", {
    args: [join(REPO_ROOT, "run.sh"), "--git"],
    cwd: await Deno.makeTempDir(),
    stderr: "piped",
    stdout: "piped",
  }).output();
  assertEquals(p.code, 1);
  assert(dec.decode(p.stderr).includes("--git needs a URL"));
});

Deno.test("run.sh: the artifact is launched with a private TMPDIR, not /tmp", async () => {
  // An AppImage unpacks itself into $TMPDIR BEFORE any aio code runs, so the
  // launcher is the only place that can decide where. /tmp is shared: the
  // extract path's dir name is a digest of the AppImage (predictable, 0755), a
  // second user running the same file lands in the first user's copy, and the
  // runtime warns-but-continues into whatever tree is already there.
  const src = await Deno.readTextFile(join(REPO_ROOT, "run.sh"));
  const exec = src.indexOf('exec "$artifact"');
  assert(exec > 0, "run.sh no longer execs the artifact — update this guard");
  const before = src.slice(0, exec);
  assert(
    /export TMPDIR=/.test(before),
    "run.sh must export a private TMPDIR before exec'ing the artifact",
  );
  // ...and it must ASK for the path rather than rebuild an app's identity in
  // shell: two copies of that rule split an app's address (payload under one
  // directory, data under another) the moment either one moves.
  assert(
    before.includes("--print-app-tmpdir"),
    "the path must come from the build, not from a shell-side naming rule",
  );
  assert(
    /chmod 700 "\$app_tmpdir"/.test(before),
    "$HOME is 0755 on most distros — moving out of /tmp without 0700 fixes nothing",
  );
});

// The one-liner used to call install.sh ONLY when deno/am/the checkout was
// missing, so a box that had installed aio once kept that am forever — the
// newest run.sh, running the oldest am. install.sh is idempotent, so the fix is
// to always run it. This pins that the call is unconditional in BOTH scripts.
Deno.test("run.sh + run.ps1: install.sh runs every time — am is updated, not merely present", async () => {
  const sh = await Deno.readTextFile(join(REPO_ROOT, "run.sh"));
  const ps = await Deno.readTextFile(join(REPO_ROOT, "run.ps1"));
  // The old guard: the install ran only inside `if ! deno_ok || ! am …`.
  assert(
    !sh.includes("if ! deno_ok ||"),
    "run.sh: install.sh is not gated on absence",
  );
  assert(sh.includes('sh "$AIO_INSTALL"') && sh.includes("updating aio + am"));
  assert(
    !ps.includes("if (-not $denoOk -or"),
    "run.ps1: install.ps1 is not gated on absence",
  );
  assert(ps.includes("& $env:AIO_INSTALL") && ps.includes("updating aio + am"));
});

// `run.sh` with a FAKE install.sh: the fake is invoked even though deno, am
// and the checkout are all present — the behavioural half of the gate above.
Deno.test("run.sh: invokes install.sh even when deno + am + checkout already exist", async () => {
  const tmp = await Deno.makeTempDir();
  const home = join(tmp, "aio-home");
  await Deno.mkdir(join(home, ".git"), { recursive: true });
  await Deno.mkdir(join(home, "src", "server"), { recursive: true });
  await Deno.writeTextFile(
    join(home, "src", "server", "deno-version.ts"),
    'export const MIN_DENO = "0.0.1";\n',
  );
  const bin = join(tmp, "bin");
  await Deno.mkdir(bin);
  await Deno.writeTextFile(join(bin, "am"), "#!/bin/sh\nexit 0\n");
  await Deno.chmod(join(bin, "am"), 0o755);
  const marker = join(tmp, "install-ran");
  const fake = join(tmp, "install.sh");
  await Deno.writeTextFile(fake, `#!/bin/sh\n: > "${marker}"\nexit 0\n`);
  // No deno.json in cwd → run.sh stops right after the install step, which is
  // all this test needs to observe.
  const p = await new Deno.Command("sh", {
    args: [join(REPO_ROOT, "run.sh"), "--no-run"],
    cwd: tmp,
    env: {
      ...Deno.env.toObject(),
      AIO_HOME: home,
      AIO_INSTALL: fake,
      PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = dec.decode(p.stdout);
  assert(out.includes("updating aio + am"), out + dec.decode(p.stderr));
  let ran = true;
  try {
    await Deno.stat(marker);
  } catch {
    ran = false;
  }
  assert(ran, "install.sh was not invoked although everything was present");
  await Deno.remove(tmp, { recursive: true });
});

// Now that install.sh runs on EVERY one-liner, the checkout it may move must
// never be a repo someone works in: run.sh inside a dev clone (AIO_HOME set to
// it, as the e2e suite does) once `git checkout --force <tag>`-ed the
// framework's own working tree and deleted uncommitted edits. A branch or
// local changes = a working checkout = left untouched; am is still installed.
Deno.test("install.sh: never git-mutates a working checkout (on a branch, or dirty)", async () => {
  const tmp = await Deno.makeTempDir();
  const home = join(tmp, "aio-home");
  const git = (...args: string[]) =>
    new Deno.Command("git", {
      args: ["-C", home, ...args],
      stdout: "null",
      stderr: "null",
    }).output();
  await Deno.mkdir(join(home, "src", "server"), { recursive: true });
  await Deno.writeTextFile(
    join(home, "src", "server", "deno-version.ts"),
    'export const MIN_DENO = "0.0.1";\n',
  );
  await Deno.writeTextFile(
    join(home, "src", "am.ts"),
    'console.log("am from a dev checkout")\n',
  );
  await Deno.writeTextFile(join(home, "deno.json"), "{}\n");
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  await git(
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    "one",
  );
  await git("tag", "v0.0.1");
  await git(
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "wip",
  );
  await git("remote", "add", "origin", home);
  // Uncommitted edit — the thing a forced checkout destroys.
  const wip = join(home, "src", "wip.ts");
  await Deno.writeTextFile(wip, "// not committed\n");
  await git("add", wip);
  const denoRoot = join(tmp, "deno-root");
  const p = await new Deno.Command("sh", {
    args: [join(REPO_ROOT, "install.sh")],
    cwd: tmp,
    env: {
      ...Deno.env.toObject(),
      HOME: tmp,
      AIO_HOME: home,
      DENO_INSTALL_ROOT: denoRoot,
      SHELL: "/bin/sh",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = dec.decode(p.stdout) + dec.decode(p.stderr);
  assert(out.includes("working checkout"), out);
  // Still on the branch, still at the WIP commit, the edit still there.
  const head = await new Deno.Command("git", {
    args: ["-C", home, "symbolic-ref", "--short", "HEAD"],
    stdout: "piped",
  }).output();
  assertEquals(
    dec.decode(head.stdout).trim(),
    "main",
    "not detached onto the tag",
  );
  const log = await new Deno.Command("git", {
    args: ["-C", home, "log", "--oneline", "-1"],
    stdout: "piped",
  }).output();
  assert(dec.decode(log.stdout).includes("wip"), "HEAD was moved");
  assertEquals(
    await Deno.readTextFile(wip),
    "// not committed\n",
    "uncommitted work survived",
  );
  await Deno.remove(tmp, { recursive: true });
});

// ── the one-liner cannot silently do nothing ────────────────────────────────

Deno.test("install.sh: a TRUNCATED download is a syntax error, never a partial run", async () => {
  // `curl … | sh` executes bytes as they arrive. A connection that dies
  // mid-transfer used to run the prefix that made it through and exit 0 —
  // truncated just past `git checkout --force <tag>`, that is a wiped working
  // tree reported as success. The body lives inside `main()`, called on the
  // last line, so an incomplete script is an unterminated function.
  const full = await Deno.readTextFile(join(REPO_ROOT, "install.sh"));
  assert(
    /\nmain "\$@"\s*$/.test(full),
    "install.sh must END by calling main — that call is the guard",
  );
  const cut = full.indexOf('checkout -q --force "$AIO_TAG"');
  assert(cut > 0, "the destructive line the guard exists for is still there");
  // Cut at the END of that line: a clean command boundary, the worst case.
  const truncated = full.slice(0, full.indexOf("\n", cut) + 1);
  const home = await Deno.makeTempDir({ prefix: "aio-trunc-home-" });
  const p = new Deno.Command("sh", {
    // No arguments: exactly how the pipe delivers it.
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { HOME: home, AIO_HOME: join(home, "aio") },
    clearEnv: false,
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(truncated));
  await w.close();
  const out = await p.output();
  assert(
    out.code !== 0,
    `a truncated installer exited ${out.code} — it must never report success. ` +
      dec.decode(out.stdout),
  );
  await Deno.remove(home, { recursive: true }).catch(() => {});
});

Deno.test("install.sh + run.sh: set -u, so an unset $HOME never becomes /", async () => {
  for (const f of ["install.sh", "run.sh"]) {
    const src = await Deno.readTextFile(join(REPO_ROOT, f));
    assert(
      /^set -eu$/m.test(src),
      `${f} must run under \`set -eu\` — without -u, "$HOME/.local/lib/aio" ` +
        `with HOME unset is "/.local/lib/aio" and the installer clones into ` +
        `the filesystem root`,
    );
    const p = await new Deno.Command("env", {
      args: ["-u", "HOME", "sh", join(REPO_ROOT, f)],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(p.code, 1, `${f} must refuse without $HOME`);
    assert(
      dec.decode(p.stderr).includes("HOME"),
      `${f} must NAME $HOME as the cause: ${dec.decode(p.stderr)}`,
    );
  }
});

Deno.test("run.sh: a failed or empty installer download is DETECTED", async () => {
  // `curl … | sh || fail` reads sh's status, and /bin/sh has no pipefail — a
  // 404 or a dropped connection made sh exit 0 and run.sh announce
  // "updating aio + am" having installed nothing.
  const src = await Deno.readTextFile(join(REPO_ROOT, "run.sh"));
  assert(
    !/curl[^\n]*\$AIO_RAW\/install\.sh"\s*\|\s*sh/.test(src),
    "run.sh must not pipe the installer straight into sh — the exit status " +
      "of that pipeline is sh's, and a failed download is invisible",
  );

  const home = await Deno.makeTempDir({ prefix: "aio-run-dl-" });
  const cwd = await Deno.makeTempDir({ prefix: "aio-run-cwd-" });
  const base = { HOME: home, AIO_HOME: join(home, "aio") };

  // (a) the download itself fails — a port nothing listens on.
  const bad = await new Deno.Command("sh", {
    args: [join(REPO_ROOT, "run.sh")],
    cwd,
    env: { ...base, AIO_RAW: "http://127.0.0.1:1/aio" },
    clearEnv: false,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(bad.code, 1);
  assert(
    dec.decode(bad.stderr).includes("could not download the installer"),
    dec.decode(bad.stderr) + dec.decode(bad.stdout),
  );

  // (b) the download SUCCEEDS and is empty — curl's own exit code is 0.
  const raw = await Deno.makeTempDir({ prefix: "aio-run-raw-" });
  await Deno.writeTextFile(join(raw, "install.sh"), "");
  const empty = await new Deno.Command("sh", {
    args: [join(REPO_ROOT, "run.sh")],
    cwd,
    env: { ...base, AIO_RAW: `file://${raw}` },
    clearEnv: false,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(empty.code, 1);
  assert(
    dec.decode(empty.stderr).includes("EMPTY"),
    dec.decode(empty.stderr) + dec.decode(empty.stdout),
  );

  for (const d of [home, cwd, raw]) {
    await Deno.remove(d, { recursive: true }).catch(() => {});
  }
});
