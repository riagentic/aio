// testUI's wire emulation — the server-origin scope, cell-access
// enforcement, and sending args/results/rejections through the real wire
// encoding so a value that cannot cross the wire fails in the test as it
// would in the browser. Split out of ui-test.ts; internal to it — nothing
// here was ever exported.

import { withRefusalCode } from "../state/method-rejection.ts";
import type { CallFailureLedger } from "./test-strict.ts";
import { _callAcrossWorkerBoundary } from "./boot-refusals.ts";
import type { AioUser } from "../protocol/protocol-types.ts";
import type { CellDef } from "../state/cell-types.ts";
import { cellAccessAllowed } from "../server/server-auth.ts";
import {
  _installServerOriginScope,
  isServerOrigin,
} from "../state/call-origin.ts";
import type { ServerOriginScope } from "../state/call-origin.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAioError } from "../diagnostics/error.ts";
import {
  actionWireTrip,
  encodeAction,
  wireLossCounts,
} from "../state/action-encode.ts";
import { serializeReturn } from "../protocol/return-value.ts";
import { findLossy, wireArgs } from "../protocol/wire-value.ts";
import type { LossyConversion } from "../protocol/wire-value.ts";
import { errorFields, wireError } from "../protocol/envelope.ts";
import { setSyncHandler } from "../state/state-transport.ts";
import { sfnArgsDropped, sfnError } from "../browser/server-fns-client.ts";
import {
  _useServerFnClientDoor,
  invokeServerFn,
} from "../server/server-fns.ts";
import { runWithUser } from "../server/auth-context.ts";
import { isDomEvent } from "../state/event-arg.ts";
import { _eventArgHint } from "../state/cell-methods-internals.ts";
import type { TestUIOptions } from "./ui-test.ts";
import { _handleForm, _reshaped, _strict } from "./ui-test-build.ts";

/**
 * Mount an AIR app and drive it through its semantic surface — first-class UI
 * testing without DOM/selector lookup. Every TSX component becomes a readable,
 * deterministic API; every interaction is a real event sequence; every action
 * awaits quiescence, so tests have zero sleeps and zero flake.
 *
 * Zero boilerplate — the DOM is created for you, the cells your App imports
 * boot automatically, and the wrapper form cleans everything up:
 *
 * ```ts
 * import { testUI } from "aio/testing";
 * import App from "../src/App.tsx";
 *
 * testUI(App, "add a todo", async (ui) => {
 *   await ui.TodoAdd.TitleInput.type("buy milk");
 *   await ui.TodoAdd.AddButton.click();
 *   await ui.expectCell(todo, (t) => t.items.length === 1);
 * });
 * ```
 *
 * Handle form (compose your own test): `await using ui = await testUI(App);`
 * — disposed at scope end. Options only when you need control:
 * `{ document, cells, persist, settleIterations }`.
 */
/** The server-origin scope, backed by `AsyncLocalStorage` — a scope that has
 *  to survive `await` (a method calling a sibling after one is still the
 *  server calling itself), which is exactly what a counter cannot do and ALS
 *  does. Built here, in the server-side harness, because `src/state` is in the
 *  browser bundle and cannot import `node:async_hooks`. */
const _originAls = new AsyncLocalStorage<true>();
const _originScope: ServerOriginScope = {
  run: <T>(fn: () => T): T => _originAls.run(true, fn),
  active: () => _originAls.getStore() === true,
  // The door back out, for the framework's deferred work on the CLIENT's
  // behalf — the renderer's batched flush above all. `exit` leaves the store
  // behind for everything `fn` starts, which a synchronous flag could not do:
  // the flush only QUEUES the re-render, and the queued microtask is what
  // must not inherit the marker.
  exit: <T>(fn: () => T): T => _originAls.exit(fn),
};
/** How many live gates need the scope. ONE scope object for the process and a
 *  count, not an install per gate: two overlapping `testUI`s each register
 *  their undo, and a plain "restore to null" from the first would strip the
 *  marker out from under the second — every cell→cell call in it refused, at a
 *  distance, in whichever test happened to finish first. */
