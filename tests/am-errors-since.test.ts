// network §8: a hot-reload error stayed in `am errors` for good, and the
// command took no `--since` (as `am logs` does) to hide what came before the
// fix. `am errors --since=…` filters error.log's events by their timestamp;
// a bad value is refused, never read as "no filter".
import "./store-sandbox.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import {
  cmdErrors,
  tagByReload,
  withReloadHeaders,
} from "../src/am/am-cmd-inspect.ts";
import {
  noteReload,
  RELOAD_LOG_MAX,
  type ReloadLog,
} from "../src/server/server-static.ts";
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

// todo §4: a hot reload's errors were not tagged by reload, so an error a
// later save fixed read the same as a live one. The dev server counts its
// reloads (`/__aio/error` .reloads); `am errors` tags each event with the
// reload it happened under, and `--since=reload` keeps only the current one.
Deno.test("reload log: a reload or patch counts, a CSS restyle does not, the times are capped", () => {
  const log: ReloadLog = { bootAt: 0, count: 0, at: [] };
  noteReload(log, "css", 1);
  assertEquals(log, { bootAt: 0, count: 0, at: [] });
  noteReload(log, "reload", 2);
  assertEquals(log, { bootAt: 0, count: 1, at: [2] });
  for (let i = 0; i < RELOAD_LOG_MAX + 5; i++) {
    noteReload(log, "reload", 10 + i);
  }
  assertEquals(log.count, RELOAD_LOG_MAX + 6);
  assertEquals(log.at.length, RELOAD_LOG_MAX);
  assertEquals(log.at.at(-1), 10 + RELOAD_LOG_MAX + 4);
});

Deno.test("am errors: each event is tagged with its reload; older ones are superseded", () => {
  const at = (ms: number) =>
    `${new Date(ms).toISOString()}  ERROR  air  e${ms}`;
  const r: ReloadLog = { bootAt: 1_000, count: 2, at: [2_000, 3_000] };
  const tagged = tagByReload(
    [[at(500)], [at(1_500), "    at frame"], [at(2_500)], ["raw write"], [
      at(3_500),
    ], [""]],
    r,
  );
  assertEquals(
    tagged.map((t) => [t.lines.length, t.reload, t.superseded]),
    [[1, null, true], [2, 0, true], [1, 1, true], [1, 1, true], [1, 2, false]],
  );
  // Pretty: a header wherever the reload changes.
  const kept = tagged.flatMap((e, i) => e.lines.map((l) => ({ l, i })));
  assertEquals(withReloadHeaders(kept, tagged, r), [
    "── before this run (an earlier start) ──",
    at(500),
    "── start — superseded: 2 reload(s) since ──",
    at(1_500),
    "    at frame",
    "── reload #1 — superseded: 1 reload(s) since ──",
    at(2_500),
    "raw write",
    "── reload #2 — current ──",
    at(3_500),
  ]);
  // No reload count (an older server): nothing is tagged, no header.
  const untagged = tagByReload([[at(1_500)]], null);
  assertEquals(untagged[0]!.reload, null);
  assertEquals(
    withReloadHeaders([{ l: "x", i: 0 }], untagged, null),
    ["x"],
  );
});

Deno.test({
  name:
    "am errors --since=reload: only what happened under the current reload, tagged in --json",
  async fn() {
    _resetInstanceVerify();
    await using srv = await testServer({ cells: [probe], appId: APP });
    const logs = appDirs(APP).logs;
    await Deno.mkdir(logs, { recursive: true });
    const path = join(logs, "error.log");
    const before = await Deno.readTextFile(path).catch(() => null);
    try {
      const fresh = new Date(Date.now() + 1_000).toISOString();
      await Deno.writeTextFile(
        path,
        `2020-01-01T00:00:00.000Z  ERROR  air  from an earlier run\n` +
          `${fresh}  ERROR  cell:x  under this run\n`,
      );
      const all = JSON.parse((await run([], srv.port)).out);
      assertEquals(all.reloads.count, 0);
      assertEquals(
        all.runtimeEvents.map((e: { reload: number | null }) => e.reload),
        [null, 0],
      );
      const cur = await run(["--since=reload"], srv.port);
      assertEquals(cur.exited, null, cur.out);
      const rt: string[] = JSON.parse(cur.out).runtime;
      assertEquals(rt.length, 1, cur.out);
      assertStringIncludes(rt[0]!, "under this run");
    } finally {
      if (before === null) await Deno.remove(path).catch(() => {});
      else await Deno.writeTextFile(path, before);
    }
  },
});
