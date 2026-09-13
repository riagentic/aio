// `composeCellsWiring` — the composition a real `aio.run()` performs.
//
// 1. `worker: true` + `scope: "client"` is a combination `validateWorkerCells`
//    refuses by name, and every harness refused it (boot-refusals.ts). The
//    real boot dropped client-scoped cells FIRST and handed the worker pool
//    only what was left, so the same app booted without a word.
// 2. The dotted-`include` warning looks dead — `cell()` throws on a dotted
//    include — but an app-level `cellDefaults` include is copied onto each
//    cell without that check, and the warning is the only thing that names it.
import { assertRejects, assertStringIncludes } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";

// deno-lint-ignore no-explicit-any
async function boot(extra: Record<string, any>) {
  const dir = await Deno.makeTempDir({ prefix: "aio-wiring-" });
  try {
    const app = await aio.run({
      appId: `wiring-${crypto.randomUUID().slice(0, 8)}`,
      appDir: dir,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      persist: false,
      port: freePort(),
      ...extra,
      // deno-lint-ignore no-explicit-any
    } as any);
    await app.close();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("aio.run: a worker: true cell that is client-scoped is refused, as the harnesses refuse it", async () => {
  const clientWorker = cell("clientworker", {
    worker: true,
    scope: "client",
    state: { n: 0 },
    methods: {
      go(s: { n: number }) {
        s.n++;
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const server = cell("plainsrv", {
    state: { n: 0 },
    methods: {
      go(s: { n: number }) {
        s.n++;
      },
    },
  });
  await assertRejects(
    () => boot({ cells: [clientWorker, server] }),
    Error,
    'cell "clientworker" has worker: true but is client-scoped',
  );
});

Deno.test("composeCellsWiring: a dotted include from cellDefaults is named (the warning is reachable)", () => {
  const c = cell("dotdefaults", {
    state: { a: { b: 1 } },
    methods: {},
  });
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    composeCellsWiring({
      cellEntries: [c],
      cellDefaults: { persist: { include: ["a.b"] } },
    });
  } finally {
    Object.assign(console, orig);
  }
  assertStringIncludes(
    lines.join("\n"),
    'persist include key "a.b" — include filters are top-level only',
  );
});
