// Every in-process test harness must put the runtime into DEV-STRICT mode.
//
// CLAUDE.md, verbatim: "Tests are the STRICTEST environment, never the most
// permissive." `_armTestStrict()` is how a harness honours that — it sets
// `__aioDev`, which turns on frozen-state enforcement, the readonly hint and
// the hidden-field read guard.
//
// This has already failed once, exactly as you would expect a hand-maintained
// invariant to: `_armTestStrict` used to live in `cell-test.ts`, the harnesses
// import each other, and an import cycle meant THREE OF FIVE harnesses never
// called it. Tests written with those three ran more permissively than
// production, so a component that illegally mutated committed state passed
// `testComponent` and threw everywhere else.
//
// The fix at the time was to move the function and add the call to each
// harness — which is the same hand-maintained invariant, one layer along. This
// file is the gate: it proves each harness ARMS (behaviourally — by watching
// the flag, not by grepping source), and it fails when a NEW harness appears
// that nobody has classified.
import { assert, assertEquals } from "@std/assert";

const G = globalThis as Record<string, unknown>;

/** Run `fn` with `__aioDev` cleared, then report whether it got set. */
async function armsDevStrict(fn: () => unknown): Promise<boolean> {
  const prev = G.__aioDev;
  delete G.__aioDev;
  try {
    // Arming is the FIRST thing a harness does, so we do not care whether the
    // call then fails on deliberately-invalid arguments — only whether the
    // flag was set on the way in. That keeps this gate cheap: no server boots,
    // no browser launches.
    // A synchronous throw must be caught HERE — `Promise.resolve(fn())` never
    // sees it, and an escaping error would make this gate look like a harness
    // failure when it is only invalid-argument noise.
    try {
      await Promise.resolve(fn()).catch(() => {});
    } catch { /* invalid args — the flag is what we are measuring */ }
    return G.__aioDev === true;
  } finally {
    G.__aioDev = prev;
  }
}

/** The public surface of `aio/testing`, classified.
 *
 *  Anything harness-shaped (it runs app code in THIS process) must arm.
 *  Anything exempt says why. A new export lands in neither bucket and the
 *  structural test below fails — which is the point: the next person to add a
 *  harness has to make this decision consciously. */
const EXEMPT: Record<string, string> = {
  _armTestStrict: "is the arming function itself",
  freePort: "pure helper — allocates a port, runs no app code",
  findChromium: "pure helper — locates a binary",
  setDocument: "pure helper — swaps the document reference",
  testGen: "codegen — emits types, never boots an app",
  generateUITypes: "codegen — emits types, never boots an app",
  ensureAppDirs: "path resolution, no app code",
  registerAppDirs: "path resolution, no app code",
  _resetAppDirs: "path resolution, no app code",
  createCassette: "transport recording, no app code",
  openCassette: "transport recording, no app code",
  totpCode: "pure code generator (HMAC over a secret) — runs no app code",
  testBrowser:
    "launches an EXTERNAL browser process against a URL and owns only that " +
    "process; the app under test boots in its own server (via testServer, " +
    "which arms). Nothing app-side runs in this isolate, and it makes its own " +
    "temp profile dir rather than resolving appDirs.",
};

/** Harnesses that run app code in this process — each must arm. */
const MUST_ARM = [
  "testCell",
  "bootCells",
  "testUI",
  "testComponent",
  "testServer",
  "testMultiClient",
  // Boots a real server (via testServer) and fetches every eager module.
  "smoke",
  // Boots N real apps in this process — same exposure as testServer, N times.
  "testApps",
] as const;

Deno.test("every in-process harness arms dev-strict", async () => {
  const mod = await import("../src/cell-test.ts") as Record<string, unknown>;
  const failures: string[] = [];
  for (const name of MUST_ARM) {
    const fn = mod[name];
    assertEquals(
      typeof fn,
      "function",
      `${name} must still be exported from aio/testing`,
    );
    // Deliberately invalid arguments: we are measuring the flag, not the call.
    const armed = await armsDevStrict(() =>
      (fn as (...a: unknown[]) => unknown)(undefined, undefined, undefined)
    );
    if (!armed) failures.push(name);
  }
  assertEquals(
    failures,
    [],
    `these harnesses did not set __aioDev, so tests written with them run ` +
      `MORE PERMISSIVELY than production — frozen-state enforcement, the ` +
      `readonly hint and the hidden-field read guard are all off. This exact ` +
      `regression already shipped once for three of five harnesses.`,
  );
});

Deno.test("a new harness export cannot skip the decision", async () => {
  const mod = await import("../src/cell-test.ts") as Record<string, unknown>;
  const exported = Object.keys(mod).filter((k) => typeof mod[k] === "function");
  const classified = new Set<string>([...MUST_ARM, ...Object.keys(EXEMPT)]);
  const unclassified = exported.filter((k) => !classified.has(k));
  assertEquals(
    unclassified,
    [],
    `aio/testing exports these functions and this gate does not know what ` +
      `they are. Add each to MUST_ARM (it runs app code in this process, so ` +
      `it must call _armTestStrict) or to EXEMPT with the reason it does not. ` +
      `Leaving the choice implicit is how three harnesses silently stopped ` +
      `arming last time.`,
  );
});

Deno.test("arming actually enables the strict behaviour it promises", async () => {
  // The flag is a proxy for a behaviour, so pin the behaviour too — otherwise
  // this whole file could pass while `__aioDev` meant nothing.
  const { bootCells } = await import("../src/cell-test.ts") as unknown as {
    bootCells: (cells: unknown[]) => Promise<{ dispose(): void }>;
  };
  const { cell } = await import("../mod.ts");
  const c = cell(`strict-${crypto.randomUUID().slice(0, 8)}`, {
    state: { items: [] as string[] },
    methods: {
      grab(s: { items: string[] }) {
        return s.items; // hand the committed array out
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);

  const app = await bootCells([c]);
  try {
    // Committed state is frozen in dev AND prod, so mutating it must throw at
    // the site rather than silently succeed. A harness that left __aioDev unset
    // is how this stopped throwing under `testComponent`.
    // deno-lint-ignore no-explicit-any
    const arr = (c as any).grab() as string[];
    let threw = false;
    try {
      arr.push("illegal");
    } catch {
      threw = true;
    }
    assert(
      threw || Object.isFrozen(arr),
      "committed state handed out of a method must be frozen — if it is not, " +
        "dev-strict is not actually in force and every test is weaker than prod",
    );
  } finally {
    app.dispose();
  }
});
