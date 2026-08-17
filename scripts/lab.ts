// lab.ts — run aio's onboarding on a machine that is not this one.
//
// WHY THIS EXISTS
//
// Every onboarding test we shipped ran here: on a box with deno already
// installed and current, a warm module cache, git configured, and `AIO_HOME`
// pointed at the local checkout — so `install.sh`'s first-contact branch was
// never taken and `run.sh` never installed anything. They were green while the
// real one-liner failed on a fresh machine. A test that cannot fail the way
// users fail is not a test.
//
// So the lab runs the REAL one-liners inside a container that has ubuntu, curl,
// git and nothing else — no deno, or a deliberately old one — as a NON-ROOT
// user, and asserts on the thing a developer actually cares about: an app that
// builds, boots, and shows a working UI.
//
// USAGE
//
//   deno task lab                          # scaffold → dev → prod, local source
//   deno task lab --scenario=install       # just the installer
//   deno task lab --old-deno               # the "it didn't upgrade deno" report
//   deno task lab --source=github          # what a stranger gets TODAY
//   deno task lab --no-browser             # skip the UI proof (faster, weaker)
//   deno task lab ../my-app                # test MY project (a path)
//   deno task lab https://github.com/o/r   # test a project from a link
//   deno task lab --keep                   # leave the container for poking
//
// Exit code is the gate: 0 = every scenario passed.

import { basename, resolve } from "@std/path";

const HERE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** The commit the lab should install for `--source=local`. Uncommitted work is
 *  invisible to it by construction: the container clones a git repo, and a
 *  clone carries commits — which is also what a user gets, so the lab lying
 *  about that would defeat the point. */
const HEAD_SHA = (() => {
  try {
    const out = new Deno.Command("git", {
      args: ["-C", HERE, "rev-parse", "HEAD"],
      stdout: "piped",
    }).outputSync();
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return "";
  }
})();

type Args = {
  target: string;
  scenarios: string[];
  source: "local" | "github";
  oldDeno: string | null;
  browser: boolean;
  electron: boolean;
  keep: boolean;
  shell: boolean;
  runtime: string;
  branch: string;
};

function parse(argv: string[]): Args {
  const a: Args = {
    target: "",
    scenarios: [],
    source: "local",
    oldDeno: null,
    browser: true,
    electron: true,
    keep: false,
    shell: false,
    runtime: "",
    branch: "main",
  };
  for (const arg of argv) {
    if (arg === "--browser") a.browser = true;
    else if (arg === "--no-browser") a.browser = false;
    else if (arg === "--keep") a.keep = true;
    else if (arg === "--shell") a.shell = true;
    else if (arg === "--electron") a.electron = true;
    else if (arg === "--no-electron") a.electron = false;
    else if (arg === "--old-deno") a.oldDeno = "2.1.4";
    else if (arg.startsWith("--old-deno=")) a.oldDeno = arg.slice(11);
    else if (arg.startsWith("--scenario=")) {
      a.scenarios = arg.slice(11).split(",").map((s) => s.trim()).filter(
        Boolean,
      );
    } else if (arg.startsWith("--source=")) {
      a.source = arg.slice(9) === "github" ? "github" : "local";
    } else if (arg.startsWith("--runtime=")) a.runtime = arg.slice(10);
    else if (arg.startsWith("--branch=")) a.branch = arg.slice(9);
    else if (arg.startsWith("-")) {
      console.error(`lab: unknown flag ${arg}`);
      Deno.exit(2);
    } else a.target = arg;
  }
  if (a.scenarios.length === 0) {
    // The default client IS the app for most projects, so a run that never
    // starts it has not tested "does the one-line command work". It is last
    // because it is the slowest and the least likely to be the first thing
    // broken.
    a.scenarios = a.target ? ["install", "run-sh"] : [
      "install",
      "create-dev",
      "run-sh",
      ...(a.electron ? ["electron"] : []),
      // Seconds, and it is the only check the Windows one-liners have at all.
      // Leaving it out of the default run is how they drifted in the first
      // place.
      "windows-scripts",
    ];
  }
  return a;
}

const args = parse(Deno.args);

// ── the container runtime ───────────────────────────────────────────────

