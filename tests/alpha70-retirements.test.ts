// alpha70 — the LAST breaking release. Every alpha52-era alias that had been
// "through beta" goes out together, and each one leaves through the removals
// registry (src/state/removals.ts): a row with the escape-hatch pin, a
// textual detector `am pin` reads the app's source with, and — for the
// spellings that are READ FROM CONFIG and so cannot simply cease to exist —
// the dev/prod split: dev THROWS, prod LOGS and honours (category (b) of the
// dev==prod rule; never a silent divergence).
//
// Each test here goes red if its retirement is reverted.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell.ts";
import {
  refuseRetired,
  removalFor,
  removalOf,
  REMOVALS,
  removalsInDenoJson,
  removalsInSource,
  removedAmVerb,
  retiredSpellingLine,
} from "../src/state/removals.ts";
import { resolveVisibility } from "../src/state/cell-helpers.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { retiredDenoJsonKeys } from "../src/server/config.ts";
import { unknownCommandLine } from "../src/am.ts";
import { isCheckoutArg } from "../src/am/am-cmd-remove.ts";
import { preflight } from "../src/am/am-cmd-pin.ts";
import { blocking, blockingUnavailableReason } from "../src/state/blocking.ts";
import { schedule } from "../src/state/schedule.ts";
import { log } from "../src/diagnostics/logger-api.ts";

let n = 0;
const uname = (base: string) => `${base}-a70-${++n}`;

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

const A70 = REMOVALS.filter((r) => r.removedIn === "alpha70");
/** The alias retirements this file pins (other alpha70 rows have their own). */
const MINE = new Set([
  "CellAccess",
  "ServerFnAccess",
  "ExtractState",
  "Action (aio/air)",
  "schedule.poll({ backoff })",
  "schedule.backoff/poll(id, attempt, opts, action)",
  "cell({ ui })",
  "cellDefaults.ui",
  "listensTo: [...]",
  "target",
  "schedule.blocking",
  "connectDevTools()",
  "new",
  "update",
  "ls",
  "log",
  "tt",
  "release",
]);

// ── the rows ──────────────────────────────────────────────────────────

Deno.test("alpha70: every retired spelling has a registry row with the alpha69 pin", () => {
  const keys = new Set(A70.map((r) => r.key));
  assert(A70.length >= MINE.size, "the alpha70 rows exist");
  for (const k of MINE) assert(keys.has(k), `no alpha70 row for '${k}'`);
  for (const r of A70) {
    assertEquals(r.lastGood, "v1.0.0-alpha69", `${r.key}: escape-hatch pin`);
  }
  // Every row above is a RENAME — it must say what it is spelled now.
  for (const r of A70.filter((r) => keys.has(r.key) && MINE.has(r.key))) {
    assert(r.now, `${r.key}: a rename says what it is spelled now`);
  }
});

Deno.test("alpha70: the refusal line leads with the new spelling, then both exits", () => {
  const line = retiredSpellingLine(removalOf("ExtractState"));
  assert(line.startsWith("`ExtractState` is spelled `StateOf` now — "), line);
  assertStringIncludes(line, "removed in alpha70");
  assertStringIncludes(line, "am pin v1.0.0-alpha69 && am fix");
  assertStringIncludes(line, "docs/upgrade/from-alpha69-to-alpha70.md");
  // an am verb reads as the command a user typed
  const verb = retiredSpellingLine(removalOf("ls"));
  assert(verb.startsWith("`am ls` is spelled `am instances` now — "), verb);
});

// ── the dev/prod split for config-read spellings ─────────────────────

Deno.test("alpha70: refuseRetired THROWS in dev and LOGS (error level) in prod — same words", () => {
  const r = removalOf("cell({ ui })");
  const thrown = withDev(
    true,
    () => assertThrows(() => refuseRetired(r, "cell:x"), Error) as Error,
  );
  const { errors } = withDev(
    false,
    () => captureErrors(() => refuseRetired(r, "cell:x")),
  );
  assertEquals(errors.length, 1, "prod logs exactly one line");
  assertStringIncludes(errors[0]!, "removals");
  assertStringIncludes(errors[0]!, thrown.message);
});

Deno.test("alpha70: cell({ ui }) — dev refuses by name; prod logs AND still honours the filter", () => {
  withDev(true, () => {
    const err = assertThrows(
      () =>
        cell(uname("ui-dev"), {
          state: { a: 1, b: 2 },
          methods: {},
          // deno-lint-ignore no-explicit-any
          ...({ ui: { exclude: ["b"] } } as any),
        }),
      Error,
    ) as Error;
    assertStringIncludes(err.message, "spelled `visible` now");
    assertStringIncludes(err.message, "am pin v1.0.0-alpha69");
  });
  withDev(false, () => {
    const name = uname("ui-prod");
    const { result: c, errors } = captureErrors(() =>
      cell(name, {
        state: { a: 1, b: 2 },
        methods: {},
        // deno-lint-ignore no-explicit-any
        ...({ ui: { exclude: ["b"] } } as any),
      })
    );
    assertEquals(errors.length, 1, "prod: one error line");
    assertStringIncludes(errors[0]!, `cell:${name}`);
    // Honoured — a dropped visibility filter would be a leak, not a cleanup.
    assertEquals(c.__aio.ui, { exclude: ["b"] });
    const { autoGetUIState } = composeCellsWiring({ cellEntries: [c] });
    const out = autoGetUIState!({ [name]: { a: 1, b: 2 } }) as Record<
      string,
      unknown
    >;
    assertEquals(out[name], { a: 1 });
  });
});

