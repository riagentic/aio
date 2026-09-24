/** THE chapter every state-size message points at: what each limit governs,
 *  what a big state costs per transport (measured), and how to hold a large
 *  working set on purpose. A leaf with no imports, so the browser-side notices
 *  (the dev freeze in immutable.ts) can name it without pulling the budget
 *  ledger into the bundle. The anchor is pinned to land on a heading by
 *  tests/large-state-hints.test.ts. */
export const LARGE_STATE_DOC =
  "docs/persistence/big-data.md#legitimately-large-state";