/** docker or podman — whichever is actually here. Podman is a drop-in for
 *  everything below, and refusing to notice it would make the lab unusable on
 *  the machines that most often have it (Fedora, RHEL, rootless setups). */
async function findRuntime(): Promise<string> {
  if (args.runtime) return args.runtime;
  let socketDenied = "";
  for (const bin of ["docker", "podman"]) {
    try {
      const out = await new Deno.Command(bin, {
        args: ["version", "--format", "{{.Server.Version}}"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (out.success) return bin;
      // The binary IS here and refused to talk to the daemon. Overwhelmingly
      // this is the group: `usermod -aG docker` does not affect a shell that
      // was already open, so "docker is installed" and "no container runtime
      // found" are both true at once — and the second one sends people to
      // reinstall something they already have.
      const err = new TextDecoder().decode(out.stderr);
      if (/permission denied|cannot connect to the docker daemon/i.test(err)) {
        socketDenied = `${bin}: ${err.trim().split("\n")[0]}`;
      }
    } catch { /* not installed — try the next */ }
  }
  // The account IS in the group, this PROCESS just isn't — because
  // supplementary GIDs are fixed when a process is created and `source`
  // cannot change them (that is kernel credentials, not environment). `sg`
  // starts a process with the group applied, so the lab can simply re-run
  // itself that way instead of making someone log out of their desktop.
  if (socketDenied && !Deno.env.get("AIO_LAB_SG")) {
    const inGroupFile = await (async () => {
      try {
        const groups = await Deno.readTextFile("/etc/group");
        const line = groups.split("\n").find((l) => l.startsWith("docker:"));
        const user = Deno.env.get("USER") ?? "";
        return !!line && !!user &&
          line.split(":")[3]?.split(",").includes(user);
      } catch {
        return false;
      }
    })();
    if (inGroupFile) {
      console.error(
        `▸ the docker socket refused this process, but your account IS in the ` +
          `docker group\n  (a shell keeps the groups it was created with) — ` +
          `re-running under \`sg docker\`\n`,
      );
      const inner = [
        Deno.execPath(),
        "run",
        "-A",
        new URL(import.meta.url).pathname,
        ...Deno.args,
      ].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      const r = await new Deno.Command("sg", {
        args: ["docker", "-c", inner],
        env: { ...Deno.env.toObject(), AIO_LAB_SG: "1" },
        stdout: "inherit",
        stderr: "inherit",
      }).output();
      Deno.exit(r.code);
    }
  }
  if (socketDenied) {
    console.error(
      `\n✗ ${socketDenied.split(":")[0]} is installed but this shell may not ` +
        `use it.\n\n  ${socketDenied}\n\n` +
        `  Group membership is granted at LOGIN, so a shell opened before\n` +
        `  \`sudo usermod -aG docker $USER\` never sees it. Fix it for THIS\n` +
        `  shell, or open a new one:\n\n` +
        `      newgrp docker            # new shell WITH the group, no logout\n` +
        `      sg docker -c 'deno task lab …'   # one-off, no new shell\n\n` +
        `  If the daemon itself is down:  sudo systemctl start docker\n`,
    );
    Deno.exit(3);
  }
  console.error(
    `\n✗ no container runtime found (looked for docker, podman).\n\n` +
      `  The lab's whole point is a machine that is NOT this one, so there is\n` +
      `  no local fallback — a "lab" that ran here would be the same blind\n` +
      `  test we already had.\n\n` +
      `  Ubuntu/Debian/Mint:  sudo apt install -y docker.io && sudo usermod -aG docker "$USER"\n` +
      `                       (then log out and back in, or: newgrp docker)\n` +
      `  Fedora/RHEL:         sudo dnf install -y podman\n`,
  );
  Deno.exit(3);
}

const RUNTIME = await findRuntime();

async function run(
  cmd: string[],
  opts: { quiet?: boolean; cwd?: string } = {},
): Promise<{ code: number; out: string }> {
  const p = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    cwd: opts.cwd,
    stdout: opts.quiet ? "piped" : "inherit",
    stderr: opts.quiet ? "piped" : "inherit",
  });
  const out = await p.output();
  return {
    code: out.code,
    out: opts.quiet
      ? new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr)
      : "",
  };
}

