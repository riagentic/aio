// Insecure-context-safe random id. `crypto.randomUUID()` (and `crypto.subtle`)
// only exist in a SECURE context — https:// or localhost. Over plain http:// to
// a LAN host or the Android emulator (http://10.0.2.2) they're undefined, so any
// client code that called crypto.randomUUID() threw ("not a function") and the
// dispatch silently failed. `crypto.getRandomValues`, however, IS available in
// insecure contexts, so we fall back to it (still cryptographically strong),
// and to Math.random only if even that is missing.

/** A v4-shaped UUID that works in insecure contexts (LAN / emulator dev). */
export function randomUuid(): string {
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();

  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h: string[] = [];
  for (let i = 0; i < 16; i++) h.push(b[i]!.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${
    h[9]
  }-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}
