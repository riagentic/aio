// `am stop` / `am restart` ending a dev session's freshly relaunched child
// must end the session — whatever exit code the child ends with.
//
// On Windows that end is TerminateProcess: exit code 1 and no signal, the
// same as a crash. Within the relaunch window the supervisor read it as "the
// saved file does not load" and sat waiting for a fix under the app's lock,
// and `am restart` then met that wait and failed ("dr is waiting for a fix"
// — tests/dev-restart-race-one-process.test.ts on a loaded Windows VM).
// `am stop` marks the record `stopping` before it ends the child, and
// TerminateProcess leaves that record behind: the supervisor reads the mark.
import { assertEquals } from "@std/assert";
import {
  childEndsSession,
  FAILED_RESTART_WINDOW_MS,
} from "../src/server/dev-restart.ts";
import type { LockData } from "../src/server/single-instance-lock.ts";

const CHILD = 4242;
const rec = (status: LockData["status"], pid = CHILD) =>
  ({ appId: "a", pid, port: 1, startedAt: 0, status }) as LockData;
const code = (c: number) => ({ code: c, signal: null });

Deno.test("dev restart: a child ended by `am stop` ends the session even with exit code 1 — Windows' TerminateProcess", () => {
  assertEquals(childEndsSession(code(1), 500, rec("stopping"), CHILD), true);
});

Deno.test("dev restart: a child that exits 1 right after a save, not asked to stop, waits for a fix", () => {
  assertEquals(childEndsSession(code(1), 500, rec("started"), CHILD), false);
  assertEquals(childEndsSession(code(1), 500, null, CHILD), false);
  // Another process's record marked `stopping` is not this child's stop.
  assertEquals(
    childEndsSession(code(1), 500, rec("stopping", CHILD + 1), CHILD),
    false,
  );
});

Deno.test("dev restart: a signal, a clean 0 or a crash after the window ends the session as before", () => {
  assertEquals(
    childEndsSession({ code: 143, signal: "SIGTERM" }, 500, null, CHILD),
    true,
  );
  assertEquals(childEndsSession(code(0), 500, null, CHILD), true);
  assertEquals(
    childEndsSession(code(1), FAILED_RESTART_WINDOW_MS + 1, null, CHILD),
    true,
  );
});
