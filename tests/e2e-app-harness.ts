/**
 * @module
 * Shared harness for the REAL-app E2E suites (onboarding-e2e, build-e2e):
 * scaffold a throwaway app against this repo, run its tasks, boot artifacts and
 * prove they serve. Not a test file (no `.test.ts`) — nothing here runs on its
 * own; it exists so the suites assert against ONE definition of "the app really
 * works" instead of drifting copies.
 */
import { assert } from "@std/assert";
import { resolve } from "@std/path";
import { scaffold } from "../src/am/am-cmd-create.ts";

export const REPO_ROOT = resolve(import.meta.dirname!, "..");
const dec = new TextDecoder();

/** Scaffold a template app into a fresh temp dir with dep/aio → the repo. Each
 *  app gets a UNIQUE name so its appId (deno.json name → single-instance lock,
 *  compiled-binary identity) never collides with a sibling test's server. */
export async function makeApp(
  tpl: "counter" | "todo" = "counter",
  prefix = "onboard-",
  target?: Parameters<typeof scaffold>[3],
): Promise<string> {
  const name = `app-${crypto.randomUUID().slice(0, 8)}`;
  const dir = await Deno.makeTempDir({ prefix });
  for (
    const [rel, content] of Object.entries(scaffold(name, tpl, true, target))
  ) {
    const path = resolve(dir, rel);
    await Deno.mkdir(resolve(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  await Deno.mkdir(resolve(dir, "dep"), { recursive: true });
  await Deno.symlink(REPO_ROOT, resolve(dir, "dep/aio"));
  return dir;
}

/** Run the single-target build pipeline (`dep/aio/src/build.ts`) with raw
 *  flags — artifacts land in the project ROOT, exactly what `deno task build`
 *  runs per target under the hood. The scaffold no longer carries a task per
 *  target (alpha52 one-vocabulary diet: `build`/`compile` are the tasks), so
 *  target-specific artifact tests invoke the pipeline directly. */
export async function buildFlags(
  dir: string,
  ...flags: string[]
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command("deno", {
    args: ["run", "-A", "dep/aio/src/build.ts", ...flags],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: p.code, out: dec.decode(p.stdout), err: dec.decode(p.stderr) };
}

/** Run `deno task <name> [args…]` in dir, capture output. */
export async function task(
  dir: string,
  name: string,
  ...extra: string[]
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command("deno", {
    args: ["task", name, ...extra],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: p.code, out: dec.decode(p.stdout), err: dec.decode(p.stderr) };
}

/** An OS-assigned free TCP port. */
export function freePort(): number {
  const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** Spawn a long-running process; drain stderr in the background so it can't
 *  block, and expose the accumulated log for failure messages. */
export function spawn(
  cmd: string,
  args: string[],
  cwd: string,
): { proc: Deno.ChildProcess; log: () => string } {
  const proc = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let log = "";
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) log += dec.decode(c);
  };
  drain(proc.stderr).catch(() => {});
  drain(proc.stdout).catch(() => {});
  return { proc, log: () => log };
}

/** Poll a URL until it answers 200 (returns the body) or the deadline passes.
 *  `client` carries the CA for a server exposing HTTPS with its own self-signed
 *  cert (`--expose`) — the only way to probe it without disabling TLS checks.
 *  `headers` carries credentials: an exposed app is KEYED by default
 *  (alpha52), and health sits behind the key like every route
 *  (docs/state/lifecycle.md) — probes send `Authorization: Bearer <key>`. */
export async function waitForHttp(
  url: string,
  timeoutMs: number,
  client?: Deno.HttpClient,
  headers?: Record<string, string>,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      // `client` is a Deno-only RequestInit field (absent from the DOM type).
      const res = await fetch(
        url,
        {
          ...(headers ? { headers } : {}),
          ...(client ? { client } : {}),
        } as unknown as RequestInit,
      );
      const body = await res.text();
      if (res.ok) return body;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = String(e);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `server never served ${url} within ${timeoutMs}ms (${lastErr})`,
  );
}

export async function killAnd(
  proc: Deno.ChildProcess,
  dir: string,
): Promise<void> {
  await kill(proc);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

/** Kill a spawned process and reap it (never throws). */
export async function kill(proc: Deno.ChildProcess): Promise<void> {
  try {
    proc.kill("SIGKILL");
    await proc.status;
  } catch { /* already gone */ }
}

/** Assert an HTTP body is real served markup from an aio app. */
export function assertServesApp(body: string): void {
  const lc = body.toLowerCase();
  assert(body.length > 20, "empty response body");
  assert(
    lc.includes("<!doctype") || lc.includes("<html") || lc.includes("<script"),
    `response is not HTML markup:\n${body.slice(0, 200)}`,
  );
}
