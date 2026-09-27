// `redactActions` covers the dispatch loop's own error labels too.
//
// `tag()` rendered an action as type + full payload into DISPATCH_LOOP and the
// "effect is not structuredClone-able" error, so a redacted method's secret
// reached the console and error.log through those two paths.
import { assert, assertStringIncludes } from "@std/assert";
import { createDispatch } from "../src/state/dispatch.ts";
import type { AioError } from "../src/diagnostics/error.ts";
import { makeRedactor } from "../src/diagnostics/redact.ts";
import { buildReportOpts } from "../src/server/aio-run-helpers.ts";

const SECRET = "hunter2-SUPERSECRET";
const noop = { debug: () => {}, warn: () => {}, error: () => {} };

function opts(errors: AioError[]) {
  return buildReportOpts(
    {
      onError: (e: AioError) => void errors.push(e),
      getTT: () => null,
      prod: true,
      redact: makeRedactor(["vault:unlockWith"]),
    } as Parameters<typeof buildReportOpts>[0],
  );
}

const shown = (e: AioError) =>
  `${e.message} ${JSON.stringify(e.context ?? {})}`;

Deno.test("dispatch: a DISPATCH_LOOP label withholds a redacted payload", () => {
  const errors: AioError[] = [];
  let state = 0;
  let again: ((a: { type: string; payload?: unknown }) => void) | null = null;
  const dispatch = createDispatch<
    number,
    { type: string; payload?: unknown },
    { type: string }
  >({
    reduce: (s) => ({ state: s + 1, effects: [{ type: "LOOP" }] }),
    execute: () =>
      again!({ type: "vault:unlockWith", payload: { pass: SECRET } }),
    getState: () => state,
    setState: (s) => void (state = s),
    onDone: () => {},
    log: noop,
    debug: false,
    reportOpts: opts(errors),
  });
  again = dispatch;
  dispatch({ type: "vault:unlockWith", payload: { pass: SECRET } })
    // aio-ok: the overflow rejects the call; the report is what is checked
    .catch(() => {});
  const loop = errors.find((e) => e.code === "DISPATCH_LOOP");
  assert(loop, "no DISPATCH_LOOP reported");
  assertStringIncludes(shown(loop), "[redacted]");
  assert(!shown(loop).includes(SECRET), shown(loop));
});

Deno.test("dispatch: a non-cloneable effect's error withholds a redacted payload (write-set too)", () => {
  const errors: AioError[] = [];
  let state = 0;
  const dispatch = createDispatch<
    number,
    { type: string; payload?: unknown },
    { type: string; fn?: () => void }
  >({
    reduce: (s) => ({ state: s + 1, effects: [{ type: "bad", fn: () => {} }] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => void (state = s),
    onDone: () => {},
    log: noop,
    debug: false,
    reportOpts: opts(errors),
  });
  // The write-set of the redacted method: its own type, the origin decides.
  dispatch({
    type: "vault:__setUnlockWith",
    payload: { _origin: "unlockWith", pass: SECRET },
  }).catch(() => {}); // aio-ok: only the report is checked
  const err = errors.find((e) => /structuredClone-able/.test(e.message));
  assert(err, "no non-cloneable effect reported");
  assertStringIncludes(err.message, "[redacted]");
  assert(!shown(err).includes(SECRET), shown(err));
});
