// A fuzz (`t.randomActions` / `t.fuzz`) calls every method with NO payload, by
// design. The short-call check (cell-methods-internals.ts `_warnShortCall`)
// used to warn for each method it hit — "give the parameter a default in the
// SIGNATURE" — advice that, followed, hides real misuse from the control plane
// (feedback cc §3: a dozen such lines per `randomActions(120)`). Now a fuzz
// call is marked, counted, and summarised in ONE line per run; a real short
// call, zero-argument or not, still warns.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { _resetShortCallWarnings } from "../src/state/cell-methods-internals.ts";

type S = { rows: unknown[] };
const c = cell("fuzzquiet", {
  state: { rows: [] as unknown[] },
  methods: {
    addTwo(s: S, a: string, b: string) {
      s.rows.push({ a, b });
    },
    setModel(s: S, m: string) {
      s.rows.push(m);
    },
    async load(s: S, id: string) {
      await Promise.resolve();
      s.rows.push(id);
    },
  },
});

/** Every warn/info line (logger + console) during `fn`. */
async function capture(fn: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _c: string, m: string) => {
        if (lvl === "warn") lines.push(m);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  const info = console.info;
  const warn = console.warn;
  console.info = (...a: unknown[]) => void lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
  _resetShortCallWarnings();
  try {
    await fn();
  } finally {
    setLogger(prev);
    console.info = info;
    console.warn = warn;
  }
  return lines;
}

const shortWarns = (l: string[]) =>
  l.filter((w) => /declares \d+ argument/.test(w));

testCell(
  c,
  "fuzz: randomActions is silent per method, one summary line",
  async (t) => {
    const lines = await capture(async () => {
      t.randomActions(60);
      await t.settle();
    });
    assertEquals(
      shortWarns(lines),
      [],
      "the fuzzer's by-design no-payload calls warned per method",
    );
    const summary = lines.filter((l) => l.includes("randomActions(60)"));
    assertEquals(
      summary.length,
      1,
      `not ONE summary line: ${lines.join("\n")}`,
    );
    assert(summary[0]!.includes("by design"));
  },
);

testCell(
  c,
  "fuzz: t.fuzz is silent per method, one summary line",
  async (t) => {
    const lines = await capture(async () => {
      t.fuzz({ n: 40, seed: 7 });
      await t.settle();
    });
    assertEquals(shortWarns(lines), []);
    assertEquals(lines.filter((l) => l.includes("fuzz(40)")).length, 1);
  },
);

testCell(
  c,
  "fuzz: a REAL short call still warns, outside and after a fuzz",
  async (t) => {
    const lines = await capture(async () => {
      t.randomActions(20);
      // deno-lint-ignore no-explicit-any
      const send = t.send as any;
      await send.setModel(); // zero args, not a fuzz: real misuse
      await send.addTwo("one"); // one short
      await send.load();
    });
    const w = shortWarns(lines);
    assert(
      w.some((m) => m.includes("fuzzquiet:setModel") && m.includes("passed 0")),
      `a real zero-argument call was silenced: ${JSON.stringify(lines)}`,
    );
    assert(
      w.some((m) => m.includes("fuzzquiet:addTwo") && m.includes("passed 1")),
    );
    assert(
      w.some((m) => m.includes("fuzzquiet:load")),
      "async short call silent",
    );
  },
);
