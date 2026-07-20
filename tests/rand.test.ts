import { assert, assertMatch } from "@std/assert";
import { randomUuid } from "../src/rand.ts";

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

Deno.test("randomUuid: valid v4 + unique", () => {
  const a = randomUuid();
  const b = randomUuid();
  assertMatch(a, V4);
  assertMatch(b, V4);
  assert(a !== b, "ids must be unique");
});

Deno.test("randomUuid: works without crypto.randomUUID (insecure context)", () => {
  // Emulate http:// LAN / emulator, where randomUUID/subtle are absent but
  // getRandomValues remains — the exact case that broke dispatch.
  const c = globalThis.crypto as Crypto & { randomUUID?: unknown };
  const saved = c.randomUUID;
  try {
    // deno-lint-ignore no-explicit-any
    delete (c as any).randomUUID;
    const id = randomUuid();
    assertMatch(id, V4);
  } finally {
    // deno-lint-ignore no-explicit-any
    (c as any).randomUUID = saved;
  }
});
