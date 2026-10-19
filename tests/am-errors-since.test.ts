// network §8: a hot-reload error stayed in `am errors` for good, and the
// command took no `--since` (as `am logs` does) to hide what came before the
// fix. `am errors --since=…` filters error.log's events by their timestamp;
// a bad value is refused, never read as "no filter".
import "./store-sandbox.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import { cmdErrors } from "../src/am/am-cmd-inspect.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { unknownFlagError } from "../src/am/am-flags.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const APP = "am-errors-since-app";
const probe = cell("am-errors-since", { state: { n: 0 }, methods: {} });

async function run(
  args: string[],
  port: number,
): Promise<{ exited: number | null; out: string }> {
  const realExit = Deno.exit;
  const realLog = console.log;
  const realErr = console.error;
  let out = "";
  console.log = console.error = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  const EXIT = Symbol("exit");
  let code: number | null = null;
  (Deno as { exit: (c?: number) => never }).exit = (c?: number) => {
    code = c ?? 0;
    throw EXIT;
  };
  try {
    await cmdErrors(args, { app: APP, port, json: true } as GlobalFlags);
  } catch (e) {
    if (e !== EXIT) throw e;
  } finally {
    Deno.exit = realExit;
    console.log = realLog;
    console.error = realErr;
  }
  return { exited: code, out };
}

Deno.test("am errors: --since is a flag of the verb", () => {
  assertEquals(unknownFlagError("errors", ["--since=5m"]), null);
});

Deno.test({
  name: "am errors --since: only error.log events at or after the cutoff",
  async fn() {
    _resetInstanceVerify();
    await using srv = await testServer({ cells: [probe], appId: APP });
    const logs = appDirs(APP).logs;
    await Deno.mkdir(logs, { recursive: true });
    const stamp = (ms: number) => new Date(ms).toISOString();
    const now = Date.now();
    const path = join(logs, "error.log");
    const before = await Deno.readTextFile(path).catch(() => null);
    try {
      await Deno.writeTextFile(
        path,
        `${stamp(now - 3_600_000)}  ERROR  air  BLANK SCREEN (boot)\n` +
          `    at old frame\n` +
          `${stamp(now - 1_000)}  ERROR  cell:x  fresh failure\n`,
      );
      const all = await run([], srv.port);
      assertEquals(JSON.parse(all.out).runtime.length, 3, all.out);

      const recent = await run(["--since=10m"], srv.port);
      assertEquals(recent.exited, null, recent.out);
      const rt: string[] = JSON.parse(recent.out).runtime;
      assertEquals(rt.length, 1, recent.out);
      assertStringIncludes(rt[0]!, "fresh failure");

      const bad = await run(["--since=yesterday-ish"], srv.port);
      assertEquals(bad.exited, 1, bad.out);
      assertStringIncludes(bad.out, "is not a time");
    } finally {
      if (before === null) await Deno.remove(path).catch(() => {});
      else await Deno.writeTextFile(path, before);
    }
  },
});