// ── image ───────────────────────────────────────────────────────────────

// One image for the whole run: the electron image is the browser image plus a
// virtual display, so building both would download Chrome twice.
const IMAGE = args.electron
  ? "aio-lab:electron"
  : args.browser
  ? "aio-lab:browser"
  : args.oldDeno
  ? `aio-lab:deno-${args.oldDeno}`
  : "aio-lab:fresh";

async function buildImage(): Promise<void> {
  console.log(`\n▸ building ${IMAGE} (${RUNTIME})`);
  const build = [
    RUNTIME,
    "build",
    "-f",
    `${HERE}/docker/Dockerfile.onboard`,
    "-t",
    IMAGE,
  ];
  if (args.browser || args.electron) {
    build.push("--build-arg", "WITH_BROWSER=1");
  }
  if (args.electron) build.push("--build-arg", "WITH_ELECTRON=1");
  if (args.oldDeno) {
    build.push("--build-arg", `PREINSTALL_DENO=${args.oldDeno}`);
  }
  build.push(`${HERE}/docker`);
  const r = await run(build);
  if (r.code !== 0) {
    console.error(`✗ image build failed (exit ${r.code})`);
    Deno.exit(r.code);
  }
}

// ── scenarios ───────────────────────────────────────────────────────────

const SCENARIO_FILE: Record<string, string> = {
  "install": "01-install.sh",
  "create-dev": "02-create-dev.sh",
  "run-sh": "03-run-sh.sh",
  "electron": "04-electron.sh",
  // Not a container scenario: it runs in Microsoft's PowerShell image, because
  // that is as close to Windows as a Linux host gets.
  "windows-scripts": "",
};

/** What the target is, decided ONCE — the scenarios read this, so "a path" and
 *  "a link" cannot drift into two different code paths. */
function targetKind(): { kind: string; mount: string | null; git: string } {
  if (!args.target) return { kind: "scaffold", mount: null, git: "" };
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(args.target)) {
    return { kind: "git", mount: null, git: args.target };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(args.target)) {
    return {
      kind: "git",
      mount: null,
      git: `https://github.com/${args.target}`,
    };
  }
  const path = resolve(args.target);
  try {
    if (!Deno.statSync(path).isDirectory) throw new Error("not a directory");
  } catch {
    console.error(
      `lab: "${args.target}" is neither a directory nor a repo URL/owner-repo`,
    );
    Deno.exit(2);
  }
  return { kind: "path", mount: path, git: "" };
}

const TARGET = targetKind();

/** The Windows one-liners, under a real PowerShell.
 *
 *  Docker cannot boot Windows, so this proves what is provable without it: the
 *  scripts PARSE, and the decisions inside them (version comparison, app-name
 *  derivation, which `am` spelling is safe against an older tag) are correct.
 *  It is listed as its own scenario, with its own limits printed, rather than
 *  folded into a pass that would read as "Windows works". */
async function runWindowsScripts(): Promise<boolean> {
  console.log(
    `\n${
      "─".repeat(72)
    }\n▸ scenario: windows-scripts (PowerShell, not Windows)\n${
      "─".repeat(72)
    }`,
  );
  const r = await run([
    RUNTIME,
    "run",
    "--rm",
    "-v",
    `${HERE}:/aio-src:ro`,
    "mcr.microsoft.com/powershell:latest",
    "pwsh",
    "-NoProfile",
    "-File",
    "/aio-src/docker/windows-scripts.ps1",
  ]);
  return r.code === 0;
}

