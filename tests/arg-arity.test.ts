// `args` lists one rule per argument AFTER the draft `s`. A list longer than
// that is always wrong — a field report wrote `[null, null, v]` as if `s`
// took slot 0 — and is now warned at cell() time. The count is read from
// the method's source; a wrong count would be a false alarm, so it is pinned
// here across every spelling a method takes.
import { assertEquals } from "@std/assert";
import { declaredArgCount } from "../src/state/arg-arity.ts";
import { cell } from "../mod.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

Deno.test("declaredArgCount: every method spelling", () => {
  const o = {
    shorthand(_s: unknown, _a: number, _b: string) {},
    async asyncShort(_s: unknown, _a: number) {},
    defaults(_s: unknown, _a = 1, _b = "x, y") {},
    destructured(
      _s: unknown,
      { a, b }: { a: number; b: number },
      [c]: number[],
    ) {
      return a + b + (c ?? 0);
    },
    trailing(_s: unknown, _a: number) {},
    none(_s: unknown) {},
    rest(_s: unknown, ..._r: unknown[]) {},
    nested(_s: unknown, _f = (x: number, y: number) => x + y) {},
  };
  assertEquals(declaredArgCount(o.shorthand), 2);
  assertEquals(declaredArgCount(o.asyncShort), 1);
  assertEquals(
    declaredArgCount(o.defaults),
    2,
    "defaults count (fn.length would not)",
  );
  assertEquals(declaredArgCount(o.destructured), 2);
  assertEquals(declaredArgCount(o.trailing), 1);
  assertEquals(declaredArgCount(o.none), 0);
  assertEquals(
    declaredArgCount(o.rest),
    null,
    "a rest parameter takes any number",
  );
  assertEquals(declaredArgCount(o.nested), 1);
  assertEquals(declaredArgCount((_s: unknown, _v: number) => {}), 1);
  assertEquals(declaredArgCount(async (_s: unknown) => {}), 0);
  // deno-lint-ignore no-explicit-any
  assertEquals(declaredArgCount(((s: any) => s) as never), 0);
  assertEquals(declaredArgCount(function (_s: unknown, _a: number) {}), 1);
});

/** Warnings logged while `fn` runs. */
function warnings(fn: () => void): string[] {
  const got: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") got.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    fn();
  } finally {
    setLogger(prev);
  }
  return got;
}

Deno.test("cell(): an args list longer than the method's arguments is WARNED — and still runs", () => {
  const got = warnings(() =>
    cell("arity-long", {
      state: { n: 0 },
      args: {
        set: [null, null, (v: unknown) => typeof v === "number" || "a number"],
      },
      methods: {
        set(s: { n: number }, _a: number, b: number) {
          s.n = b;
        },
      },
    })
  );
  const hit = got.filter((m) => m.includes("args.set"));
  assertEquals(hit.length, 1, got.join("\n"));
  assertEquals(
    hit[0],
    "arity-long: args.set lists 3 rules, but set takes 2 arguments after `s` — " +
      "slot 0 is the FIRST argument, not `s`. As written, rule 3+ never runs " +
      "and the others may be shifted by one.",
  );
});

Deno.test("cell(): a correct or shorter args list says nothing", () => {
  const got = warnings(() =>
    cell("arity-ok", {
      state: { n: 0 },
      args: {
        set: [(v: unknown) => typeof v === "number" || "a number"],
        pair: [null],
        any: [null, null, null],
      },
      methods: {
        set(s: { n: number }, v: number) {
          s.n = v;
        },
        pair(s: { n: number }, a: number, b = 0) {
          s.n = a + b;
        },
        any(s: { n: number }, ...xs: number[]) {
          s.n = xs.length;
        },
      },
    })
  );
  assertEquals(got.filter((m) => m.includes("args.")), []);
});
