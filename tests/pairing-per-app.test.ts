// Pairing PINs are PER APP and have a TOTAL guess budget — through real servers.
//
// 1. The PIN was one module-level slot. Two keyed apps in one process (library
//    mode, `testApps`): booting B replaced A's PIN, so the code A printed was
//    dead, and B's code paired A — returning A's key.
// 2. Wrong guesses were budgeted per source address only. 320 wrong guesses
//    from 40 addresses, then the right PIN from a 41st → 200 and the app key.
//    A rotating source is free (an IPv6 /64, a botnet, a forwarding header
//    behind a proxy), so the per-address budget bounded nothing.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import {
  clearPairing,
  currentPin,
  generatePin,
  MAX_WRONG_TOTAL,
} from "../src/server/pairing.ts";

const keyed = (
  name: string,
  key: string,
  extra: Record<string, unknown> = {},
) =>
  testServer({
    cells: [cell(`pair_${name}`, { state: { n: 0 }, methods: {} })],
    expose: true,
    host: "127.0.0.1",
    tls: false,
    key,
    ...extra,
  });

async function pair(
  url: string,
  pin: string | null,
  headers: Record<string, string> = {},
): Promise<{ status: number; key?: string }> {
  const r = await fetch(`${url}/__aio/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ pin }),
  });
  const text = await r.text();
  let key: string | undefined;
  try {
    key = (JSON.parse(text) as { key?: string }).key;
  } catch { /* 429 is plain text */ }
  return { status: r.status, key };
}

Deno.test("pairing: two apps in one process each pair with their OWN code only", async () => {
  const keyA = `key-a-${crypto.randomUUID()}`;
  const keyB = `key-b-${crypto.randomUUID()}`;
  await using a = await keyed("a", keyA);
  await using b = await keyed("b", keyB);
  try {
    const pinA = currentPin(keyA);
    const pinB = currentPin(keyB);
    assert(pinA && pinB, "each exposed keyed app mints a boot code");
    if (pinA !== pinB) {
      assertEquals(
        (await pair(a.url, pinB)).status,
        401,
        "app B's code must not pair app A",
      );
    }
    const okA = await pair(a.url, pinA);
    assertEquals(okA.status, 200, "A's own boot code must still pair A");
    assertEquals(okA.key, keyA, "and hand out A's key, not B's");
    const okB = await pair(b.url, pinB);
    assertEquals(okB.status, 200, "B's code pairs B");
    assertEquals(okB.key, keyB);
  } finally {
    clearPairing();
  }
});

Deno.test("pairing: wrong guesses from many addresses BURN the code", async () => {
  const key = `key-burn-${crypto.randomUUID()}`;
  // A trusted forwarding header is how a test gets distinct client keys over
  // loopback — and it is also exactly the proxy deployment where every
  // address the server sees is a number an attacker can rotate.
  await using srv = await keyed("burn", key, {
    trustProxyHeader: "x-forwarded-for",
  });
  try {
    const pin = currentPin(key)!;
    const wrong = String((Number(pin) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < MAX_WRONG_TOTAL; i++) {
      const r = await pair(srv.url, wrong, {
        "x-forwarded-for": `10.9.${Math.floor(i / 250)}.${(i % 250) + 1}`,
      });
      assertEquals(r.status, 401, `wrong guess ${i + 1}`);
    }
    const late = await pair(srv.url, pin, { "x-forwarded-for": "10.99.0.1" });
    assertEquals(
      late.status,
      401,
      "after the total budget is spent, the RIGHT code from a fresh address " +
        "must not pair",
    );
    assertEquals(late.key, undefined);
    assertEquals(currentPin(key), null, "the burned code is gone");

    // The owner's recovery is the existing one: mint a new code.
    const fresh = generatePin(key);
    const ok = await pair(srv.url, fresh, { "x-forwarded-for": "10.99.0.2" });
    assertEquals(ok.status, 200, "a re-minted code pairs");
    assertEquals(ok.key, key);
  } finally {
    clearPairing();
  }
});

Deno.test("pairing: wrong codes feed the shared auth-failure budget", async () => {
  const key = `key-ledger-${crypto.randomUUID()}`;
  await using srv = await keyed("ledger", key, {
    trustProxyHeader: "x-forwarded-for",
  });
  try {
    const src = { "x-forwarded-for": "10.77.0.1" };
    // Ten wrong KEYS from one address exhaust the shared budget…
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${srv.url}/`, {
        headers: { authorization: `Bearer wrong-${i}`, ...src },
      });
      await r.body?.cancel();
    }
    // …so that address gets no fresh allowance of PIN guesses, even with
    // the right code.
    const pin = currentPin(key)!;
    assertEquals((await pair(srv.url, pin, src)).status, 429);
    assertEquals(
      currentPin(key),
      pin,
      "a throttled try does not touch the PIN",
    );
  } finally {
    clearPairing();
  }
});
