// A server hello the browser cannot parse is the version gate failing OPEN:
// the client never negotiates, never learns the server's `rate` /
// `maxMessageBytes`, and goes on trading frames with a peer whose protocol it
// never checked. `handleControlFrame` swallowed it — `return true`, nothing
// logged, `onFatal` not called. Fail loud: an undecodable hello must at least
// be SAID (the adjacent "undecodable frame" path warns; this one did not).
import { assert } from "@std/assert";
import { handleControlFrame } from "../src/browser/browser-shared.ts";

Deno.test("proto: a malformed server hello is not swallowed silently", () => {
  const said: string[] = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => said.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => said.push(a.map(String).join(" "));
  let fatal: string | null = null;
  try {
    for (
      const d of [
        { v: "3", min: 3 }, // version as a string
        { v: 3 }, // no min
        { v: 2, min: 3 }, // min above v
        null,
      ]
    ) {
      const handled = handleControlFrame(
        { v: 2, t: "proto", d } as never,
        { current: null },
        (r) => {
          fatal = r;
        },
      );
      assert(handled, "the proto frame is consumed");
    }
  } finally {
    console.error = origErr;
    console.warn = origWarn;
  }
  assert(
    said.length > 0 || fatal !== null,
    "four undecodable server hellos produced no warning, no error and no " +
      "onFatal — the protocol gate failed open in silence",
  );
});
