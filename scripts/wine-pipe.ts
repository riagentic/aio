// The Windows named-pipe transport, proven under Wine — `deno task test:wine`.
//
// There is no Windows machine in this project's CI. Wine is a real Win32
// implementation, so the question "does src/server/win-pipe.ts work on the
// kernel32 it targets" can be answered here for CreateNamedPipeW /
// ConnectNamedPipe / overlapped ReadFile+WriteFile — with two REAL Windows
// runtimes as the peers:
//
//   host    the Windows deno.exe at the host's own `deno --version` (the FFI
//           surface that ships), running tests/fixtures/wine-pipe/host.ts
//   client  a Windows Node LTS — libuv's named-pipe client, the exact code
//           path Electron main uses (`net.connect`, `http.request({socketPath})`)
//   client  deno.exe again with `connectLocal` — the `am` path
//
// What this does NOT claim: a pass on real Windows (ACL defaults, antivirus
// filter drivers, and Wine's pipe emulation are not the NT kernel's). The
// docs say "proven under Wine in CI; one pass on real Windows still pending".
//
// Downloads are cached under ~/.cache/aio/tools/win and staged into
// docker/tools/win (gitignored) for the image build; nothing is fetched at
// build time. Flags: --no-build (reuse the image), --shell (drop into the
// container instead of running).

import { join } from "jsr:@std/path@^1";

const HERE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const IMAGE = "aio-lab:windows-pipe";
/** Current Node 22 LTS. Bump deliberately: the client half is "what Electron's
 *  libuv does", and Electron tracks Node LTS. */
const NODE_WIN = "v22.23.2";
const DENO_WIN = Deno.version.deno;
const CACHE = join(
  Deno.env.get("HOME") ?? "~",
  ".cache",
  "aio",
  "tools",
  "win",
);
const STAGE = join(HERE, "docker", "tools", "win");

const flags = new Set(Deno.args);

async function run(
  cmd: string[],
  opts: { cwd?: string } = {},
): Promise<number> {
  const p = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    cwd: opts.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await p.output()).code;
}

async function runtime(): Promise<string> {
  for (const r of ["docker", "podman"]) {
    try {
      const o = await new Deno.Command(r, {
        args: ["version"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (o.code === 0) return r;
    } catch { /* not installed */ }
  }
  console.error("✗ neither docker nor podman is available");
  Deno.exit(2);
}

async function ensureCached(name: string, url: string): Promise<string> {
  const path = join(CACHE, name);
  await Deno.mkdir(CACHE, { recursive: true });
  try {
    const st = await Deno.stat(path);
    if (st.size > 1_000_000) return path;
  } catch { /* fetch */ }
  console.log(`▸ fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    console.error(`✗ ${url} → ${res.status}`);
    Deno.exit(2);
  }
  const tmp = path + ".part";
  const f = await Deno.open(tmp, { write: true, create: true, truncate: true });
  await res.body.pipeTo(f.writable);
  await Deno.rename(tmp, path);
  return path;
}

async function stage(src: string): Promise<void> {
  await Deno.mkdir(STAGE, { recursive: true });
  const dst = join(STAGE, src.split("/").pop()!);
  try {
    const [a, b] = await Promise.all([Deno.stat(src), Deno.stat(dst)]);
    if (a.size === b.size) return;
  } catch { /* copy */ }
  await Deno.copyFile(src, dst);
}

const RT = await runtime();

if (!flags.has("--no-build")) {
  const denoZip = await ensureCached(
    `deno-${DENO_WIN}-x86_64-pc-windows-msvc.zip`,
    `https://github.com/denoland/deno/releases/download/v${DENO_WIN}/deno-x86_64-pc-windows-msvc.zip`,
  );
  const nodeZip = await ensureCached(
    `node-${NODE_WIN}-win-x64.zip`,
    `https://nodejs.org/dist/${NODE_WIN}/node-${NODE_WIN}-win-x64.zip`,
  );
  // Only the two zips this build uses are staged — an older deno zip left in
  // the cache must not become a second `deno-*.zip` glob match in the image.
  await Deno.remove(STAGE, { recursive: true }).catch(() => {});
  await stage(denoZip);
  await stage(nodeZip);
  console.log(
    `▸ building ${IMAGE} (deno ${DENO_WIN} + node ${NODE_WIN} for windows, under wine)`,
  );
  const code = await run([
    RT,
    "build",
    "-f",
    `${HERE}/docker/Dockerfile.windows-app`,
    "--build-arg",
    "WITH_WIN_TOOLS=1",
    "-t",
    IMAGE,
    `${HERE}/docker`,
  ]);
  if (code !== 0) {
    console.error(`✗ image build failed (exit ${code})`);
    Deno.exit(code);
  }
}

// A world-readable COPY of src/ + the fixtures, not the checkout itself: the
// container runs as its own user (uid 1001), and a 0700 checkout (umask 077)
// mounts as "permission denied" — measured. The fixtures import the real
// modules by relative path (../../../src/server/local-listen.ts), so the copy
// keeps the tree shape and the code under test is this checkout, byte for byte.
// /tmp explicitly: $TMPDIR may point into a 0700 tree (sandbox scratchpads
// do), and the container's uid must be able to TRAVERSE every parent.
const work = await Deno.makeTempDir({ dir: "/tmp", prefix: "aio-wine-pipe-" });
let code = 1;
try {
  await Deno.mkdir(join(work, "tests", "fixtures"), { recursive: true });
  for (
    const [from, to] of [
      [join(HERE, "src"), join(work, "src")],
      [
        join(HERE, "tests", "fixtures", "wine-pipe"),
        join(work, "tests", "fixtures", "wine-pipe"),
      ],
    ] as [string, string][]
  ) {
    if ((await run(["cp", "-r", from, to])) !== 0) {
      throw new Error(`cp ${from}`);
    }
  }
  if ((await run(["chmod", "-R", "u+rwX,go+rX", work])) !== 0) {
    throw new Error("chmod");
  }
  const docker = [
    RT,
    "run",
    "--rm",
    "--name",
    `aio-wine-pipe-${Date.now()}`,
    "-v",
    `${work}:/aio-src:ro`,
    "-e",
    "FIXTURES=/aio-src/tests/fixtures/wine-pipe",
    "-e",
    "WIN_DIR=/home/aio/win",
  ];
  code = flags.has("--shell")
    ? await run([...docker, "-it", IMAGE, "bash"])
    : await run([
      ...docker,
      IMAGE,
      "bash",
      "-lc",
      "deno run -A /aio-src/tests/fixtures/wine-pipe/runner.ts",
    ]);
} finally {
  await Deno.remove(work, { recursive: true }).catch(() => {});
}
Deno.exit(code);
