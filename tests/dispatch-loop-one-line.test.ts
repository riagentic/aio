// One dispatch loop, one line for the calls it stranded.
//
// A DISPATCH_LOOP rejects every queued call (up to 10 000), and each rejected
// async method logged "<cell> <m>() threw: … dispatch overflow" — 10 001 lines
// for one loop, burying the DISPATCH_LOOP error that names the cause and
// filling the log budget. Every caller is still rejected; only the logging is
// collapsed, into one line with the count.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { observeAction } from "../src/diagnostics/logger-observe.ts";

let rejected = 0;
const spinner = cell("loop-one-line", {
  state: { n: 0 },
  methods: {
    async spin(s) {
      s.n++;
      try {
        await spinner.spin();
      } catch (e) {
        rejected++; // this caller got its own rejection
        throw e;
      }
    },
  },
});

Deno.test({
  name:
    "dispatch loop: the stranded calls' rejections are ONE line with a count",
  async fn() {
    const lines: string[] = [];
    const prev = getLogger();
    setLogger({
      logDir: "",
      pub: (lvl: string, cat: string, msg?: string) => {
        if (lvl === "error" || lvl === "warn") lines.push(`${cat} ${msg}`);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
    } as unknown as LogSink);
    try {
      await using _h = await bootCells([spinner]);
      const outer = await spinner.spin().then(() => null, (e: Error) => e);
      assertMatch(String(outer), /dispatch overflow/);
      await new Promise((r) => setTimeout(r, 200)); // the count is flushed
    } finally {
      setLogger(prev);
    }
    const perCall = lines.filter((l) => l.includes("() threw"));
    assertEquals(perCall.length, 0, `per-call lines: ${perCall.length}`);
    const summary = lines.filter((l) => /pending calls? rejected/.test(l));
    assertEquals(summary.length, 1, lines.slice(0, 5).join("\n"));
    assert(rejected > 1000, `only ${rejected} callers were rejected`);
    // the count is exactly the calls that were rejected
    assertMatch(summary[0]!, new RegExp(`\\b${rejected} pending calls`));
    assertMatch(summary[0]!, /DISPATCH_LOOP/);
  },
});

// debug.log/error.log: the same stranded calls' `__error` frames do not each
// emit "<m> failed" — the count line above already said it.
Deno.test("dispatch loop: an overflow-rejected __error emits no per-call log line", () => {
  const emitted: string[] = [];
  const ctx = {
    suppressTypes: [],
    stats: { dispatched: 0, errors: 0 },
    lastStatus: new Map<string, string>(),
    emit: (_l: string, _c: string, msg: string) => void emitted.push(msg),
  };
  const err = (extra: Record<string, unknown>) => ({
    type: "c:__error",
    payload: { _method: "spin", error: "AioError: overflow", ...extra },
  });
  observeAction(ctx, err({ _overflow: true }), {});
  assertEquals(emitted, []);
  observeAction(ctx, err({}), {});
  assertEquals(emitted, ["spin failed"]);
});
