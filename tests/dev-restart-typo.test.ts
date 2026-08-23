// A syntax error in a cell file must not end the dev session.
//
// The supervisor used to pass the child's exit code straight through: the
// relaunched child failed at module load (exit 1), the supervisor exited 1,
// and the developer — mid-edit — had no dev server and nothing saying why
// beyond the SyntaxError. Typos are the normal state of a file being edited.
// Now a child that dies right after a relaunch is a FAILED RESTART: the
// supervisor stays up, says so, and relaunches on the next save.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FAILED_RESTART_WINDOW_MS } from "../src/server/dev-restart.ts";
import { childEnv, freePort, kill } from "./e2e-app-harness.ts";

const appSource = (port: number) =>
  `import { aio } from "aio";
import { probe } from "./cell.ts";
await aio.run({
  appId: "dev-restart-typo-e2e",
  cells: [probe],
  client: "server-only",
  persist: false,
  port: ${port},
  routes: { "/mark": () => new Response(probe.mark) },
});
`;
const cellSource = (mark: string) =>
  `import { cell } from "aio";
export const probe = cell("probe", {
  state: { mark: "${mark}" },
  methods: { set(s: { mark: string }, m: string) { s.mark = m; } },
});
`;

async function servedMark(url: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/mark`);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.text()).trim() || null;
  } catch {
    return null;
  }
}
async function waitFor<T>(
  fn: () => Promise<T | null>,
  ms: number,
): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}
const alive = (pid: number) => {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

Deno.test({
  name:
    "dev-restart e2e: a typo in the cell file keeps the dev session up; fixing it relaunches",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    assert(FAILED_RESTART_WINDOW_MS >= 5_000, "window must cover a slow boot");
    const dir = await Deno.makeTempDir({ prefix: "aio-dev-restart-typo-" });
    const port = freePort();
    const url = `http://127.0.0.1:${port}`;
    const repo = new URL("../", import.meta.url).pathname;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${repo}mod.ts`,
          "aio/": `${repo}src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "app.ts"), appSource(port));
    await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v1"));

    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts")],
      cwd: dir,
      env: childEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let text = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) text += new TextDecoder().decode(c);
    };
    drain(child.stdout).catch(() => {});
    drain(child.stderr).catch(() => {});
    try {
      assertEquals(await waitFor(() => servedMark(url), 30_000), "v1", text);
      // A good edit first, so the process is in supervisor mode.
      await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v2"));
      assertEquals(
        await waitFor(
          async () => (await servedMark(url)) === "v2" ? "v2" : null,
          30_000,
        ),
        "v2",
        `first restart never served v2:\n${text}`,
      );
      // The typo.
      await Deno.writeTextFile(
        join(dir, "cell.ts"),
        cellSource("v3") + "\nthis is not valid typescript {{{\n",
      );
      const gone = await waitFor(
        async () => (await servedMark(url)) === null ? "down" : null,
        20_000,
      );
      assertEquals(gone, "down", "the broken cell must stop the old child");
      await new Promise((r) => setTimeout(r, 1500));
      assert(
        alive(child.pid),
        `the supervisor exited on a syntax error — the dev session is gone:\n${text}`,
      );
      assert(
        /stays up/.test(text),
        `the supervisor must SAY it is waiting for a fix:\n${text}`,
      );
      // Fix it: the app must come back by itself.
      await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v4"));
      assertEquals(
        await waitFor(
          async () => (await servedMark(url)) === "v4" ? "v4" : null,
          30_000,
        ),
        "v4",
        `the fixed cell never came back:\n${text}`,
      );
    } finally {
      await kill(child);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
