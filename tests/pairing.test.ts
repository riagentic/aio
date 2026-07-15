// pairing — the PIN state machine behind the friendly "type this code" flow
// for keyed --expose apps. Attempt-limited and session-scoped (anti-brute).
import { assert, assertEquals } from "@std/assert";
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

Deno.test("pairing: too many wrong tries locks the PIN (anti-brute-force)", () => {
  const pin = generatePin();
  // 8 attempts allowed; exhaust them all with a wrong code
  for (let i = 0; i < 8; i++) assertEquals(verifyPin("999999"), false);
  // now locked — even the correct PIN no longer works
  assertEquals(currentPin(), null);
  assertEquals(verifyPin(pin), false);
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
