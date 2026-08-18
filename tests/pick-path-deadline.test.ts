// A native picker blocks on a PERSON, so the call ceiling stops.
//
// Thirty seconds is an ordinary amount of time to spend finding a folder, and
// the default ceiling would cancel the pick out from under them. A field
// report hit exactly that: they copied docs/clients/desktop-jobs.md, which
// marks the hours-long render `long:` and NOT the two methods that wait on a
// human, and had to add `long: ["openKataFolder"]` themselves. Waiting on a
// dialog is not the app being slow — and it is a property of the PRIMITIVE,
// so the primitive decides it, once, for every app.
import { assertEquals, assertRejects } from "@std/assert";
import {
  _resetCallTimeouts,
  _setCallTimeouts,
  pauseCallDeadlines,
  registerCall,
  resetPending,
  resolveCall,
} from "../src/state/cell-impl.ts";

Deno.test("a call ceiling still fires when nobody is waiting on a human", async () => {
  resetPending();
  _setCallTimeouts(30);
  const p = registerCall("c1", "job:colorize");
  await assertRejects(() => p, Error, "stopped waiting after 30ms");
  _resetCallTimeouts();
});

Deno.test("pauseCallDeadlines stops the clock on every in-flight call", async () => {
  resetPending();
  _setCallTimeouts(30);
  const a = registerCall("c2", "job:browse");
  const b = registerCall("c3", "job:chooseOutput");
  // The picker's first act. Both calls now outlive the ceiling.
  const resume = pauseCallDeadlines();
  await new Promise((r) => setTimeout(r, 90));
  resolveCall("c2", "/home/me/video.mp4");
  resolveCall("c3", "/home/me/out");
  assertEquals(await a, "/home/me/video.mp4");
  assertEquals(await b, "/home/me/out");
  resume(); // both settled — must arm nothing (the op sanitizer checks)
  _resetCallTimeouts();
});

Deno.test("resume RE-ARMS a survivor — one dialog is not a permanent amnesty", async () => {
  // Without the resume, a pick would permanently disarm the timeout of an
  // unrelated method that genuinely hung — turning "rejected with a reason
  // after the ceiling" into "hangs forever, silently".
  resetPending();
  _setCallTimeouts(30);
  const hung = registerCall("c4", "job:neverSettles");
  const resume = pauseCallDeadlines();
  await new Promise((r) => setTimeout(r, 90)); // well past the ceiling: alive
  resume(); // dialog closed — a fresh full window starts
  await assertRejects(() => hung, Error, "stopped waiting after 30ms");
  _resetCallTimeouts();
});
