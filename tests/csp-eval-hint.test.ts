// When aio's CSP refuses an `eval`, aio says so — in aio's voice.
//
// `security-headers.ts` withholds `'unsafe-eval'` from every page aio serves,
// which is correct and deliberate: it closes the one hole the `"basic"` policy
// was otherwise silent about, and it does so identically in dev and prod. But
// the browser's own refusal —
//
//     Refused to evaluate a string as JavaScript because 'unsafe-eval' is not
//     an allowed source of script
//
// names neither aio, nor the directive aio set, nor the way back. An app that
// loads a template engine, an expression evaluator or a plugin host would meet
// that line with nothing to search for, and .katana/goals.md is explicit that
// "a break discovered by debugging is a broken promise".
//
// So the client runtime recognises exactly that violation and forwards ONE
// line naming aio and the opt-out. Observe-only: the eval is refused either
// way, in dev and in prod alike — this only explains it.
import { assert, assertEquals } from "@std/assert";
import {
  installConsoleIntercept,
  uninstallConsoleIntercept,
} from "../src/browser/console-intercept.ts";

/** A `securitypolicyviolation` event, as the browser raises it. */
function violation(directive: string, blocked: string): Event {
  const ev = new Event("securitypolicyviolation");
  Object.assign(ev, { violatedDirective: directive, blockedURI: blocked });
  return ev;
}

/** What the client would actually put on the wire — the forwarder is handed a
 *  serialized `log` frame, so the assertions read the frame rather than a
 *  convenient shape that only exists in this test. */
function captured(fn: () => void): { level: string; text: string }[] {
  const seen: { level: string; text: string }[] = [];
  installConsoleIntercept((frame: string) => {
    const d = (JSON.parse(frame) as { d?: { level?: string; msg?: string } }).d;
    seen.push({ level: d?.level ?? "?", text: d?.msg ?? "" });
  });
  try {
    fn();
  } finally {
    uninstallConsoleIntercept();
  }
  return seen;
}

Deno.test("csp: a refused eval is explained once, naming the opt-out", () => {
  const seen = captured(() => {
    globalThis.dispatchEvent(violation("script-src", "eval"));
    globalThis.dispatchEvent(violation("script-src", "eval"));
    globalThis.dispatchEvent(violation("script-src", "eval"));
  });
  const hints = seen.filter((s) => s.text.includes("unsafe-eval"));
  assertEquals(
    hints.length,
    1,
    `the same eval usually runs in a loop — one explanation is help, ` +
      `fifty is the noise this project refuses. Got ${hints.length}:\n` +
      seen.map((s) => `  ${s.level} ${s.text.slice(0, 120)}`).join("\n"),
  );
  const t = hints[0]!.text;
  assert(t.includes("[aio]"), `the hint must own the change: ${t}`);
  assert(
    t.includes("cspDirectives"),
    `the hint must name the way back, or it is just a second copy of the ` +
      `browser's message: ${t}`,
  );
});

Deno.test("csp: any OTHER violation is left entirely alone", () => {
  // The false-alarm direction. A page that blocks an off-origin image or an
  // inline style has nothing to do with `eval`, and a hint that fired there
  // would be aio having an opinion about the app's own policy.
  const seen = captured(() => {
    globalThis.dispatchEvent(violation("img-src", "https://cdn.example/x.png"));
    globalThis.dispatchEvent(violation("style-src", "inline"));
    globalThis.dispatchEvent(
      violation("script-src", "https://cdn.example/a.js"),
    );
  });
  assertEquals(
    seen.filter((s) => s.text.includes("unsafe-eval")),
    [],
    "the eval hint fired for a violation that was not an eval",
  );
});
