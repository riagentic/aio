// alpha76 — the PRE-BETA sweep. Beta freezes the public surface all the way to
// 1.0, so a spelling still marked "deprecated through beta" would have become
// permanent. Six of them had no removal date and no registry row; they leave
// here, together with the one config key whose CLI flag had already been
// renamed without it.
//
// Every one leaves the way this repo removes things: a row in
// src/state/removals.ts, so the runtime refusal, the `aiol` finding, `am pin`'s
// preflight and the upgrade guide say the same words — including the second
// exit (`am pin v1.0.0-alpha75`), which a user is always entitled to.
//
// Each test here goes red if its retirement is reverted.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { schedule } from "../src/state/schedule.ts";
import {
  REMOVALS,
  removalsAreFatal,
  removalsInSource,
} from "../src/state/removals.ts";
import { _resetSelectorHints } from "../src/state/cell-helpers.ts";
import { _resetReturnEffectHints } from "../src/state/cell-methods-internals.ts";
import { _resetParsedCli, parseCli } from "../src/server/aio-cli.ts";
import {
  AIO_RUNTIME_FLAG_SPECS,
  AIO_RUNTIME_FLAGS,
} from "../src/diagnostics/runtime-flags.ts";
import { VALID_AIO_CONFIG_KEYS } from "../src/server/config.ts";
import { log } from "../src/diagnostics/logger-api.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

let n = 0;
const uname = (base: string) => `${base}-a76-${++n}`;

/** Run `fn` with `__aioDev` forced to `dev`, restoring whatever was set. */
function withDev<T>(dev: boolean, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const prev = g.__aioDev;
  g.__aioDev = dev;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete g.__aioDev;
    else g.__aioDev = prev;
  }
}

/** Capture what the framework logs at ERROR level — the prod half. */
function captureErrors<T>(fn: () => T): { result: T; errors: string[] } {
  const errors: string[] = [];
  // deno-lint-ignore no-explicit-any
  const orig = (log as any).error;
  // deno-lint-ignore no-explicit-any
  (log as any).error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), errors };
  } finally {
    // deno-lint-ignore no-explicit-any
    (log as any).error = orig;
  }
}

const A76 = REMOVALS.filter((r) => r.removedIn === "alpha76");
/** Everything this release retired, by registry key. */
const MINE = [
  "return effect(s) from a method",
  "selector deps as a spread",
  "--kill-existing",
  "--server-url",
  "--zero-port",
  "--backup-logs",
  "aio.run({ killExisting })",
];

// ── the rows ──────────────────────────────────────────────────────────

Deno.test("alpha76: every retired spelling has a row pinned to alpha75", () => {
  const keys = new Set(A76.map((r) => r.key));
  assertEquals(A76.length, MINE.length, "no stray alpha76 row");
  for (const k of MINE) assert(keys.has(k), `no alpha76 row for '${k}'`);
  for (const r of A76) {
    assertEquals(r.lastGood, "v1.0.0-alpha75");
    assertEquals(r.guide, "docs/upgrade/from-alpha75-to-alpha76.md");
  }
});

Deno.test("alpha76: a rename names its replacement; a deletion names none", () => {
  const now = Object.fromEntries(A76.map((r) => [r.key, r.now]));
  assertEquals(now["return effect(s) from a method"], "s.$do(effect)");
  assertEquals(now["--kill-existing"], "--takeover");
  assertEquals(now["--server-url"], "--connect");
  assertEquals(now["aio.run({ killExisting })"], "aio.run({ takeover })");
  // These two did NOTHING — there is no successor spelling to name, and
  // inventing one would send the reader looking for a flag to type.
  assertEquals(now["--zero-port"], undefined);
  assertEquals(now["--backup-logs"], undefined);
});

// ── 1. the return channel ─────────────────────────────────────────────

Deno.test("alpha76: returning an effect is refused, and the refusal names $do", async () => {
  _resetReturnEffectHints();
  const name = uname("reteff");
  const c = cell(name, {
    state: { n: 0 },
    methods: {
      tick(s: { n: number }) {
        s.n++;
      },
      arm(): unknown {
        return schedule.after(`${name}:t`, 10, { type: `${name}:tick` });
      },
      async armAsync(): Promise<unknown> {
        await Promise.resolve();
        return schedule.after(`${name}:t2`, 10, { type: `${name}:tick` });
      },
    },
  });
  const h = await bootCells([c]);
  try {
    for (const m of ["arm", "armAsync"] as const) {
      const e = await assertRejects(() => (c as Any)[m]());
      const msg = String(e);
      assertStringIncludes(msg, "s.$do(effect)");
      assertStringIncludes(msg, "removed in alpha76");
      assertStringIncludes(msg, "am pin v1.0.0-alpha75");
      assertStringIncludes(msg, `${name}.${m}`, "names the cell AND method");
    }
    await h.advance(20);
    assertEquals((c as Any).n, 0, "a refused channel schedules nothing");
  } finally {
    h.dispose();
  }
});

