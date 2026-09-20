// `sessions.issue` refuses a ttlMs that "cannot become an expiry"; `refresh`
// writes exactly the same column and refused nothing. Measured against a real
// store, the twin of every failure `issue`'s guard names:
//
//   refresh(t, Number.MAX_SAFE_INTEGER) → true, and every later `get(t)` THREW
//     "Value is too large to be represented as a JavaScript number" — a live
//     token that 500s every request presenting it and cannot be resolved to
//     revoke it;
//   refresh(t, Infinity)                → true, expires_at = Infinity: an
//     IMMORTAL session. `DELETE … WHERE expires_at <= ?` never matches it, so
//     no sweep, no TTL, nothing but an explicit revoke ends it;
//   refresh(t, 1e20)                    → the same, with a year 3-trillion;
//   refresh(t, -1)                      → "true" for a session it just killed;
//   refresh(t, NaN)                     → a raw SQLite "NOT NULL constraint
//     failed" instead of a named policy error.
//
// One guard, read by both writers of the column.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { openSessionStore } from "../src/server/sessions.ts";

Deno.test("sessions.refresh refuses a ttlMs that cannot become an expiry", () => {
  const store = openSessionStore(":memory:");
  try {
    for (const ttl of [Number.MAX_SAFE_INTEGER, Infinity, 1e20, -1, 0, NaN]) {
      const token = store.issue({ id: "u", role: "user" });
      const before = store.get(token)!.expiresAt;
      assertThrows(
        () => store.refresh(token, ttl),
        Error,
        "ttlMs",
        `refresh(${ttl}) must be refused the way issue(${ttl}) is`,
      );
      // …and the live session is untouched by the refusal.
      const after = store.get(token);
      assert(after !== null, `the session must survive a refused refresh`);
      assertEquals(after.expiresAt, before);
      assert(
        Number.isSafeInteger(after.expiresAt),
        "a live expiry is always a safe integer",
      );
    }

    // An ordinary refresh still works, and still moves the expiry.
    const token = store.issue({ id: "u2", role: "user" }, { ttlMs: 1000 });
    assertEquals(store.refresh(token, 60_000), true);
    assert(store.get(token)!.expiresAt > Date.now() + 30_000);
    // …and an unknown token is still a `false`, not a throw.
    assertEquals(store.refresh("aios_nope", 60_000), false);
  } finally {
    store.close();
  }
});

// …AND "CANNOT BECOME AN EXPIRY" INCLUDES THE ONES BETWEEN 0 AND 1.
//
// The guard was `ttl > 0`, and `now + ttl` is a double: at `now ≈ 1.79e12`
// the gap between representable numbers is 2⁻¹², so every ttlMs under about
// 0.0002 adds NOTHING. The exact failures listed above came straight back:
//
//   issue(1e-9)   → a real-looking token whose `expires_at` equals `now`,
//     so the very next `get` is null — a session born dead, reported as
//     issued;
//   refresh(t, 1e-9) → `true` for a session it had just killed — the `-1`
//     case, one guard away from the value that is supposed to be refused.
//
// And a FRACTIONAL ttl wrote a REAL into `expires_at INTEGER NOT NULL`
// (SQLite keeps a non-losslessly-convertible REAL as REAL), so `expiresAt`
// came back `…267.5` — the "a live expiry is always a safe integer" the test
// above asserts but nothing enforced.
//
// The invariant, stated once: a session that was issued is alive, and the
// column holds an integer. So the floor is ONE millisecond, and the expiry
// is floored to an integer rather than refusing a caller whose arithmetic
// produced `60_000.5` — accepting it and storing a REAL was the bug, not the
// fraction.
Deno.test("sessions: a ttl under a millisecond cannot issue a dead session", () => {
  const store = openSessionStore(":memory:");
  try {
    for (const ttl of [1e-9, Number.EPSILON, 0.5, 0.9999]) {
      assertThrows(
        () => store.issue({ id: "u", role: "user" }, { ttlMs: ttl }),
        Error,
        "ttlMs",
        `issue(${ttl}) adds nothing to \`now\` — it must be refused, not ` +
          `answered with a token that never resolves`,
      );
      const token = store.issue({ id: "u", role: "user" });
      assertThrows(
        () => store.refresh(token, ttl),
        Error,
        "ttlMs",
        `refresh(${ttl}) must be refused the way issue(${ttl}) is`,
      );
      assert(store.get(token) !== null, "the session survives the refusal");
    }

    // One millisecond is the floor, and it works.
    const t1 = store.issue({ id: "u", role: "user" }, { ttlMs: 1 });
    assertEquals(typeof t1, "string");

    // A fractional ttl is accepted — and the COLUMN still holds an integer.
    for (const ttl of [60_000.5, 1.5, 999.9]) {
      const t = store.issue({ id: "u3", role: "user" }, { ttlMs: ttl });
      const exp = store.get(t)!.expiresAt;
      assert(
        Number.isSafeInteger(exp),
        `issue(${ttl}) wrote ${exp} into an INTEGER column`,
      );
      assertEquals(store.refresh(t, ttl), true);
      const after = store.get(t)!.expiresAt;
      assert(
        Number.isSafeInteger(after),
        `refresh(${ttl}) wrote ${after} into an INTEGER column`,
      );
    }
  } finally {
    store.close();
  }
});

Deno.test("sessions: the ttl refusal names the value it was actually given", () => {
  const store = openSessionStore(":memory:");
  try {
    // `["60000"]` stringifies to `60000` — a message that names a value the
    // caller can see nothing wrong with is worse than no message.
    for (const bad of [[60_000], [], {}, "60000", true]) {
      const e = assertThrows(
        () => store.issue({ id: "u", role: "user" }, { ttlMs: bad as never }),
        Error,
      );
      assert(
        !/ttlMs 60000 /.test(e.message),
        `the refusal must not read as if a valid number was refused: ` +
          e.message,
      );
    }
  } finally {
    store.close();
  }
});
