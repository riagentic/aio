// A dev session waiting on a typo is still the app — `am stop` must end it.
//
// After a relaunch failed on a broken save, the supervisor waited for the next
// save with NO lock filed: `am status` said "stopped", `am stop` said "not
// running" (exit 1) and could not reach it, and the next save brought the app
// back up after the operator had stopped it.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { childEnv, freePort, kill } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const appSource = (port: number) =>
  `import { aio } from "aio";
import { probe } from "./cell.ts";
await aio.run({
  appId: "dev-restart-typo-stop-e2e",
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
    "dev-restart e2e: am stop ends a dev session that waits on a typo, and a later save does not revive it",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("aio-dev-typo-stop-");
    const appsDir = join(dir, ".apps");
    const env = childEnv({ AIO_APPS_DIR: appsDir });
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
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let text = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) text += new TextDecoder().decode(c);
    };
    const drained = Promise.allSettled([
      drain(child.stdout),
      drain(child.stderr),
    ]);
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
      await Deno.writeTextFile(
        join(dir, "cell.ts"),
        cellSource("v3") + "\nthis is not valid typescript {{{\n",
      );
      assertEquals(
        await waitFor(
          () => Promise.resolve(/stays up/.test(text) ? "said" : null),
          30_000,
        ),
        "said",
        `the supervisor never reached the wait:\n${text}`,
      );
      assert(alive(child.pid), `supervisor gone:\n${text}`);

      const am = async (...args: string[]) => {
        const o = await new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", `${repo}src/am.ts`, ...args, "--json"],
          cwd: dir,
          env,
          stdout: "piped",
          stderr: "piped",
        }).output();
        return {
          code: o.code,
          out: new TextDecoder().decode(o.stdout),
          err: new TextDecoder().decode(o.stderr),
        };
      };
      // `am status` names the wait (transitional, exit 2) instead of
      // "stopped", and `am start` says what broke instead of timing out on
      // "still starting" — and never reclaims the session as stuck.
      const st = await am("status", "--app=dev-restart-typo-stop-e2e");
      assertEquals(st.code, 2, st.out + st.err);
      const doc = JSON.parse(st.out);
      assertEquals(doc.status, "starting");
      assertEquals(doc.pid, child.pid);
      assert(/does not load/.test(doc.waiting?.reason), st.out);
      const again = await am("start", "--app=dev-restart-typo-stop-e2e");
      assertEquals(again.code, 1, again.out + again.err);
      assert(
        /waiting for a fix/.test(again.out + again.err),
        `am start did not name the wait:\n${again.out}${again.err}`,
      );
      assert(alive(child.pid), "am start killed the waiting dev session");

      const stop = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          `${repo}src/am.ts`,
          "stop",
          "--app=dev-restart-typo-stop-e2e",
          "--json",
        ],
        cwd: dir,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const said = new TextDecoder().decode(stop.stdout) +
        new TextDecoder().decode(stop.stderr);
      assertEquals(
        stop.code,
        0,
        `am stop could not reach the waiting dev session:\n${said}`,
      );
      assertEquals(
        await waitFor(
          () => Promise.resolve(alive(child.pid) ? null : "gone"),
          15_000,
        ),
        "gone",
        `am stop returned but the supervisor lives on:\n${said}\n${text}`,
      );
      // The save that used to revive it.
      await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v4"));
      await new Promise((r) => setTimeout(r, 2_000));
      assertEquals(await servedMark(url), null, "a stopped app came back");
    } finally {
      await kill(child);
      await drained;
      await dropTempDir(dir);
    }
  },
});