let _originUsers = 0;

export function _useServerOriginScope(): () => void {
  if (_originUsers++ === 0) _installServerOriginScope(_originScope);
  let released = false;
  return () => {
    if (released) return; // a restore stack may run twice; the count may not
    released = true;
    if (--_originUsers === 0) _installServerOriginScope(null);
  };
}

/** Apply each cell's declarative `access` rule to its bound methods, the way
 *  `dispatchNetwork` does for a real client. Returns a restore function.
 *
 *  `testUI` boots on the standalone runtime, which has no network and so never
 *  passed through the server's gate: a `customer` clicking an admin-only
 *  Delete deleted the product under the harness while the identical click over
 *  a real socket answered `ACCESS_DENIED`. A harness more permissive than
 *  production manufactures green-test-broken-prod, and doing it about
 *  AUTHORIZATION is the worst possible subject for it.
 *
 *  The rule is read off the cell def — the same `__aio.access` the server
 *  bridge collects into `config._cellAccess` — so there is no second copy of
 *  "what this cell allows", and the verdict comes from `cellAccessAllowed`,
 *  the same one decider serverFns and the WS door use. */
export function _enforceCellAccess(
  cells: CellDef[],
  viewer: () => AioUser | undefined,
): () => void {
  const undo: (() => void)[] = [];
  // The gate applies to CLIENT callers. A cell→cell call is not one: over a
  // real socket it never reaches `dispatchNetwork`, so `access: () => false` —
  // the natural rule for a cell only other cells call, and the case the
  // feature is most obviously for — must seal the cell against the UI and
  // leave the app's own code alone. Here both arrive at the same bound
  // method, so the origin is MARKED by the call path rather than guessed: the
  // framework runs every method body inside `inServerOrigin`, and that scope
  // is ambient runtime state, never a field on a frame — there is nothing for
  // a client to forge (tests/access-server-origin.test.tsx pins both halves).
  undo.push(_useServerOriginScope());
  for (const def of cells) {
    const rule = def.__aio?.access;
    if (rule === undefined) continue;
    const cellId = def.__aio.id;
    const target = def as unknown as Record<string, unknown>;
    for (const key of def.__aio.actionKeys ?? []) {
      if (key.startsWith("__")) continue;
      const bound = target[key];
      if (typeof bound !== "function") continue;
      const original = bound as (...a: unknown[]) => unknown;
      target[key] = (...args: unknown[]) => {
        const user = viewer();
        if (!isServerOrigin() && !cellAccessAllowed(rule, user, key, args)) {
          const denial = Promise.reject(
            createAioError(
              "ACCESS_DENIED",
              `cell "${cellId}.${key}" — access denied for ${
                user ? `user=${user.id} role=${user.role}` : "an anonymous UI"
              }. This is the same rule the server applies to a real client; ` +
                `pass { user } to testUI, or { enforceAccess: false } to ` +
                `drive the method deliberately.`,
              { cellName: cellId, actionType: `${cellId}:${key}` },
            ),
          );
          // Pre-caught, exactly as the server does for the same refusal
          // (`aio-server.ts`): an `onClick={() => cell.method()}` is
          // fire-and-forget, and a denial must not become an unhandled
          // rejection that kills the test module. A caller that DOES await it
          // still gets the rejection.
          denial.catch(() => {
            // aio-ok: pre-catching the refusal is the point — a caller that
            // awaits still gets it; nobody else needs to.
          });
          return denial;
        }
        return original(...args);
      };
      undo.push(() => {
        target[key] = original;
      });
    }
  }
  return () => {
    for (const f of undo) f();
  };
}