Deno.test("alpha76: $do keeps `return` free — one call does both", async () => {
  const name = uname("bothch");
  const c = cell(name, {
    state: { n: 0 },
    methods: {
      tick(s: { n: number }) {
        s.n++;
      },
      arm(s) {
        s.$do(schedule.after(`${name}:t`, 10, { type: `${name}:tick` }));
        return "armed"; // the value the caller awaits — used to be swallowed
      },
    },
  });
  const h = await bootCells([c]);
  try {
    assertEquals(await (c as Any).arm(), "armed");
    await h.advance(20);
    assertEquals((c as Any).n, 1, "…and the effect still ran");
  } finally {
    h.dispose();
  }
});

// ── 2. selector deps as a spread ──────────────────────────────────────

/** A cell whose deps selector uses the retired spread signature. */
function legacySelectorCell(name: string) {
  return () =>
    cell(name, {
      state: { n: 7 },
      methods: {},
      selectors: {
        scaled: {
          deps: [`${name}_dep`],
          fn: (s: Any, other: Any) => s.n * (other?.factor ?? 1),
        },
      },
    });
}

Deno.test("alpha76: the spread deps signature — dev refuses by name", () => {
  _resetSelectorHints();
  const name = uname("spread");
  const e = withDev(true, () => assertThrows(legacySelectorCell(name), Error));
  const msg = String(e);
  assertStringIncludes(msg, `${name}.scaled`);
  assertStringIncludes(msg, "fn: (s, [dep1, dep2], ...args)");
  assertStringIncludes(msg, "am pin v1.0.0-alpha75");
});

Deno.test("alpha76: the spread deps signature — prod logs and still spreads", () => {
  _resetSelectorHints();
  const name = uname("spread");
  const { result, errors } = withDev(
    false,
    () => captureErrors(legacySelectorCell(name)),
  );
  assert(result, "prod must not throw — it degrades, loudly");
  assertEquals(errors.length, 1, "…and says so exactly once per selector");
  assertStringIncludes(errors[0]!, "removed in alpha76");
  // Still SERVED: a selector silently handed a tuple where it expects a slice
  // renders the wrong number, which is worse than an error line.
  const scoped = (result as Any).__aio.selectors.scaled as (
    own: unknown,
    full: unknown,
  ) => number;
  assertEquals(
    scoped({ n: 7 }, { [name]: { n: 7 }, [`${name}_dep`]: { factor: 3 } }),
    21,
  );
});

Deno.test("alpha76: refuseRetired's dev gate is the one `removalsAreFatal` reports", () => {
  // The prod-side throttles (once per method / once per selector) branch on
  // this. If it drifted from the branch that actually throws, a dev refusal
  // would quietly become once-per-process — a coin flip, not a guard.
  assertEquals(withDev(true, removalsAreFatal), true);
  assertEquals(withDev(false, removalsAreFatal), false);
});

// ── 3-6. the runtime flags ────────────────────────────────────────────

const RETIRED_FLAGS = ["--kill-existing", "--zero-port", "--backup-logs"];

Deno.test("alpha76: every retired flag is REFUSED, naming its replacement", () => {
  for (const flag of [...RETIRED_FLAGS, "--server-url"]) {
    _resetParsedCli();
    const e = assertThrows(() => parseCli([flag]), Error);
    const msg = String(e);
    assertStringIncludes(msg, flag);
    assertStringIncludes(msg, "removed in alpha76");
    assertStringIncludes(msg, "am pin v1.0.0-alpha75");
  }
  _resetParsedCli();
  assertStringIncludes(
    String(assertThrows(() => parseCli(["--kill-existing"]), Error)),
    "--takeover",
  );
  _resetParsedCli();
  assertStringIncludes(
    String(assertThrows(() => parseCli(["--server-url"]), Error)),
    "--connect",
  );
});

Deno.test("alpha76: a flag is refused, never degraded — argv is read before boot", () => {
  // A no-op flag that merely warns is how `--zero-port` survived ten releases
  // with "No-op (accepted)" as its documented behaviour. Nothing is half
  // started when argv is parsed, so there is nothing to protect by degrading.
  _resetParsedCli();
  assertThrows(() => parseCli(["--zero-port"]), Error);
  _resetParsedCli();
  assertThrows(() => parseCli(["--verbose", "--backup-logs"]), Error);
});

