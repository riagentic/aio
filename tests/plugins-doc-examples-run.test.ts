// plugins-doc-examples-run.test.ts — the two plugins docs/basics/plugins.md
// hands people, booted exactly as written.
//
// Both used to loop forever. `onAction: (a) => auditLog.record(a.type)` records
// the action, recording IS an action (`audit:record`), which fires `onAction`,
// which records… until the drain loop's ceiling threw DISPATCH_LOOP. The
// metrics plugin (`onAction: () => stats.action()`) did the same. And both
// logged "plugin hook error … called before the cell's runtime is booted" at
// every boot: hooks see each cell's `__init`, which dispatches before any
// cell method can be called. A docs page is copied wholesale, so the blocks are
// extracted from the page itself — a fix to one copy here would prove nothing.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { cell } from "../mod.ts";
import { log } from "../src/diagnostics/logger-api.ts";
import { testServer } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import type { Plugin } from "../src/server/plugin.ts";

const DOC = new URL("../docs/basics/plugins.md", import.meta.url);
const MOD = new URL("../mod.ts", import.meta.url).href;

/** The ```ts block of the page that defines the plugin named `name`, as an
 *  importable module (its `"aio"` import pointed at this repo). */
async function docPlugin(name: string): Promise<Plugin> {
  const md = await Deno.readTextFile(DOC);
  const block = [...md.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .find((b) => b.includes("definePlugin(") && b.includes(`name: "${name}"`));
  assert(block, `docs/basics/plugins.md has no "${name}" plugin block`);
  const dir = await tempDir("aio-plugin-doc-");
  const file = join(dir, `${name}.ts`);
  await Deno.writeTextFile(
    file,
    block.replaceAll(`from "aio"`, `from "${MOD}"`),
  );
  const m = await import(toFileUrl(file).href);
  const p = (m.default ?? m[name]) as Plugin;
  assert(p?.name === name, `the "${name}" block exports no plugin`);
  return p;
}

/** Every error and warning said while `fn` runs. */
async function said(fn: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  const e = log.error.bind(log);
  const w = log.warn.bind(log);
  // deno-lint-ignore no-explicit-any
  log.error = ((a: string, b?: string) => void out.push(String(b ?? a))) as any;
  // deno-lint-ignore no-explicit-any
  log.warn = ((a: string, b?: string) => void out.push(String(b ?? a))) as any;
  try {
    await fn();
  } finally {
    log.error = e;
    log.warn = w;
  }
  return out;
}

Deno.test("plugins doc: the audit plugin records the app's actions — no loop, no boot error", async () => {
  const audit = await docPlugin("audit");
  const myCell = cell("doc-plugin-my", {
    state: { n: 0 },
    methods: {
      inc(s) {
        s.n++;
      },
    },
  });
  let entries: unknown;
  const noise = await said(async () => {
    await using server = await testServer({
      cells: [myCell],
      plugins: [audit],
    });
    await myCell.inc();
    await myCell.inc();
    await new Promise((r) => setTimeout(r, 50));
    entries = await (await server.fetch("/audit.json")).json();
  });
  assertEquals(entries, ["doc-plugin-my:inc", "doc-plugin-my:inc"]);
  assertEquals(
    noise.filter((l) => /plugin hook|DISPATCH|dispatch/.test(l)),
    [],
  );
});

Deno.test("plugins doc: the metrics plugin counts the app's actions — no loop, no boot error", async () => {
  const metrics = await docPlugin("metrics");
  const other = cell("doc-plugin-other", {
    state: { n: 0 },
    methods: {
      inc(s) {
        s.n++;
      },
    },
  });
  let body = "";
  const noise = await said(async () => {
    await using server = await testServer({
      cells: [other],
      plugins: [metrics],
    });
    await other.inc();
    await other.inc();
    await other.inc();
    await new Promise((r) => setTimeout(r, 50));
    body = await (await server.fetch("/metrics")).text();
  });
  assert(body.includes("aio_actions_total 3\n"), body);
  assertEquals(
    noise.filter((l) => /plugin hook|DISPATCH|dispatch/.test(l)),
    [],
  );
});
