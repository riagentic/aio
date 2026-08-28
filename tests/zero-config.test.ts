// Zero-config aio.run() — the whole boot config is inferable:
//   app.ts = import "./cell.ts"; await aio.run();
// appId/title from deno.json (falling back to the entry's directory name),
// version from deno.json, cells from the registry (cell() self-registers),
// baseDir from the main module. This test scaffolds that minimal app in a
// temp dir and boots it for real.
import { assert, assertEquals } from "@std/assert";
import { stopChild } from "./stop-child.ts";
// Coverage profiles from spawned deno processes go to a throwaway temp dir —
// never into the repo (an empty DENO_COVERAGE_DIR means "cwd"), never into
// the parent's coverage profile.
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

const ROOT = new URL("..", import.meta.url).pathname;

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function waitFor<T>(fn: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timeout");
}

Deno.test({
  name: "zero-config: import cell + aio.run() boots a full app",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-zero-" });
    await Deno.mkdir(`${dir}/src`);
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        title: "Zero Test",
        version: "0.9.9",
        nodeModulesDir: "auto",
        unstable: ["kv"],
        imports: {
          "aio": `${ROOT}mod.ts`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@^1",
        },
      }),
    );
    await Deno.writeTextFile(
      `${dir}/src/cell.ts`,
      `import { cell } from "aio";
export const counter = cell("counter", {
  state: { count: 0 },
  methods: { inc(s) { s.count++; } },
});`,
    );
    await Deno.writeTextFile(
      `${dir}/src/app.ts`,
      `import "./cell.ts";
import { aio } from "aio";


await aio.run(); // everything inferred`,
    );

    const port = freePort();
    const proc = new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: _childCovDir },
      args: [
        "run",
        "-A",
        "--unstable-kv",
        "src/app.ts",
        "--client=server-only",
        `--port=${port}`,
      ],
      cwd: dir,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    try {
      const boot = await waitFor(async () => {
        const res = await fetch(`http://localhost:${port}/__aio/trojan/state`);
        return res.ok ? await res.json() : null;
      }) as { counter?: { count: number } };
      // cells booted from the registry
      assertEquals(boot.counter?.count, 0);
      // identity inferred from deno.json
      const cfg = await (await fetch(
        `http://localhost:${port}/__aio/trojan/config`,
      )).json() as { title: string };
      assertEquals(cfg.title, "Zero Test");
      assert(true);
    } finally {
      await stopChild(proc, { quiet: true });
      await proc.stdout.cancel();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