async function runScenario(name: string): Promise<boolean> {
  if (name === "windows-scripts") return await runWindowsScripts();
  const file = SCENARIO_FILE[name];
  if (!file) {
    console.error(
      `lab: unknown scenario "${name}" (have: ${
        Object.keys(SCENARIO_FILE).join(", ")
      })`,
    );
    Deno.exit(2);
  }
  const label = `${name}${args.oldDeno ? ` [deno ${args.oldDeno}]` : ""}${
    args.source === "github" ? " [github]" : ""
  }`;
  console.log(
    `\n${"─".repeat(72)}\n▸ scenario: ${label}\n${"─".repeat(72)}`,
  );

  const cmd = [
    RUNTIME,
    "run",
    "--rm",
    "--name",
    `aio-lab-${name}-${Date.now()}`,
    // The app binds 127.0.0.1 inside the container; nothing needs publishing,
    // and NOT publishing keeps the lab from colliding with the host's ports.
    "-v",
    `${HERE}:/aio-src:ro`,
    // ONE mount for the whole lab directory: mounting a FILE inside an
    // already read-only mount cannot create its mountpoint, which is how the
    // first run of this failed.
    "-v",
    `${HERE}/docker:/lab:ro`,
    "-e",
    `AIO_SOURCE=${args.source}`,
    // Which commit of the framework the container installs. `--source=local`
    // means "test what I have RIGHT NOW", so it pins the working commit —
    // without this the installer checks out the last TAG and the lab could
    // only ever verify code that already shipped, which is the wrong end of
    // the loop. `--source=github` deliberately leaves it unset: a stranger
    // gets the last tag, and that is the thing being tested.
    "-e",
    `AIO_REF=${args.source === "local" ? HEAD_SHA : ""}`,
    "-e",
    `AIO_RAW=https://raw.githubusercontent.com/riagentic/aio/${args.branch}`,
    "-e",
    `LAB_TARGET_KIND=${TARGET.kind}`,
    "-e",
    `LAB_TARGET_GIT=${TARGET.git}`,
    "-e",
    `BROWSER_BIN=${args.browser ? "/usr/bin/google-chrome" : ""}`,
  ];
  if (TARGET.mount) cmd.push("-v", `${TARGET.mount}:/target:ro`);
  if (args.keep) {
    cmd.splice(cmd.indexOf("--rm"), 1);
  }
  cmd.push(IMAGE, "bash", "-lc", `sh /lab/scenarios/${file}`);

  const r = await run(cmd);
  return r.code === 0;
}

// ── main ────────────────────────────────────────────────────────────────

if (args.shell) {
  await buildImage();
  console.log(`\n▸ interactive shell in ${IMAGE} (the framework is /aio-src)`);
  const cmd = [
    RUNTIME,
    "run",
    "--rm",
    "-it",
    "-v",
    `${HERE}:/aio-src:ro`,
    "-v",
    `${HERE}/docker:/lab:ro`,
    IMAGE,
    "bash",
    "-l",
  ];
  const r = await run(cmd);
  Deno.exit(r.code);
}

console.log(
  `\naio onboarding lab\n` +
    `  runtime   ${RUNTIME}\n` +
    `  image     ${IMAGE}\n` +
    `  source    ${args.source}${
      args.source === "github" ? ` (branch ${args.branch})` : " (this checkout)"
    }\n` +
    `  target    ${
      TARGET.kind === "scaffold"
        ? "a freshly scaffolded app"
        : TARGET.kind === "git"
        ? TARGET.git
        : `${basename(TARGET.mount!)} (${TARGET.mount})`
    }\n` +
    `  scenarios ${args.scenarios.join(" → ")}\n` +
    `  electron  ${
      args.electron
        ? "yes — the DEFAULT client, on a virtual display (--no-electron to skip)"
        : "NO (--no-electron)"
    }
  browser   ${args.browser ? "yes (real Chrome)" : "no (--browser adds it)"}`,
);

await buildImage();

const started = Date.now();
const results: [string, boolean][] = [];
for (const s of args.scenarios) {
  results.push([s, await runScenario(s)]);
}

const failed = results.filter(([, ok]) => !ok);
const secs = Math.round((Date.now() - started) / 1000);
console.log(`\n${"═".repeat(72)}`);
for (const [name, ok] of results) {
  console.log(`  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`);
}
if (failed.length === 0) {
  console.log(
    `\n\x1b[32m✓ onboarding works on a fresh machine\x1b[0m — ` +
      `${results.length} scenario(s) in ${secs}s\n`,
  );
  Deno.exit(0);
}
console.log(
  `\n\x1b[31m✗ onboarding is BROKEN\x1b[0m — ${failed.length}/${results.length} ` +
    `scenario(s) failed: ${failed.map(([n]) => n).join(", ")} (${secs}s)\n` +
    `  Reproduce interactively:  deno task lab --shell\n`,
);
Deno.exit(1);
