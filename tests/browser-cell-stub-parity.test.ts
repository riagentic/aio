// The BROWSER cell stub (src/browser/protocol-cell.ts) is a second, hand-kept
// implementation of `cell()`. It is what the shipped browser bundle runs —
// `aio` resolves to src/browser-air.ts, whose `cell` is this stub — while every
// in-process harness (testUI/testCell/standalone) runs the REAL factory
// (src/state/cell-create.ts). Two implementations of one fact means every test
// in the suite can be green while the browser is broken.
//
// CLAUDE.md states the rule ("any per-method flag the browser branches on must
// be mirrored in the separate browser cell stub"). This file makes it a GATE
// instead of a note: it walks the real import graph of the browser bundle,
// collects every `__aio.<key>` the browser actually reads, and asserts the stub
// produces each one — with the same SHAPE the reader expects.
import { assert, assertEquals } from "@std/assert";
import { cell as serverCell } from "../src/state/cell-create.ts";
import { cell as browserCell } from "../src/browser/protocol-cell.ts";
import {
  _resetCellRegistry,
  bindCellReactive,
} from "../src/state/cell-reactive.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { _resetSignals, getCellSignal } from "../src/state/state-signals.ts";

// ── The browser's real read set ─────────────────────────────────────

const SRC = new URL("../src/", import.meta.url);
/** The bundle entry — build-bundle.ts aliases `aio` to this for the browser. */
const BROWSER_ENTRY = "browser-air.ts";
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^"'\n]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
/** `x.__aio.key`, `def.__aio?.key`, `f.__aio  .key` — the reads to mirror. */
const AIO_READ_RE = /__aio\??\s*\.\s*([A-Za-z_$][\w$]*)/g;

async function browserAioReads(): Promise<Map<string, Set<string>>> {
  const reads = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const queue = [new URL(BROWSER_ENTRY, SRC).href];
  while (queue.length > 0) {
    const url = queue.pop()!;
    if (visited.has(url)) continue;
    visited.add(url);
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(url));
    } catch {
      continue; // type-only / generated — the type-checker owns existence
    }
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || (!spec.startsWith("./") && !spec.startsWith("../"))) {
        continue;
      }
      const child = new URL(spec, url).href;
      if (child.endsWith(".ts") || child.endsWith(".tsx")) queue.push(child);
    }
    const rel = url.slice(SRC.href.length);
    // The stub itself declares the keys; reading it would be circular.
    if (rel === "browser/protocol-cell.ts") continue;
    for (const m of text.matchAll(AIO_READ_RE)) {
      if (!reads.has(m[1]!)) reads.set(m[1]!, new Set());
      reads.get(m[1]!)!.add(rel);
    }
  }
  return reads;
}

/** Keys the browser reads that the stub deliberately does not carry, each with
 *  the reason. Anything else missing is a bug, not a decision. */
const NOT_MIRRORED: Record<string, string> = {
  // Browser-only additions: the CRDT engine's replay reducer and the
  // closure that installs it. The server has no equivalent (it runs the real
  // methods), so there is nothing to mirror.
  reduce: "browser-only — optimistic-rebase replay reducer",
  enableSync: "browser-only — installs syncConfig + reduce lazily",
};

// A config exercising every mirrored key at once.
function makeConfig() {
  return {
    state: { n: 21, secret: "s3cret", note: "hi" },
    methods: {
      bump: (s: { n: number }) => {
        s.n += 1;
      },
      // deno-lint-ignore require-await
      load: async (s: { note: string }) => {
        s.note = "loaded";
      },
    },
    selectors: {
      plain: (s: { n: number }) => s.n + 1,
      withDeps: {
        deps: ["parity-dep"],
        fn: (s: { n: number }, [d]: [{ rate: number }]) => s.n * d.rate,
      },
    },
    visible: { exclude: ["secret"] },
    sync: true,
    // `long` has to be exercised here or the stub's key is never produced —
    // and the browser resolves the same call ceiling the server does, so a
    // long method missing from the stub gives up at 30s in the browser only.
    long: ["load"],
  };
}

function reset(): void {
  _resetAioRuntime();
  _resetSignals();
  _resetCellRegistry();
}

Deno.test("browser cell stub mirrors every __aio key the browser bundle reads", async () => {
  reset();
  const reads = await browserAioReads();
  assert(
    reads.size > 5,
    "graph walk found almost no __aio reads — walker broke?",
  );

  // One config cannot exercise every branch (scope/syncConfig/syncOptOut are
  // mutually exclusive), so the stub must be able to PRODUCE each key under at
  // least one shape a real app can write.
  const configs: Record<string, unknown>[] = [
    makeConfig(),
    { state: { n: 0 }, methods: { bump: (s: { n: number }) => s.n++ } },
    {
      state: { n: 0 },
      methods: { bump: (s: { n: number }) => s.n++ },
      scope: "client",
    },
    {
      state: { n: 0 },
      methods: { bump: (s: { n: number }) => s.n++ },
      sync: false,
    },
  ];
  const produced = new Set<string>();
  configs.forEach((c, i) => {
    // deno-lint-ignore no-explicit-any
    const d = browserCell(`parity-shape-${i}`, c as any);
    for (const [k, v] of Object.entries(d.__aio as Record<string, unknown>)) {
      if (v !== undefined) produced.add(k);
    }
  });

  const missing: string[] = [];
  for (const [key, files] of reads) {
    if (key in NOT_MIRRORED) continue;
    if (!produced.has(key)) {
      missing.push(`${key} (read by ${[...files].sort().join(", ")})`);
    }
  }
  assertEquals(
    missing,
    [],
    `the browser bundle reads __aio key(s) the browser cell stub never sets — ` +
      `each one is a silent client/server divergence:\n  ` +
      missing.join("\n  ") +
      `\nfix: set them in src/browser/protocol-cell.ts (or add an explicit ` +
      `reason to NOT_MIRRORED here).`,
  );
  reset();
});

