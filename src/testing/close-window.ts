// close-window.ts — closing a happy-dom window is not finished when `close()`
// resolves.
//
// MEASURED (happy-dom 17.6.3): an `Immediate` scheduled by the window can run
// AFTER `close()` has resolved, and `AsyncTaskManager.endImmediate` then
// re-arms the manager's "is everything settled?" `setTimeout`
// (`resolveWhenComplete`). That re-armed timer belongs to nobody: it outlives
// the test, and Deno's `--sanitize-ops` reports it against whichever test runs
// next. `tests/router-link-browser-owned.test.ts` failed that way in roughly
// two runs out of five ON ITS OWN — a flaky leak floor, which is worse than no
// floor at all, because it teaches a reader that red means nothing.
//
// One macrotask turn after the close lets that timer fire inside the test that
// owns it. It is not a sleep for luck: `setTimeout(0)` is queued BEHIND the
// timer happy-dom just armed with the same delay, so it cannot run first.
//
// Every awaited window teardown goes through here so the fix cannot be half
// applied — a second copy that forgets the turn is the drift this file exists
// to prevent.

/** Close a happy-dom window and let its own trailing timers finish. */
export async function closeWindow(
  win: { happyDOM?: { close(): Promise<void> } } | null | undefined,
): Promise<void> {
  await win?.happyDOM?.close();
  await new Promise<void>((r) => setTimeout(r, 0));
}
