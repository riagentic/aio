// pairing — the PIN state machine behind the friendly "type this code" flow
// for keyed --expose apps. One-shot, TTL-bounded, per-client-key attempt budget.
import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  clearPairing,
  currentPin,
  generatePin,
  verifyPin,
} from "../src/server/pairing.ts";

Deno.test("pairing: generatePin returns a fresh 6-digit code", () => {
  clearPairing();
  const pin = generatePin();
  assert(/^[0-9]{6}$/.test(pin), `expected 6 digits, got ${pin}`);
  assertEquals(currentPin(), pin);
  clearPairing();
});

Deno.test("pairing: correct PIN verifies, wrong PIN does not", () => {
  const pin = generatePin();
  assertEquals(verifyPin("000000000"), false); // wrong (and never all-match)
  assertEquals(verifyPin(pin), true);
  clearPairing();
});

Deno.test("pairing: correct PIN is ONE-SHOT — consumed on success, no replay", () => {
  const pin = generatePin();
  assertEquals(verifyPin(pin), true); // pairs
  // The same code cannot be replayed later in the session.
  assertEquals(verifyPin(pin), false);
  assertEquals(currentPin(), null, "PIN is consumed after a successful pair");
  clearPairing();
});

Deno.test("pairing: PIN self-expires after its TTL", () => {
  using time = new FakeTime();
  const pin = generatePin();
  time.tick(2 * 60_000); // within TTL (3 min)
  assertEquals(currentPin(), pin);
  time.tick(2 * 60_000); // now past TTL
  assertEquals(currentPin(), null, "expired PIN is cleared");
  assertEquals(verifyPin(pin), false, "expired PIN can't pair");
  clearPairing();
});

Deno.test("pairing: no active PIN → everything fails", () => {
  clearPairing();
  assertEquals(currentPin(), null);
  assertEquals(verifyPin("123456"), false);
});

Deno.test("pairing: non-string submissions are rejected", () => {
  generatePin();
  assertEquals(verifyPin(undefined), false);
  assertEquals(verifyPin(123456), false);
  assertEquals(verifyPin(null), false);
  clearPairing();
});

Deno.test("pairing: wrong tries lock the OFFENDING client key, not the PIN globally", () => {
  const pin = generatePin();
  // An attacker at one IP exhausts its budget with wrong guesses.
  for (let i = 0; i < 8; i++) {
    assertEquals(verifyPin("999999", "10.0.0.9"), false);
  }
  // That attacker is now refused even with the correct code…
  assertEquals(verifyPin(pin, "10.0.0.9"), false);
  // …but the PIN is NOT globally locked (no DoS): it's still active, and the
  // legitimate device at a different key can still pair.
  assertEquals(currentPin(), pin, "PIN stays active — attacker can't DoS it");
  assertEquals(verifyPin(pin, "192.168.1.50"), true);
  clearPairing();
});

Deno.test("pairing: generatePin replaces any prior code", () => {
  const first = generatePin();
  const second = generatePin();
  assertEquals(currentPin(), second);
  // the old PIN is dead once a new one is issued
  if (first !== second) assertEquals(verifyPin(first), false);
  assertEquals(verifyPin(second), true);
  clearPairing();
});