Deno.test("browser cell stub: ui filter survives into __aio (client-read tripwire)", () => {
  reset();
  // deno-lint-ignore no-explicit-any
  const sDef = serverCell("parity-ui-s", makeConfig() as any);
  // deno-lint-ignore no-explicit-any
  const bDef = browserCell("parity-ui-b", makeConfig() as any);
  assertEquals(
    (bDef.__aio as Record<string, unknown>).ui,
    // deno-lint-ignore no-explicit-any
    (sDef.__aio as any).ui,
    "the ui field filter must normalize identically in both factories — " +
      "bindCellReactive enforces client visibility from it",
  );
  reset();
});

Deno.test("browser cell stub: a ui-hidden field read is LOUD in the browser too", () => {
  reset();
  const dev = (globalThis as Record<string, unknown>).__aioDev;
  (globalThis as Record<string, unknown>).__aioDev = true;
  try {
    // deno-lint-ignore no-explicit-any
    const bDef = browserCell("parity-hidden", makeConfig() as any);
    // deno-lint-ignore no-explicit-any
    bindCellReactive(bDef as any);
    getCellSignal("parity-hidden", { n: 1, note: "hi" }).set({
      n: 1,
      note: "hi",
    });
    let threw = "";
    try {
      void (bDef as Record<string, unknown>).secret;
    } catch (e) {
      threw = (e as Error).message;
    }
    assert(
      threw.includes("parity-hidden.secret"),
      `reading a ui-excluded field from client context must fail loud in dev ` +
        `in the BROWSER build exactly as it does in standalone/testUI — got ` +
        `${threw === "" ? "a silent undefined" : threw}`,
    );
  } finally {
    (globalThis as Record<string, unknown>).__aioDev = dev;
    reset();
  }
});

Deno.test("browser cell stub: a `visible:`-declared exclude is enforced client-side too", () => {
  // alpha52 renamed `ui:` → `visible:`. The stub must route BOTH spellings
  // through resolveVisibility — the same decider the server factory uses —
  // or a `visible:` cell would lose its hidden-read guard only in the shipped
  // browser bundle.
  reset();
  const dev = (globalThis as Record<string, unknown>).__aioDev;
  (globalThis as Record<string, unknown>).__aioDev = true;
  try {
    const cfg = { ...makeConfig() } as Record<string, unknown>;
    delete cfg.ui;
    cfg.visible = { exclude: ["secret"] };
    // deno-lint-ignore no-explicit-any
    const sDef = serverCell("parity-visible-s", cfg as any);
    // deno-lint-ignore no-explicit-any
    const bDef = browserCell("parity-visible", cfg as any);
    assertEquals(
      (bDef.__aio as Record<string, unknown>).ui,
      // deno-lint-ignore no-explicit-any
      (sDef.__aio as any).ui,
      "`visible:` must normalize into __aio.ui identically in both factories",
    );
    // deno-lint-ignore no-explicit-any
    bindCellReactive(bDef as any);
    getCellSignal("parity-visible", { n: 1, note: "hi" }).set({
      n: 1,
      note: "hi",
    });
    let threw = "";
    try {
      void (bDef as Record<string, unknown>).secret;
    } catch (e) {
      threw = (e as Error).message;
    }
    assert(
      threw.includes("parity-visible.secret"),
      `a \`visible:\`-excluded field must fail loud on client read in the ` +
        `BROWSER build — got ${threw === "" ? "a silent undefined" : threw}`,
    );
  } finally {
    (globalThis as Record<string, unknown>).__aioDev = dev;
    reset();
  }
});

Deno.test("browser cell stub: deps-form selectors are callable (server parity)", () => {
  reset();
  // deno-lint-ignore no-explicit-any
  const dep = browserCell(
    "parity-dep",
    { state: { rate: 2 }, methods: {} } as any,
  );
  // deno-lint-ignore no-explicit-any
  const bDef = browserCell("parity-sel", makeConfig() as any);
  // deno-lint-ignore no-explicit-any
  bindCellReactive(dep as any);
  // deno-lint-ignore no-explicit-any
  bindCellReactive(bDef as any);
  getCellSignal("parity-dep", { rate: 2 }).set({ rate: 2 });
  getCellSignal("parity-sel", { n: 21, note: "hi" }).set({ n: 21, note: "hi" });

  const b = bDef as unknown as Record<string, (() => unknown) | undefined>;
  assertEquals(b.plain!(), 22, "plain selector");
  // The deps form is an OBJECT ({deps, fn}); the server normalizes it into a
  // callable via scopeSelectors. The stub used to store it raw, so the browser
  // called an object: `selectorFn is not a function`, in production only.
  assertEquals(
    b.withDeps!(),
    42,
    "deps-form selector must be normalized to a callable in the browser too",
  );
  reset();
});