/** What to send instead, by what was passed. */
const _WIRE_FIX: Record<string, string> = {
  Date: "send date.toISOString() (or .getTime()) and rebuild it in the method",
  Map: "send [...map] (entries) or Object.fromEntries(map)",
  Set: "send [...set]",
  undefined: "send null, or leave the argument out — it arrives as null, " +
    "and a default parameter does not apply to null",
  NaN: "send null or a string — JSON has no NaN",
  Infinity: "send null or a string — JSON has no Infinity",
  "-Infinity": "send null or a string — JSON has no Infinity",
  "-0": "send 0",
  function: "send data, not a function",
  symbol: "send a string",
};

/** Does this mount put rejections, `serverFn` and `useAio().send` across the
 *  wire (`TestUIOptions.wire.strict`)? The option decides; unset, the run's
 *  `AIO_TEST_WIRE=strict` does; neither, no — what 1.0.19's harness did. */
export function _wireStrict(opts: Pick<TestUIOptions, "wire">): boolean {
  return opts.wire?.strict ?? Deno.env.get("AIO_TEST_WIRE") === "strict";
}

/** What a non-strict run has been told, by kind: one line each, per process.
 *  Observe-only — nothing here fails a test. */
const _wireSaid = new Set<string>();
function _sayWireOnce(
  kind: string,
  what: string,
  then = `pass testUI(App, { wire: { strict: true } }), or run with ` +
    `AIO_TEST_WIRE=strict, to test what a client gets`,
): void {
  if (_wireSaid.has(kind)) return;
  _wireSaid.add(kind);
  // Straight to stderr, not `console.warn`: a test that counts console
  // calls must not go red over a note about the harness.
  Deno.stderr.writeSync(new TextEncoder().encode(
    `[aio] testUI: ${what} — ${then} ` +
      `(docs/testing/ui-testing.md, "Calls cross the wire"). Said once per ` +
      `run.\n`,
  ));
}

/** Give this mount the page's `__aioConfig.wire` — the SAME global a real
 *  page reads (`protocol/wire-value.ts`), so the harness has no second copy
 *  of the decision. Returns the undo. */
export function _useWireConfig(
  { strict: _harnessOnly, ...wire }: NonNullable<TestUIOptions["wire"]>,
): () => void {
  const g = globalThis as { __aioConfig?: Record<string, unknown> };
  const had = g.__aioConfig;
  g.__aioConfig = { ...had, wire };
  return () => {
    if (had === undefined) delete g.__aioConfig;
    else g.__aioConfig = had;
  };
}

/** A client call's arguments as the server decodes them — or the test's
 *  failure, when they do not arrive intact. `actionWireTrip` is the decider:
 *  production's encode, production's decode, and the walk behind the
 *  "JSON cannot carry intact" console warning. */
function _argsOverWire(
  cellId: string,
  key: string,
  args: unknown[],
): unknown[] {
  const type = `${cellId}:${key}`;
  const lost: LossyConversion[] = [];
  // A DOM Event: `onClick={counter.inc}` passes one to a method that declares
  // no parameter for it. A browser sends `{"isTrusted":true}` and nothing
  // reads it, so that is what crosses here. One landing in a DECLARED
  // parameter is a method that gets `{"isTrusted":true}` in the app.
  const hint = _eventArgHint(cellId, key, args);
  if (hint) {
    const at = args.findIndex(isDomEvent);
    lost.push({
      path: `args[${at}]`,
      from: (args[at] as object).constructor?.name || "Event",
      to: "object",
    });
  }
  const trip = actionWireTrip({
    type,
    payload: { args: args.map((a) => isDomEvent(a) ? { isTrusted: true } : a) },
  });
  for (const l of trip.lossy) {
    // `{ text, due: undefined }` → `{ text }` is not a failure: the table in
    // action-encode.ts decides, for this and for both console warnings.
    if (!wireLossCounts(l, "harness")) continue;
    lost.push({ ...l, path: l.path.slice(type.length + 1) });
  }
  if (lost.length === 0) return (trip.payload as { args: unknown[] }).args;
  throw _wireLossError(`${cellId}.${key}()`, lost, hint);
}

