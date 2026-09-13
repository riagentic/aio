/**
 * @module
 * `am eval '<expression>'` — evaluate JavaScript in the live renderer and get
 * JSON back, over the DevTools Protocol the app opened with `--cdp`.
 *
 * WHY THIS EXISTS. It was the single most-requested `am` verb across the field
 * reports, and every one of them arrived at it the same way: by building it
 * themselves. Verbatim asks — "`am eval '<expression>'`, evaluating in the
 * renderer and returning JSON. I needed pixels out of the window and built a
 * bespoke route to get them. One generic hatch replaces every bespoke one, and
 * it is the single feature I would add to `am` first." And, from a different
 * app: "So I wrote this, in the scratchpad, and used it for the rest of the
 * build … that is ~15 lines every agent building an aio app will rewrite."
 *
 * WHAT `am surface` CANNOT ANSWER, which is what makes this a gap rather than a
 * convenience. It reports component paths, element names, text, value and
 * checked. It does not report:
 *
 *   - GEOMETRY. One app's canvas was 13 772 px tall for hours while every `am`
 *     command reported perfect health; another needed `getBoundingClientRect()`
 *     to tell a real overlap from a screenshot downscaling artifact.
 *   - COMPUTED STYLES. A `class="track"` collision silently clipped every row
 *     of a list to one line — no error, no warning, and a component tree that
 *     reads as correct. It was found by reading computed styles over CDP and by
 *     nothing else.
 *   - A FETCH FROM THE PAGE'S OWN ORIGIN, which is the only honest way to test
 *     a route as the browser sees it.
 *
 * THE GUARD is the same one `--cdp` already carries and no weaker: the port is
 * opt-in, loopback-only, and an app that did not ask for it binds none. This
 * verb adds no surface an app has not already opened.
 */
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { liveLock, resolveAmAppId } from "./am-utils.ts";
import { appPageTargets, cdpConnect, cdpTargets } from "./am-cdp.ts";
import { noCdpMessage } from "./am-cmd-shot.ts";

/** What `Runtime.evaluate` answers with. */
type EvalReply = {
  result?: { type?: string; value?: unknown; description?: string };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
    lineNumber?: number;
    columnNumber?: number;
  };
};

/** Pure: the reply, as the shape this command reports.
 *
 *  An exception is a RESULT, not a transport failure — the expression ran and
 *  threw, which is a thing the caller asked to find out. Reporting it as
 *  `undefined` (what a naive read of `result.value` gives) is the wrong-answer
 *  shape this whole verb exists to remove.
 *
 *  `undefined` is likewise not `null`: `Runtime.evaluate` returns
 *  `{type:"undefined"}` with no `value` key, and JSON has no way to say so.
 *  Saying `"undefined"` in `type` keeps the two distinguishable. */
export function evalOutcome(
  reply: EvalReply,
): { ok: true; value: unknown; type: string } | { ok: false; error: string } {
  const ex = reply.exceptionDetails;
  if (ex) {
    const desc = ex.exception?.description ??
      (ex.exception?.value !== undefined
        ? String(ex.exception.value)
        : undefined) ??
      ex.text ?? "evaluation threw";
    const at = ex.lineNumber !== undefined
      ? ` (at ${ex.lineNumber}:${ex.columnNumber ?? 0})`
      : "";
    return { ok: false, error: `${desc}${at}` };
  }
  const r = reply.result ?? {};
  return { ok: true, value: r.value, type: r.type ?? "undefined" };
}

/** The expression, wrapped so what comes back is what was asked for.
 *
 *  Every clause here is a wrong answer a real Chromium gave first — the whole
 *  point of this verb is to stop an agent believing something false about a
 *  running window, so a probe that quietly returns `{}` is worse than no probe.
 *
 *  1. `(expr)` — `{ a: 1 }` at statement position is a BLOCK with a labelled
 *     statement in it, and evaluated as one it answers `1`. The parens make it
 *     the object the author wrote.
 *  2. `Promise.resolve(...).then(...)` with `awaitPromise` — an async probe is
 *     the normal case (`fetch(...).then(r => r.status)`), and unawaited it
 *     answers `{}`, a serialised Promise.
 *  3. The JSON round-trip — `returnByValue` alone serialises a DOMRect to `{}`,
 *     because its numbers live on the prototype as getters. Geometry is the
 *     single most-cited reason this verb was asked for ("my canvas was 13 772
 *     px tall for hours and every `am` command reported perfect health"), so
 *     returning `{}` for `getBoundingClientRect()` would have shipped the
 *     feature with its headline case broken. `JSON.stringify` calls `toJSON()`,
 *     which DOMRect has.
 *  4. A DOM NODE is summarised rather than flattened. `document.body` is the
 *     obvious thing to type and JSON-ifies to `{}`; a name, id, class, rect and
 *     the first 200 characters of text is what the asker actually wanted.
 *  5. A circular object is NAMED, not thrown. `JSON.stringify` throws on one,
 *     and an error here would read as "the expression failed" when it did not.
 *
 *  Exceptions still arrive as `exceptionDetails` — verified against Chromium
 *  for both a synchronous throw and a rejected promise — so `evalOutcome` can
 *  tell "it threw" from "it returned undefined". */
