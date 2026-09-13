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
  uiNames:
    "reads an ALREADY-BOOTED TestUI handle and returns its element paths — " +
    "the harness that armed is the testUI that produced the handle",
  uiRects:
    "same shape as uiNames: it measures an ALREADY-BOOTED TestUI handle and " +
    "returns geometry. The testUI that produced the handle did the arming",
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

// ── …and arming is only HALF of "strictest environment" ──────────────────
//
// `_armTestStrict()` turns on the dev tripwires. `_refuseUnsafeCells()` is the
// other half: the boot refusals a real `aio.run()` performs before it serves
// anything, both of which exist for security — a field the UI can see that
// looks like a credential, and a `sync: true` cell that hides state from the
// clients it replays on.
//
// `bootCells` and `testUI` called it. `testCell` — the harness CLAUDE.md names
// first, and the one the docs push hardest ("always dispatch-test cell
// methods") — did not, so a cell the app REFUSES TO START WITH passed its
// whole test file. `boot-refusals.ts`'s own header describes that bug being
// fixed; it was fixed in two harnesses of three.
//
// Behavioural, like the arming gate above: a cell that must be refused is fed
// to each harness and the refusal has to arrive.
const G2 = globalThis as Record<string, unknown>;

/** A cell every boot refusal must reject: an `apiKey` the UI can read. */
async function leakyCell() {
  const { cell } = await import("../src/state/cell-create.ts");
  return cell(`leaky_${Math.random().toString(36).slice(2, 8)}`, {
    state: { apiKey: "sk-live-secret", n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
}

/** Did `fn` refuse, and did it say SECURITY? */
async function refuses(fn: () => unknown): Promise<string> {
  try {
    await Promise.resolve(fn());
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

Deno.test("bootCells refuses a cell aio.run() would refuse", async () => {
  const { bootCells } = await import("../src/cell-test.ts") as Record<
    string,
    // deno-lint-ignore no-explicit-any
    any
  >;
  const c = await leakyCell();
  const msg = await refuses(() => bootCells([c]));
  assert(
    msg.includes("SECURITY"),
    `bootCells accepted it: ${msg || "(no throw)"}`,
  );
});

Deno.test("testCell refuses a cell aio.run() would refuse", async () => {
  // `testCell` declares its own `Deno.test`, so the refusal surfaces when THAT
  // test runs, not at declaration time. Drive the refusal directly instead —
  // the same call `testCell` now makes, on the same input.
  const { _refuseUnsafeCells } = await import(
    "../src/testing/boot-refusals.ts"
  );
  const c = await leakyCell();
  const msg = await refuses(() => _refuseUnsafeCells([c]));
  assert(
    msg.includes("SECURITY"),
    `the refusal did not fire: ${msg || "(none)"}`,
  );

  // …and that `testCell` really calls it, on the path a test takes.
  const src = await Deno.readTextFile(
    new URL("../src/testing/cell-test.ts", import.meta.url).pathname,
  );
  const body = src.slice(src.indexOf("export function testCell("));
  assert(
    body.slice(0, body.indexOf("const composed = composeCells([f])"))
      .includes("_refuseUnsafeCells([f])"),
    "testCell must run the boot refusals BEFORE it composes the cell",
  );
  void G2;
});
