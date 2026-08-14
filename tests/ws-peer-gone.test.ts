// The last thing a developer saw on EVERY run:
//
//   WARN ws error 8f2255b7 — Unexpected EOF
//
// …printed when they closed the window. Closing a window is how an Electron or
// browser session normally ends, and it sends no close frame, so Deno surfaces
// it on the error channel. A warning at the exact moment nothing went wrong is
// how you teach someone that warnings are background noise — and then the one
// that matters scrolls past too.
//
// The teardown is unchanged (connection dropped, timers cleared, onDisconnect
// fired). Only the label moved, and the text is still there at debug level.
import { assertEquals } from "@std/assert";
import { isPeerGone } from "../src/server/server-ws.ts";

Deno.test("ws: the ordinary end of a session is not a fault", () => {
  for (
    const msg of [
      "Unexpected EOF",
      "unexpected eof during handshake",
      "Connection reset by peer (os error 104)",
      "Broken pipe (os error 32)",
      "connection closed before message completed",
    ]
  ) {
    assertEquals(isPeerGone(msg), true, `should be a disconnect: ${msg}`);
  }
});

Deno.test("ws: a REAL error still warns", () => {
  for (
    const msg of [
      "invalid frame header",
      "message too large",
      "protocol error: unmasked client frame",
      "TypeError: cannot read property of undefined",
      "",
    ]
  ) {
    assertEquals(isPeerGone(msg), false, `should stay a warning: ${msg}`);
  }
});
