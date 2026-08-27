// test-strict.ts — the shared harness-STRICTNESS primitives that are safe in a
// BROWSER bundle: dev-strict mode, the app-directory sandbox, and the
// unobserved-call-failure ledger.
//
// The browser part is load-bearing, not incidental: `aio/renderer`
// (src/browser-air.ts) re-exports `testComponent`, which imports this file, so
// everything reachable from here rides in every app's browser bundle. A single
// static import of a server module from here made the bundler refuse EVERY
// browser build ("server-only module(s) statically imported") — which is why
// the boot refusals, which need `parseCli`/`isCompiled`, live in
// `boot-refusals.ts` instead: only `cell-test.ts` and `ui-test.ts` reach that,
// and neither is in the browser graph. (`check:boundaries` cannot see this —
// root files like `browser-air.ts` have unrestricted reach — so the rule is
// kept here, in words, beside the import list it constrains.)
//
// It lives in its own module because every harness needs it and the harnesses
// import each other: it used to sit in `cell-test.ts`, so `testComponent`,
// `testServer` and `testMultiClient` could not call it without an import cycle
// — and they didn't. Three of the five harnesses therefore ran with `__aioDev`
// unset, which turned off frozen-state enforcement, the readonly hint and the
// hidden-field read guard for every test written with them: a component that
// illegally mutated committed state passed `testComponent` and threw in
// `testUI`, `testCell` and production.
//
// Doctrine, verbatim: "Tests are the STRICTEST environment, never the most
// permissive." One import, one call, at the top of every harness — and
// everything else here exists for the same reason: three in-process harnesses
// must not each grow their own, weaker, answer to the same question.

import type { CellDef } from "../state/cell-types.ts";
import { attachMeta } from "../state/cell-catalog.ts";

/** Arm dev-strict checks for a test harness.
 *
 *  The runtime freezes committed state in dev AND prod so an illegal in-place
 *  mutation throws at the site; a harness that leaves `__aioDev` unset makes
 *  the same mutation silently succeed, so a green test means less than
 *  production does. Idempotent; a test that specifically needs prod-lenient
 *  behaviour can set the flag false itself.
 *  @internal */
export function _armTestStrict(): void {
  (globalThis as Record<string, unknown>).__aioDev = true;
  _sandboxAppDirs();
}

// A harness must not be able to write into the user's home — not by design, and
// not by accident. App code legitimately asks `appDirs(appId)` where its files
// live (`<data>/files`, `<data>/tls`, …), and under a test that resolved to the
// developer's REAL `~/.<appId>`: one field report's server tests installed a
// fixture binary into the real install for the whole project, and the pollution
// then HID a second bug by making two tests pass against an artefact that only
// existed on that machine ("not a footgun — a loaded gun pointed at data the
// developer cares about").
//
// So the first harness use of the process pins every app directory into a temp
// sandbox, unless the runner already pinned one (aio's own suite does, in its
// `deno test` task). An explicit `registerAppDirs()` still wins per app — that is
// the escape hatch for a test that wants a specific fixture directory.
let _sandboxed = false;
function _sandboxAppDirs(): void {
  if (_sandboxed) return;
  _sandboxed = true;
  try {
    if (Deno.env.get("AIO_APPS_DIR")) return; // runner already pinned it
    const dir = Deno.makeTempDirSync({ prefix: "aio-test-apps-" });
    Deno.env.set("AIO_APPS_DIR", dir);
    globalThis.addEventListener("unload", () => {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch {
        // aio-ok: process-exit cleanup of a directory this function created
        // and nothing else refers to. The two ways it fails are "already
        // gone" (the outcome we want) and "the OS will reap it" — neither is
        // something a test author can act on, and a line here would print on
        // every run that ends with a still-open handle.
      }
    });
  } catch (e) {
    // NOT silent. The sandbox is the only thing standing between a test and
    // the developer's REAL `~/.<appId>`: without it `appDirs(appId)` resolves
    // to live application data, and one field report's server tests installed
    // a fixture binary into the real install for the whole project — then hid
    // a second bug by making two tests pass against an artefact that existed
    // only on that machine.
    //
    // A harness that fails to install that guard and says nothing is the exact
    // shape this project refuses: the tests still run, they just run pointed
    // at data someone cares about. It cannot THROW (a suite deliberately run
    // without --allow-env/--allow-write would stop working, and the guard is
    // protective rather than load-bearing for correctness), so it is loud
    // instead — once, naming the fix.
    console.warn(
      `[aio:testing] could not sandbox app directories (${
        e instanceof Error ? e.message : e
      }). appDirs() will resolve to the REAL per-user directories for the ` +
        `rest of this run, so a test that writes app data writes it to your ` +
        `home. Fix: run the suite with --allow-env --allow-write, or pin ` +
        `AIO_APPS_DIR=<tmp> yourself.`,
    );
  }
}

