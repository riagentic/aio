// The auto-capture dedup must not be an unbounded memory of every error
// string a process ever saw.
//
// It was a plain `Set` that only ever grew. The per-session cap bounds
// REPORTS, not keys — and error messages routinely embed a varying id
// ("request 4f3a failed", a path, a timestamp), so nearly every error added a
// new key. A long-running server is exactly the one that produces a long tail
// of unique errors, and it paid for all of them.
import { assert, assertEquals } from "@std/assert";
import { _createSeenKeys, _SEEN_LIMIT } from "../src/server/feedback-boot.ts";

Deno.test("feedback dedup: the key memory never exceeds its limit", () => {
  const seen = _createSeenKeys(4);
  for (let i = 0; i < 1000; i++) seen.add(`request ${i} failed`);
  assertEquals(seen.size(), 4, "bounded, whatever the traffic");
});

Deno.test("feedback dedup: it still dedups — a repeat is a repeat", () => {
  const seen = _createSeenKeys(4);
  seen.add("db: connection refused");
  assert(seen.has("db: connection refused"), "the point of the memory");
  seen.add("db: connection refused");
  assertEquals(seen.size(), 1, "adding a known key changes nothing");
});

Deno.test("feedback dedup: the OLDEST key is the one that goes", () => {
  const seen = _createSeenKeys(3);
  seen.add("a");
  seen.add("b");
  seen.add("c");
  seen.add("d"); // evicts "a"
  assertEquals(seen.has("a"), false, "oldest out");
  for (const k of ["b", "c", "d"]) {
    assert(seen.has(k), `${k} is still remembered`);
  }
  assertEquals(seen.size(), 3);
});

Deno.test("feedback dedup: the default limit is a session's worth, not unbounded", () => {
  const seen = _createSeenKeys();
  for (let i = 0; i < _SEEN_LIMIT * 2; i++) seen.add(`e${i}`);
  assertEquals(seen.size(), _SEEN_LIMIT);
  assert(_SEEN_LIMIT > 0 && Number.isFinite(_SEEN_LIMIT));
});