export function wrapExpression(expr: string): string {
  return `Promise.resolve((${expr})).then(function(v){` +
    `if(v===undefined)return undefined;` +
    `if(v&&typeof v==="object"&&typeof v.nodeType==="number")` +
    `return{node:v.nodeName,id:v.id||undefined,class:v.className||undefined,` +
    `rect:v.getBoundingClientRect?` +
    `JSON.parse(JSON.stringify(v.getBoundingClientRect())):undefined,` +
    `text:(v.textContent||"").slice(0,200)};` +
    `try{return JSON.parse(JSON.stringify(v))}` +
    `catch(_){return{__aio_unserializable:String(v)}}})`;
}

export async function cmdEval(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const expr = args.find((a) => !a.startsWith("--"));
  if (!expr) {
    outError(
      `am eval needs an expression: am eval 'document.title'\n` +
        `  It runs in the app's RENDERER and returns JSON. Examples:\n` +
        `    am eval 'document.querySelector(".stage").getBoundingClientRect()'\n` +
        `    am eval 'getComputedStyle(document.querySelector(".row")).height'\n` +
        `    am eval 'fetch("/api/x").then(r => r.status)'   # awaited for you\n` +
        `  The app must be running with --cdp.`,
      mode,
    );
    Deno.exit(1);
  }
  const pf = liveLock(appId);
  if (!pf) {
    outError(`${appId} is not running (no lock) — am start first`, mode);
    Deno.exit(1);
  }
  if (!pf.cdpPort) {
    // The same message `am shot` gives, deliberately: two verbs that need the
    // same flag must not explain it two ways — but they must each name their
    // OWN job. It was hardcoded to a screenshot, so this answered "a
    // screenshot needs it… then `am shot` again" to someone evaluating an
    // expression.
    outError(
      noCdpMessage(appId, pf.client, {
        what: "evaluating an expression in the page",
        verb: "eval",
      }),
      mode,
    );
    Deno.exit(1);
  }
  const timeout = flags.timeout ?? 8000;
  const idxRaw = args.find((a) => a.startsWith("--window="))?.slice(9);
  const idx = idxRaw === undefined ? 0 : Number(idxRaw);
  if (!Number.isInteger(idx) || idx < 0) {
    outError(`invalid --window=${idxRaw} — a non-negative integer`, mode);
    Deno.exit(1);
  }

  let targets;
  try {
    targets = await cdpTargets(pf.cdpPort, timeout);
  } catch (e) {
    outError(
      `${appId} recorded cdp 127.0.0.1:${pf.cdpPort} but nothing answers ` +
        `there (${e instanceof Error ? e.message : e}) — is the window up?`,
      mode,
    );
    Deno.exit(1);
  }
  const pages = appPageTargets(targets, pf.port);
  const target = pages[idx];
  if (!target) {
    outError(
      pages.length === 0
        ? `no app window among the CDP targets (saw: ${
          targets.map((t) => `${t.type} ${t.url}`).join(", ") || "none"
        })`
        : `window ${idx} does not exist — ${pages.length} app window(s): ${
          pages.map((p, i) => `${i}=${p.url}`).join(", ")
        }`,
      mode,
    );
    Deno.exit(1);
  }
  const cdp = await cdpConnect(target.webSocketDebuggerUrl, timeout);
  try {
    const reply = await cdp.call("Runtime.evaluate", {
      expression: wrapExpression(expr),
      returnByValue: true,
      // Every useful probe of a running app is async, so awaiting is the
      // default rather than a flag.
      awaitPromise: true,
      // NOT `replMode`. It looks like the right switch for evaluating an
      // expression and it silently BREAKS `awaitPromise`: measured against a
      // real Chromium, `Promise.resolve(42)` came back as `{}` with replMode
      // on and `42` with it off. The paren wrap in `wrapExpression` solves the
      // statement/expression ambiguity replMode was wanted for.
    }) as EvalReply;
    const outcome = evalOutcome(reply);
    if (!outcome.ok) {
      outError(`${expr} threw: ${outcome.error}`, mode);
      Deno.exit(1);
    }
    out(
      mode === "pretty"
        ? (outcome.type === "undefined"
          ? "undefined"
          : JSON.stringify(outcome.value, null, 2) ?? String(outcome.value))
        : { value: outcome.value ?? null, type: outcome.type, url: target.url },
      mode,
    );
  } finally {
    cdp.close();
  }
}
