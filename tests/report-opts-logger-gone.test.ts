// `buildReportOpts` decided at boot whether a logger existed and then called
// `getLogger()!.pub` on every report. In ONE process (library mode, testApps)
// an app booted with `logging: false` borrows the other app's logger as its
// fallback — and once that app closes there is no logger at all, so the `!`
// threw inside `reportError`. Its catch printed "reportError failed" and
// skipped everything after the logger write: the app's `onError` hook, its
// time-travel error mark, its error count. An error that reaches no hook is
// the silent failure this project forbids.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { buildReportOpts } from "../src/server/aio-run-helpers.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

type App = Awaited<ReturnType<typeof aio.run>>;

const makeCell = () =>
  cell("c", {
    state: { n: 0 },
    methods: {
      boom(_s: { n: number }, m: string) {
        throw new Error(`BOOM-${m}`);
      },
    },
  });

async function boot(
  id: string,
  dir: string,
  // deno-lint-ignore no-explicit-any
  extra: Record<string, any>,
  c: ReturnType<typeof makeCell>,
): Promise<App> {
  return await aio.run({
    cells: [c],
    appId: `${id}-${crypto.randomUUID().slice(0, 8)}`,
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port: freePort(),
    ...extra,
    // deno-lint-ignore no-explicit-any
  } as any);
}

Deno.test("two apps: a logging:false app still reports to its onError after the logging app closes", async () => {
  const da = await Deno.makeTempDir({ prefix: "aio-rep-a-" });
  const db = await Deno.makeTempDir({ prefix: "aio-rep-b-" });
  const hooked: string[] = [];
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error };
  const a = makeCell();
  const b = makeCell();
  let A: App | null = null;
  let B: App | null = null;
  try {
    A = await boot("repa", da, {}, a);
    B = await boot("repb", db, {
      logging: false,
      onError: (e: { message: string }) => hooked.push(e.message),
    }, b);
    await A.close();
    A = null;
    const capture = (...x: unknown[]) => lines.push(x.map(String).join(" "));
    console.log = capture;
    console.error = capture;
    try {
      await b.boom("after-a").catch(() => {});
    } finally {
      Object.assign(console, orig);
    }
    assert(
      !lines.some((l) => l.includes("reportError failed")),
      `reportError must not fail once the other app's logger is gone:\n${
        lines.join("\n")
      }`,
    );
    // With no logger left, the error still reaches the console.
    assert(
      lines.some((l) => l.includes("BOOM-after-a")),
      `the error must still be printed:\n${lines.join("\n")}`,
    );
    assertEquals(
      hooked.filter((m) => m.includes("BOOM-after-a")).length,
      1,
      `B's onError must see its error; got: ${JSON.stringify(hooked)}`,
    );
  } finally {
    Object.assign(console, orig);
    if (B) await B.close();
    if (A) await A.close();
    await Deno.remove(da, { recursive: true }).catch(() => {});
    await Deno.remove(db, { recursive: true }).catch(() => {});
  }
});

Deno.test("buildReportOpts: a logger present at boot and gone later — the shim does not throw", () => {
  assertEquals(getLogger(), null, "precondition: no app is running");
  const written: string[] = [];
  setLogger({
    pub: (_lvl: string, _cat: string, msg: string) => written.push(msg),
  } as unknown as LogSink);
  let opts;
  try {
    opts = buildReportOpts({
      onError: undefined,
      getTT: () => null,
      prod: false,
    });
    assert(opts.logger, "a logger was active at build time → the shim exists");
    opts.logger.error("while-up", {});
  } finally {
    setLogger(null);
  }
  assertEquals(written, ["while-up"]);
  // The logger is gone; the shim built while it existed must not throw.
  opts.logger!.error("after-gone", {});
  assertEquals(written, ["while-up"]);
});