// ── Unobserved async-method failures ────────────────────────────────────
//
// `testCell` keeps a ledger: an async method that rejected with NOBODY looking
// surfaces at the next `settle()`, because a harness reporting success for the
// exact case it exists to catch is worse than no harness. `testUI` and
// `bootCells` did the opposite — `Promise.allSettled` over the pending calls,
// which swallows every rejection — so the ordinary `onClick={() => todo.add()}`
// shape passed one harness and failed the other with the SAME app code.
//
// Production is the tie-breaker and it agrees with `testCell`: the runtime
// logs the failure and dispatches `cell:__error`. It does not pretend the call
// succeeded. So the ledger moves here and both harnesses use it.
//
// "Observed" is decided the way the language decides it: attaching a handler
// (`await`, `.then`, `.catch`, `.finally`, `Promise.all`) counts as looking.
// The wrapper below is the same thenable `testCell`'s `send` returns.

/** One recorded failure and whether the caller ever looked at it. */
type LedgerEntry = { err: unknown; method: string; seen: () => boolean };

/** A ledger installed over a booted cell set. */
export type CallFailureLedger = {
  /** Throw the first failure nobody observed, then forget every entry
   *  (delivered or reported — either way, done with them). */
  raise(): void;
  /** Put the cells' own bound method functions back. */
  restore(): void;
};

/** Wrap every bound ASYNC method on `cells` so a rejection nobody looked at is
 *  recorded instead of swallowed. Call AFTER the cells are bound (i.e. after
 *  the runtime booted them); `restore()` on teardown.
 *
 *  Sync methods are deliberately not wrapped — `testCell` does not ledger them
 *  either (a sync reducer throw rejects the caller's promise at the call site),
 *  and the two harnesses must agree.
 *  @internal */
export function _watchUnobservedCalls(
  cells: readonly CellDef[],
): CallFailureLedger {
  const entries: LedgerEntry[] = [];
  const undo: (() => void)[] = [];
  for (const def of cells) {
    const asyncMethods = def.__aio?.asyncMethods;
    if (!asyncMethods || asyncMethods.size === 0) continue;
    for (const key of def.__aio.actionKeys ?? []) {
      if (!asyncMethods.has(key)) continue;
      const holder = def as unknown as Record<string, unknown>;
      const original = holder[key];
      if (typeof original !== "function") continue;
      const call = original as (...args: unknown[]) => unknown;
      const method = `${def.__aio.id}.${key}()`;
      const wrapped = (...args: unknown[]): unknown => {
        const started = call.apply(def, args);
        if (!isThenable(started)) return started;
        const p = started as Promise<unknown>;
        let observed = false;
        // Recording (not re-throwing) also marks the rejection handled, so an
        // un-awaited failing call cannot escape as an unhandled rejection and
        // kill the test process — exactly what the runtime's own no-op catch
        // does today, minus the amnesia.
        p.catch((err) => entries.push({ err, method, seen: () => observed }));
        const mark = <T>(v: T): T => (observed = true, v);
        return {
          then: (onF: unknown, onR: unknown) =>
            mark(p).then(
              onF as never,
              onR as never,
            ),
          catch: (onR: unknown) => mark(p).catch(onR as never),
          finally: (onC: unknown) => mark(p).finally(onC as never),
          [Symbol.toStringTag]: "Promise",
        };
      };
      const creator = (def.__aio.actions as Record<string, unknown>)[key];
      if (creator) attachMeta(wrapped, creator);
      holder[key] = wrapped;
      undo.push(() => {
        // Only if nothing rebound it since — a later boot owns its own binding.
        if (holder[key] === wrapped) holder[key] = original;
      });
    }
  }
  return {
    raise() {
      const first = entries.find((e) => !e.seen());
      entries.length = 0;
      if (!first) return;
      const err = first.err;
      const detail = err instanceof Error ? err.message : String(err);
      const named = new Error(
        `${first.method} failed and nothing awaited it — ${detail}\n` +
          `  cause: the call was made fire-and-forget (the ordinary ` +
          `\`onClick={() => cell.method()}\` shape), so its rejection reached ` +
          `no caller. Production logs it and dispatches \`__error\`; this ` +
          `harness surfaces it rather than reporting success.\n` +
          `  fix: await the call (or assert on it — \`await assertRejects(() => ` +
          `cell.method())\`) if the failure is expected; otherwise fix the ` +
          `method.`,
      );
      if (err instanceof Error) named.cause = err;
      throw named;
    },
    restore() {
      for (const fn of undo.splice(0)) fn();
      entries.length = 0;
    },
  };
}

function isThenable(v: unknown): boolean {
  return !!v && (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function";
}
