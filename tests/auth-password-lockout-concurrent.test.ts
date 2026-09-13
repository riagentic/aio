// The password lockout holds against guesses fired AT ONCE, not only one by one.
//
// `verify` read the row (lock state included), awaited PBKDF2, and only then
// counted the failure — so every guess that started before the fifth failure
// was COUNTED had its password checked, and a right one among them read the
// pre-lock row. Measured: 29 wrong passwords and the right one in one
// `Promise.all` → `{ id: "ann", role: "user" }`, a session thirty guesses into
// a lockout that allows five. Sequentially the same thirty give five nulls, a
// lock, and `"locked"` for the right password.
import { assert, assertEquals } from "@std/assert";
import { openUserStore } from "../src/server/auth-users.ts";

const PW = "password123";

Deno.test("password lockout: 29 wrong + the right password in one burst → locked, no user", async () => {
  const s = openUserStore(":memory:");
  try {
    await s.create("ann", PW);
    // Two spellings of one id (trailing space, NFC-equal) must share one lane.
    const guesses = Array.from(
      { length: 30 },
      (_, i) => i === 29 ? PW : `wrong-${i}`,
    );
    const r = await Promise.all(
      guesses.map((g, i) => s.verify(i % 2 ? "ann " : "ann", g)),
    );
    assert(
      r.slice(0, 29).every((x) => x === null),
      `every wrong guess is a plain null — got ${JSON.stringify(r)}`,
    );
    assertEquals(
      r[29],
      "locked",
      "the right password after five counted failures is refused",
    );
    assertEquals(await s.verify("ann", PW), "locked", "and the lock stays");
  } finally {
    s.close();
  }
});

Deno.test("password lockout: a burst gives exactly what sequential attempts give", async () => {
  const burst = openUserStore(":memory:");
  const seq = openUserStore(":memory:");
  try {
    await burst.create("ann", PW);
    await seq.create("ann", PW);
    // Wrong ×3, right (clears the count), wrong ×4, right, wrong ×5, right.
    const plan = [
      ...["a", "b", "c", PW],
      ...["d", "e", "f", "g", PW],
      ...["h", "i", "j", "k", "l", PW],
    ];
    const got = await Promise.all(plan.map((p) => burst.verify("ann", p)));
    const want: unknown[] = [];
    for (const p of plan) want.push(await seq.verify("ann", p));
    assertEquals(got, want);
    // Pin the sequential truth too, so both cannot drift together.
    assertEquals(want.at(3), { id: "ann", role: "user" });
    assertEquals(want.at(8), { id: "ann", role: "user" });
    assertEquals(want.at(-1), "locked");
  } finally {
    burst.close();
    seq.close();
  }
});

Deno.test("password lockout: the owner's right password inside a burst of four wrong still signs in", async () => {
  const s = openUserStore(":memory:");
  try {
    await s.create("ann", PW);
    const r = await Promise.all(
      ["w1", "w2", "w3", "w4", PW].map((p) => s.verify("ann", p)),
    );
    assertEquals(r, [null, null, null, null, { id: "ann", role: "user" }]);
    // …and it started the count over: four more wrong do not lock.
    for (const p of ["x1", "x2", "x3", "x4"]) {
      assertEquals(await s.verify("ann", p), null);
    }
    assertEquals(await s.verify("ann", PW), { id: "ann", role: "user" });
  } finally {
    s.close();
  }
});

Deno.test("password lockout: after a burst locks it, only the documented unlock lets the owner in", async () => {
  const s = openUserStore(":memory:");
  try {
    await s.create("ann", PW);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => s.verify("ann", `bad-${i}`)),
    );
    assertEquals(await s.verify("ann", PW), "locked");
    assert(s.unlock("ann"));
    assertEquals(await s.verify("ann", PW), { id: "ann", role: "user" });
  } finally {
    s.close();
  }
});

Deno.test("password verify: an account removed while its password was hashing is not a user", async () => {
  const s = openUserStore(":memory:");
  try {
    await s.create("ann", PW);
    // `verify` hashes for ~100 ms; the account ends in that window. The login
    // route mints a session from whatever `verify` returns.
    const pending = s.verify("ann", PW);
    assert(s.remove("ann"));
    assertEquals(await pending, null);
  } finally {
    s.close();
  }
});
