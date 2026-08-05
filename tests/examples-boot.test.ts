// The gate: EVERY shipped example app must actually boot.
//
// alpha45 shipped `examples/contacts` — the worked example a field report
// rated the top request — with a config that threw at boot
// (`db: table "contacts" collides with cell "contacts"`). CI missed it because
// the runtime smoke tests hand-picked three examples, and the contacts test was
// `testCell`-only, which never touches `db:`. A shipped example that cannot
// start is a release-blocking failure, so the list is DISCOVERED here, not
// typed: adding an example automatically adds its boot gate.
//
// "Boots" means: the process starts, stays up, and answers HTTP on its port.
// Anything less (a boot throw, an exit, a hang) fails with the app's own
// stderr, which is the message that would have caught the alpha45 blocker.
import { assert } from "@std/assert";

const ROOT = new URL("..", import.meta.url).pathname;

// Coverage profiles from spawned deno processes go to a throwaway temp dir —
// never into the repo, never into the parent's profile.
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** Every example app in the repo: a directory holding `app.ts` or `src/app.ts`
 *  under examples/ (one level, plus examples/targets/*). */
export function discoverExampleApps(
  root = ROOT,
): { dir: string; entry: string }[] {
  const out: { dir: string; entry: string }[] = [];
  const scan = (base: string) => {
    for (const e of [...Deno.readDirSync(`${root}${base}`)]) {
      if (!e.isDirectory || e.name.startsWith(".")) continue;
      const dir = `${base}/${e.name}`;
      for (const entry of ["app.ts", "src/app.ts"]) {
        try {
          if (Deno.statSync(`${root}${dir}/${entry}`).isFile) {
            out.push({ dir, entry });
            break;
          }
        } catch { /* not this shape */ }
      }
      if (base === "examples" && e.name === "targets") scan(dir);
    }
  };
  scan("examples");
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

async function bootsAndServes(dir: string, entry: string): Promise<void> {
  const port = freePort();
  // Every app writes into a throwaway apps root — never the developer's ~/.
  const appsDir = await Deno.makeTempDir({ prefix: "aio-example-boot-" });
  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-kv",
      entry,
      "--client=server-only",
      `--port=${port}`,
    ],
    cwd: `${ROOT}${dir}`,
    env: { DENO_COVERAGE_DIR: _childCovDir, AIO_APPS_DIR: appsDir },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const dec = new TextDecoder();
  let err = "";
  let out = "";
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    onChunk: (s: string) => void,
  ) => {
    for await (const chunk of stream) onChunk(dec.decode(chunk));
  };
  const draining = Promise.all([
    drain(proc.stderr, (s) => err += s),
    drain(proc.stdout, (s) => out += s),
  ]);

  let exited: { code: number } | null = null;
  const status = proc.status.then((s) => {
    exited = s;
    return s;
  });

  try {
    const deadline = Date.now() + 60_000;
    let served = false;
    while (Date.now() < deadline) {
      if (exited) break;
      try {
        const res = await fetch(`http://localhost:${port}/`);
        await res.body?.cancel();
        served = true;
        break;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(
      !exited,
      `${dir}/${entry} exited (code ${
        exited === null ? "?" : (exited as { code: number }).code
      }) instead of booting:\n${err || out}`,
    );
    assert(served, `${dir}/${entry} never answered on :${port}\n${err || out}`);
  } finally {
    try {
      proc.kill();
    } catch { /* already gone */ }
    await status;
    await draining.catch(() => {});
    await Deno.remove(appsDir, { recursive: true }).catch(() => {});
  }
}

const APPS = discoverExampleApps();

Deno.test("examples: the boot gate covers every example app", () => {
  // A guard on the guard: the discovery must actually find the apps (a broken
  // scan would make this file pass by testing nothing).
  assert(APPS.length >= 10, `expected every example, found ${APPS.length}`);
  for (
    const must of ["examples/contacts", "examples/counter", "examples/todo"]
  ) {
    assert(
      APPS.some((a) => a.dir === must),
      `${must} must be in the boot gate`,
    );
  }
});

for (const { dir, entry } of APPS) {
  Deno.test({
    name: `example ${dir}: boots and serves`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: () => bootsAndServes(dir, entry),
  });
}