/** The test's failure for a client call whose arguments JSON changes. */
function _wireLossError(
  what: string,
  lost: LossyConversion[],
  hint?: string | null,
): Error {
  return withRefusalCode(
    new Error(
      `testUI: ${what} was called from the UI with arguments JSON ` +
        `cannot carry intact — over the real socket the server receives ` +
        `DIFFERENT values than the caller passed:\n` +
        lost.map((l) =>
          `  ${l.path}: ${l.from} → ${l.to} — ${
            _WIRE_FIX[l.from] ??
              "send a plain object / array of JSON values"
          }`
        ).join("\n") +
        (hint ? `\n  ${hint}` : "") +
        `\n  cause: a client's call is JSON on the wire. In the app this call ` +
        `IS sent, changed, and a console warning is all that says so; passing ` +
        `the original here would be a green test over that, so the call was ` +
        `not dispatched.\n` +
        `  fix: change the CALLER (the component or handler) to pass JSON-safe ` +
        `data. Server code calling the method (another cell, an effect, ` +
        `onInit) crosses no wire and is not checked — to test the method with ` +
        `a rich value, call it with testCell / bootCells ` +
        `(docs/testing/ui-testing.md, "Calls cross the wire").`,
    ),
    "NON_JSON_ARGS",
  );
}

/** One call across the wire a real client's call crosses: arguments are
 *  encoded and decoded as an action frame, and the return value is vetted as
 *  the ack carries it (`serializeReturn`, which also says what changed).
 *
 *  Without it the component's `cell.open(new Date())` handed the method the
 *  Date itself, while a browser hands the server a string — a green test over
 *  a call the app gets wrong, and the only other witness was a console line.
 *
 *  CLIENT calls only, decided as `access` decides it (`isServerOrigin`): a
 *  method body, an effect or an `onInit` calling another cell crosses no wire
 *  in the app and none here. */
function _overClientWire(
  cellId: string,
  key: string,
  args: unknown[],
  run: (args: unknown[]) => unknown,
): unknown {
  if (isServerOrigin()) return run(args);
  let sent: unknown[];
  try {
    sent = _argsOverWire(cellId, key, args);
  } catch (e) {
    const refused = Promise.reject(e);
    // Pre-caught, as the access gate's denial is: a fire-and-forget `onClick`
    // must reach the ledger, not kill the test module.
    refused.catch(() => {
      // aio-ok: a caller that awaits still gets it; the ledger wrapped around
      // this reports the one nobody awaited.
    });
    return refused;
  }
  const out = run(sent);
  return out !== null && typeof (out as { then?: unknown })?.then === "function"
    ? (out as Promise<unknown>).then(
      (v) => serializeReturn(v, `${cellId}:${key}`).value,
      (e) => {
        throw _rejectionOverWire(`${cellId}.${key}()`, e);
      },
    )
    : out;
}

/** A failed call as its CLIENT is rejected with it: the two fields a failed
 *  ack carries (`errorFields`, every door's writer), read back by the
 *  browser's reader (`wireError`). In process the caller got the server's own
 *  object — its class, its `cause`, its properties, its stack — and a test
 *  checking any of those was green over a call the app answers with a plain
 *  `Error` (tests/wire-harness-differential.test.tsx compares the two over a
 *  real socket). */