Deno.test("alpha70: resolveVisibility names the cellDefaults row for the app-level default", () => {
  withDev(true, () => {
    const err = assertThrows(
      () => resolveVisibility("cellDefaults", { ui: "all" }),
      Error,
    ) as Error;
    assertStringIncludes(err.message, "`cellDefaults.ui` is spelled");
    assertStringIncludes(err.message, "cellDefaults.visible");
  });
  withDev(false, () => {
    const a = cell(uname("dflt-prod"), { state: { x: 1, z: 2 }, methods: {} });
    const { errors } = captureErrors(() => {
      const { autoGetUIState } = composeCellsWiring({
        cellEntries: [a],
        // deno-lint-ignore no-explicit-any
        cellDefaults: { ui: { exclude: ["z"] } } as any,
      });
      const out = autoGetUIState!({ [a.__aio.id]: { x: 1, z: 2 } }) as Record<
        string,
        unknown
      >;
      assertEquals(out[a.__aio.id], { x: 1 }, "prod honours the default");
    });
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!, "cellDefaults.ui");
  });
});

Deno.test("alpha70: listensTo array form — dev refuses; prod logs and still routes", () => {
  const src = cell(uname("src"), {
    state: { n: 0 },
    methods: {
      bump(s) {
        s.n++;
      },
    },
  });
  withDev(true, () => {
    const err = assertThrows(
      () =>
        cell(uname("arr-dev"), {
          state: { seen: 0 },
          methods: {},
          // deno-lint-ignore no-explicit-any
          ...({ listensTo: [src.bump] } as any),
        }),
      Error,
    ) as Error;
    assertStringIncludes(err.message, "listensTo: { handler: other.method }");
    assertStringIncludes(err.message, "am pin v1.0.0-alpha69");
  });
  withDev(false, () => {
    const { result: c, errors } = captureErrors(() =>
      cell(uname("arr-prod"), {
        state: { seen: 0 },
        methods: {},
        // deno-lint-ignore no-explicit-any
        ...({ listensTo: [src.bump] } as any),
      })
    );
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0]!, "listensTo: [...]");
    // still routes — the foreign action is wired into the cell
    assertEquals(c.__aio.foreignActions, [src.bump.type], "prod honours it");
  });
});

// ── deno.json `target` ────────────────────────────────────────────────

Deno.test("alpha70: deno.json `target` is a removed key — config.ts reports it, `client` is silent", () => {
  assertEquals(retiredDenoJsonKeys({ client: "browser" }), []);
  const hits = retiredDenoJsonKeys({ target: "electron" });
  assertEquals(hits.map((r) => r.key), ["target"]);
  assertEquals(removalsInDenoJson(undefined), []);
  assertStringIncludes(
    retiredSpellingLine(hits[0]!),
    'deno.json key "target" was removed in alpha70',
  );
});

// ── am verbs ─────────────────────────────────────────────────────────

Deno.test("alpha70: a dropped am verb answers with the new spelling in one line — never a silent forward", () => {
  for (
    const [old, now] of [
      ["new", "add"],
      ["update", "upgrade"],
      ["ls", "instances"],
      ["log", "logs"],
      ["tt", "timetravel"],
      ["release", "publish"],
    ]
  ) {
    const line = unknownCommandLine(old!);
    assert(
      line.startsWith(`\`am ${old}\` is spelled \`am ${now}\` now`),
      `am ${old}: ${line}`,
    );
    assertStringIncludes(line, "am pin v1.0.0-alpha69");
    assertEquals(removedAmVerb(old!)?.now, now);
  }
  // an actual typo is still a plain unknown-command line
  assertEquals(
    unknownCommandLine("strat"),
    'unknown command: strat — run "am help" for usage',
  );
  assertEquals(removedAmVerb("start"), null);
});

Deno.test("alpha70: the am command map has ONE spelling per verb", async () => {
  const src = await Deno.readTextFile("src/am.ts");
  const map = src.slice(
    src.indexOf("const COMMANDS"),
    src.indexOf("};", src.indexOf("const COMMANDS")),
  );
  for (const gone of ["ls", "log", "tt", "release", "new", "update"]) {
    assert(
      !new RegExp(`^\\s*${gone}:`, "m").test(map),
      `am.ts still maps the dropped verb \`${gone}\``,
    );
  }
  for (
    const kept of [
      "instances",
      "logs",
      "timetravel",
      "publish",
      "upgrade",
      "add",
    ]
  ) {
    assert(new RegExp(`^\\s*${kept}:`, "m").test(map), `\`${kept}\` missing`);
  }
});