Deno.test("alpha76: the surviving spellings still parse", () => {
  _resetParsedCli();
  assertEquals(parseCli(["--takeover"]).takeover, true);
  _resetParsedCli();
  assertEquals(parseCli(["--connect"]).serverUrl, "");
  _resetParsedCli();
  // The VALUED --server-url keeps its name: it really is a server URL.
  assertEquals(parseCli(["--server-url=http://h:1"]).serverUrl, "http://h:1");
  _resetParsedCli();
  assertEquals(parseCli(["--no-backup-logs"]).backupLogs, false);
});

Deno.test("alpha76: a retired flag is out of the vocabulary, so nothing suggests it", () => {
  // `nearestOf` offers a did-you-mean off this list, and `aio/cli`'s args()
  // passes aio's own flags through. A removed flag left in either would be
  // recommended by the very release that removed it.
  for (const flag of RETIRED_FLAGS) {
    assert(!AIO_RUNTIME_FLAGS.has(flag), `${flag} is still in the flag set`);
    assert(
      !AIO_RUNTIME_FLAG_SPECS.includes(flag),
      `${flag} is still in the flag specs`,
    );
  }
  // The replacements ARE in it.
  assert(AIO_RUNTIME_FLAGS.has("--takeover"));
  assert(AIO_RUNTIME_FLAGS.has("--connect"));
  assert(AIO_RUNTIME_FLAGS.has("--no-backup-logs"));
});

Deno.test("alpha76: --help teaches no removed flag", async () => {
  const src = await Deno.readTextFile("src/server/aio-cli.ts");
  const help = src.slice(src.indexOf("aio ${VERSION} — all-in-one framework"));
  for (const flag of RETIRED_FLAGS) {
    assert(
      !help.includes(`  ${flag} `) && !help.includes(`  ${flag}\n`),
      `--help still lists ${flag}`,
    );
  }
  assert(!help.includes("No-op (accepted)"), "no flag documents doing nothing");
});

// ── 7. the config key follows the flag ────────────────────────────────

Deno.test("alpha76: `takeover` is the config key, and `killExisting` is not", () => {
  assert(
    VALID_AIO_CONFIG_KEYS.has("takeover"),
    "aio.run({ takeover }) must be accepted — a compiled service binary " +
      "cannot pass a flag, which is the whole reason the key exists",
  );
  assert(
    !VALID_AIO_CONFIG_KEYS.has("killExisting"),
    "the retired spelling is not a valid key",
  );
});

Deno.test("alpha76: `killExisting:` is findable in an app's own source", () => {
  // `am pin` reads this before it moves an app forward, so the upgrade is a
  // preflight list rather than a boot-time explosion.
  const hits = removalsInSource(
    `await aio.run({ appId: "x", killExisting: true, cells });\n`,
  );
  assertEquals(hits.map((h) => h.removal.key), ["aio.run({ killExisting })"]);
  // …and prose about it is not a hit (the scanner reads CODE only).
  assertEquals(
    removalsInSource(`// we used to pass killExisting: true here\n`).length,
    0,
  );
});

Deno.test("alpha76: the retired return channel is findable in source too", () => {
  const hits = removalsInSource(
    `methods: { arm(s) { return schedule.after("t", 10, a); } }\n`,
  );
  assertEquals(hits.map((h) => h.removal.key), [
    "return effect(s) from a method",
  ]);
  assertEquals(
    removalsInSource(
      `methods: { arm(s) { s.$do(schedule.after("t", 10, a)); } }`,
    )
      .length,
    0,
    "the CURRENT spelling must never be reported",
  );
});

Deno.test("alpha76: the spread selector is findable, and the tuple form is not", () => {
  const legacy = removalsInSource(
    `selectors: { cost: { deps: ["prices"], fn: (s, prices) => s.n } }\n`,
  );
  assertEquals(legacy.map((h) => h.removal.key), ["selector deps as a spread"]);
  for (
    const ok of [
      `selectors: { cost: { deps: ["prices"], fn: (s, [prices]) => s.n } }`,
      `selectors: { cost: { deps: ["prices"], fn: (s, [prices], id) => s.n } }`,
      `selectors: { cost: { deps: ["prices"], fn: (s) => s.n } }`,
    ]
  ) {
    assertEquals(removalsInSource(ok).length, 0, ok);
  }
});