function _rejectionOverWire(what: string, e: unknown): unknown {
  const fields = errorFields(e);
  const lost = e instanceof Error
    ? [
      e.constructor !== Error ? `class ${e.constructor?.name || "?"}` : "",
      e.cause !== undefined ? ".cause" : "",
      ...Object.keys(e).filter((k) =>
        !(k === "code" && fields.code !== undefined) && k !== "name"
      ).map((k) => `.${k}`),
    ].filter(Boolean)
    : [`a thrown ${e === null ? "null" : typeof e} (it arrives as an Error)`];
  if (!_strict) {
    // What 1.0.19's harness did: the caller gets the server's own object.
    if (lost.length > 0) {
      _sayWireOnce(
        "rejection",
        `${what} rejected, and this test's caller got the server's own ` +
          `error object. Over a real connection the rejection is a plain ` +
          `Error with the server's message and its \`code\` (not carried ` +
          `here: ${lost.join(", ")})`,
      );
    }
    return e;
  }
  if (lost.length > 0) {
    _reshaped.push(`${what} — ${lost.join(", ")}`);
    if (_reshaped.length > 8) _reshaped.shift();
    if (_handleForm) {
      _sayWireOnce(
        "reshaped",
        `${what} rejected, and its caller received what a real client ` +
          `receives: a plain Error with the server's message and its ` +
          `\`code\` (not carried: ${lost.join(", ")})`,
        `a check on the error's class (instanceof), \`cause\`, a property ` +
          `or its stack fails in the app the same way: branch on ` +
          `errorCode(e) or the message, or test the method on the server's ` +
          `side with testCell / bootCells, where no wire is crossed`,
      );
    }
  }
  return wireError(
    JSON.parse(JSON.stringify(fields)) as typeof fields,
    "server rejected action",
  );
}

/** The line a failing test body gets when a rejection lost something on the
 *  way to it; "" when none did. */
export function _reshapedNote(): string {
  if (_reshaped.length === 0) return "";
  return `\n  testUI: ${
    _reshaped.length === 1 ? "a call" : "calls"
  } from the ` +
    `UI rejected in this test, and what the caller received is what a real ` +
    `client receives — a plain Error with the server's message and its ` +
    `\`code\`. Not carried:\n` +
    _reshaped.map((l) => `    ${l}`).join("\n") +
    `\n  If the failure above checks the error's class (instanceof), ` +
    `\`cause\`, a property or its stack, it fails in the app the same way: ` +
    `branch on errorCode(e) or the message — or test the method on the ` +
    `server's side with testCell / bootCells, where no wire is crossed ` +
    `(docs/testing/ui-testing.md, "Calls cross the wire").`;
}

/** Put every CLIENT `serverFn` call of this mount across the wire: the
 *  browser's own argument vetting, the server's own route (`invokeServerFn` —
 *  the access rule, the registry, the result's JSON), the browser's own
 *  reader of a failed reply. In process the component's call reached the
 *  function itself: its arguments by reference, no access rule, its thrown
 *  error by identity. Server code calling one crosses no wire (as `access`
 *  decides it: `isServerOrigin`). Returns the undo. */
export function _serverFnsOverWire(
  viewer: () => AioUser | undefined,
  enforceAccess: boolean,
): () => void {
  const strict = _strict;
  return _useServerFnClientDoor((ns, name, args, direct) => {
    if (isServerOrigin()) return direct();
    const what = `serverFn("${ns}").${name}`;
    if (!strict) {
      // What 1.0.19's harness did: the component reaches the function itself.
      _sayWireOnce(
        "serverFn",
        `${what}() was called from the UI and reached the function itself. ` +
          `Over a real connection it goes through the server's route: the ` +
          `namespace's access rule (anonymous unless the test gives a ` +
          `user), arguments as JSON, and a failure whose message starts ` +
          `with "[server] "`,
      );
      return direct();
    }
    const kept = wireArgs(args) as unknown[];
    let sent: unknown[];
    try {
      sent = JSON.parse(JSON.stringify(kept));
    } catch {
      return Promise.reject(sfnArgsDropped(what));
    }
    const lossy: LossyConversion[] = [];
    findLossy(kept, sent, "args", lossy, { n: 0 });
    const lost = lossy.filter((l) => wireLossCounts(l, "harness"));
    if (lost.length > 0) {
      return Promise.reject(_wireLossError(`${what}()`, lost));
    }
    const user = viewer();
    return runWithUser(
      user,
      () => invokeServerFn(ns, name, sent, user, !enforceAccess),
    ).then((r) => {
      if (r.ok) return r.value;
      throw sfnError(JSON.parse(JSON.stringify(r)));
    });
  });
}