Deno.test("alpha70: `am upgrade <checkout>` is how a dev am is selected (was `am update <path>`)", () => {
  assertEquals(isCheckoutArg("../aio"), true);
  assertEquals(isCheckoutArg("~/code/aio"), true);
  assertEquals(isCheckoutArg("/abs/path"), true);
  assertEquals(isCheckoutArg("."), true);
  assertEquals(isCheckoutArg("my-app"), false, "an installed app's name");
});

// ── textual detection: what `am pin` preflight reads ─────────────────

Deno.test("alpha70: removalsInSource finds every retired API spelling — in code only", () => {
  const src = [
    `import { cell, type CellAccess } from "aio";`, // 1
    `import { type Action } from "aio/air";`, // 2
    `type S = ExtractState<typeof c>;`, // 3
    `// CellAccess in a comment is not a hit`, // 4
    `const s = "ServerFnAccess";`, // 5 (string — not code)
    `schedule.poll("x", n, A, { every: 100, backoff: 2 });`, // 6
    `schedule.backoff("y", n, { base: 100 }, A);`, // 7
    `cell("c", { ui: { exclude: ["k"] } });`, // 8
    `aio.run({ ui: { width: 900, height: 600 } });`, // 9 — window config
    `aio.run({ cellDefaults: { ui: "all" } });`, // 10
    `cell("d", { listensTo: [other.m] });`, // 11
    `await schedule.blocking("id", fn);`, // 12
    `connectDevTools();`, // 13
    `listensTo: { onX: [a.m, b.m] },`, // 14 — the object form
  ].join("\n");
  const hits = removalsInSource(src).map((h) => [h.removal.key, h.line]);
  assertEquals(hits, [
    ["CellAccess", 1],
    ["Action (aio/air)", 2],
    ["ExtractState", 3],
    ["schedule.poll({ backoff })", 6],
    ["schedule.backoff/poll(id, attempt, opts, action)", 7],
    ["cell({ ui })", 8],
    ["cellDefaults.ui", 10],
    ["listensTo: [...]", 11],
    ["schedule.blocking", 12],
    ["connectDevTools()", 13],
  ]);
  // A current-style app is clean — the window `ui:` above did NOT match.
  assertEquals(removalsInSource(`aio.run({ ui: { width: 900 } });`), []);
  assertEquals(removalsInSource(`type Action = { type: string };`), []);
});

Deno.test("alpha70: `am pin` preflight refuses a forward move on a retired spelling with file:line, and reads deno.json too", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-a70-preflight-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      `{\n  "name": "x",\n  "target": "electron"\n}\n`,
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "src", "types.ts"),
      `import type { StateOf } from "aio";\n` +
        `export type Legacy<F> = ExtractState<F>;\n`,
    );
    const forward = await preflight(dir, "v1.0.0-alpha70");
    assertEquals(
      forward.map((b) => [b.where, b.hit.removal.key]),
      [
        ["deno.json:3", "target"],
        [join("src", "types.ts") + ":2", "ExtractState"],
      ],
    );
    assertStringIncludes(forward[1]!.hit.text, "ExtractState<F>");
    // Moving BACK to the version that still ran it is silent.
    assertEquals(await preflight(dir, "v1.0.0-alpha69"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── what is simply gone ───────────────────────────────────────────────

Deno.test("alpha70: the type aliases are gone from their modules (not just from docs)", async () => {
  const gone: Array<[string, RegExp]> = [
    ["src/state/cell-types.ts", /export type (CellAccess|ExtractState)\b/],
    ["src/server/server-fns.ts", /export type ServerFnAccess\b/],
    ["src/air/vdom-types.ts", /export type Action\b/],
    ["src/state/cell-config-types.ts", /^\s*ui\?:/m],
    ["src/state/cell-defaults.ts", /^\s*ui\?:/m],
    ["src/state/schedule.ts", /^\s*backoff\?:\s*number/m],
  ];
  assert(gone.length > 0, "the retired declarations are listed");
  for (const [file, re] of gone) {
    const src = await Deno.readTextFile(file);
    assert(!re.test(src), `${file} still declares ${re}`);
  }
});

Deno.test("alpha70: `blocking` REFUSES off Deno with a message that names the platform and the fix", async () => {
  assertEquals(blockingUnavailableReason("x"), null, "on Deno it runs");
  // Simulate the standalone/WebView runtime: no Deno namespace.
  const g = globalThis as { Deno?: unknown };
  const real = g.Deno;
  try {
    delete g.Deno;
    const why = blockingUnavailableReason("crunch");
    assert(why, "off Deno it refuses");
    assertStringIncludes(why, "blocking('crunch') is server-only");
    assertStringIncludes(why, "standalone");
    const err = await assertRejects(() => blocking("crunch", () => 1), Error);
    assertStringIncludes(err.message, "server-only");
  } finally {
    g.Deno = real;
  }
  assertEquals(
    "blocking" in schedule,
    false,
    "and it is not a schedule member",
  );
});

Deno.test("alpha70: removalFor is null for every spelling that is still API", () => {
  for (
    const k of [
      "visible",
      "client",
      "factor",
      "StateOf",
      "Access",
      "NodeAction",
    ]
  ) {
    assertEquals(removalFor(k), null, k);
  }
});