/** Deliver `useAio().send(action)` — the raw door a component can send any
 *  action through — as the server receives it: decoded from the frame a tab
 *  builds, through the method's own client door (the wire, `access`, the
 *  ledger). There is no transport under `testUI`, so the action used to be
 *  queued as "offline" and never ran: the test saw nothing happen. No ack
 *  comes back for it in the app either, so a failure is the ledger's to
 *  report, at the next observation. Returns the undo. */
export function _sendOverWire(
  cells: CellDef[],
  ledger: Pick<CallFailureLedger, "adopt">,
): () => void {
  const byId = new Map(cells.map((c) => [c.__aio.id, c]));
  const strict = _strict;
  const prev = setSyncHandler((action) => {
    if (prev?.(action)) return true;
    const type = String(action.type);
    if (!strict) {
      // What 1.0.19's harness did: not claimed — queued as offline, never run.
      _sayWireOnce(
        "send",
        `useAio().send({ type: "${type}" }) did NOT run — there is no ` +
          `transport under testUI, so the action was queued as offline. ` +
          `Over a real connection the server runs it (and refuses a type ` +
          `no cell has)`,
      );
      return false;
    }
    const at = type.indexOf(":");
    const def = byId.get(type.slice(0, at));
    const key = type.slice(at + 1);
    // A value JSON cannot carry at all throws HERE, at the call, as in a tab.
    encodeAction(action);
    const method = def && !key.startsWith("__") &&
        (def.__aio.actionKeys ?? []).includes(key)
      ? (def as unknown as Record<string, unknown>)[key]
      : undefined;
    if (typeof method !== "function") {
      ledger.adopt([{
        cell: type,
        err: withRefusalCode(
          new Error(
            `testUI: useAio().send({ type: "${type}" }) — no method of a ` +
              `cell booted in this test has that type. The app's server ` +
              `refuses such an action: nothing runs, and nothing tells the ` +
              `client. Send "<cell>:<method>" with payload { args: [...] }, ` +
              `or call the method (cell.method(...)), which is typed.`,
          ),
          "ACTION_REFUSED",
        ),
      }]);
      return true;
    }
    const args = (action.payload as { args?: unknown } | undefined)?.args;
    (method as (...a: unknown[]) => unknown)(
      ...(Array.isArray(args) ? args : []),
    );
    return true;
  });
  return () => void setSyncHandler(prev);
}

/** Put every client call to these cells across the wire (see
 *  `_overClientWire`). Returns a restore function.
 *
 *  Not a `scope: "client"` cell — it runs in the browser and has no wire —
 *  and not a `worker: true` one here: its wire is OUTSIDE its thread boundary
 *  (a frame is decoded, then posted to the worker; the result is cloned back,
 *  then acked), so the ledger's worker door carries it (`_workerCallOverWire`). */
export function _crossClientWire(cells: CellDef[]): () => void {
  const undo: (() => void)[] = [_useServerOriginScope()];
  for (const def of cells) {
    if (def.__aio?.scope === "client" || def.__aio?.worker === true) continue;
    const cellId = def.__aio.id;
    const target = def as unknown as Record<string, unknown>;
    for (const key of def.__aio.actionKeys ?? []) {
      if (key.startsWith("__")) continue;
      const bound = target[key];
      if (typeof bound !== "function") continue;
      const original = bound as (...a: unknown[]) => unknown;
      target[key] = (...args: unknown[]) =>
        _overClientWire(cellId, key, args, (sent) => original(...sent));
      undo.push(() => {
        target[key] = original;
      });
    }
  }
  return () => {
    for (const f of undo) f();
  };
}

/** A `worker: true` cell's method, called the way the app reaches it: the
 *  client's wire first, the worker's boundary inside it. */
export const _workerCallOverWire: typeof _callAcrossWorkerBoundary = (
  cellId,
  args,
  run,
  key,
) =>
  key === undefined || key.startsWith("__")
    ? _callAcrossWorkerBoundary(cellId, args, run, key)
    : _overClientWire(
      cellId,
      key,
      args,
      (sent) => _callAcrossWorkerBoundary(cellId, sent, run, key),
    );
