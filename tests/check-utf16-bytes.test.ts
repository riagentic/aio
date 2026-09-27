// The UTF-16-vs-bytes ratchet must be able to SEE `s.length > MAX_BYTES`.
//
// A string's `.length` is UTF-16 code units; a byte cap is UTF-8 bytes — up to
// 3× apart on non-ASCII text, and identical on every ASCII test fixture. It
// shipped as the am sql result cap (`serialized.length >
// TROJAN_SQL_MAX_RESULT_BYTES`). The scanner is pinned on TEXT: what it must
// catch, what it must not, and that `aio-ok` is honoured.
import { assertEquals } from "@std/assert";
import { scanSource } from "../scripts/check-utf16-bytes.ts";

Deno.test("utf16-bytes gate: it sees the shipped spelling and its variants", () => {
  const r = scanSource(`
    if (serialized.length > TROJAN_SQL_MAX_RESULT_BYTES) refuse();
    if (json.length >= maxBytes) refuse();
    if (MAX_BODY < body.length) refuse();
    if (used + s.length <= opts.limitBytes) take();
    if (frame.length <= sum.bytes * 0.5) patch = frame;
    const over = JSON.stringify(v).length > MAX_BYTES;
  `);
  assertEquals(r.hits, [2, 3, 4, 5, 6, 7]);
});

Deno.test("utf16-bytes gate: byte arrays, byteLength, other limits and prose do not count", () => {
  const r = scanSource(`
    if (bytes.length > MAX_BYTES) refuse();
    if (this.#buf.length > MAX_HEADER_BYTES) refuse();
    if (new TextEncoder().encode(s).length > MAX_BYTES) refuse();
    if (u8.length > MAX_BYTES) refuse();
    if (s.byteLength > MAX_BYTES) refuse();
    if (s.length > MAX_CHARS) refuse();
    if (list.length > 3) refuse();
    const n = s.length; const cap = MAX_BYTES;
    const f = (x: string) => x.length; const g = MAX_BYTES;
    // if (s.length > MAX_BYTES) — prose
    const t = "s.length > MAX_BYTES";
    for (let i = 0; i < a.length; i++) totalBytes += a[i];
  `);
  assertEquals(r.hits, [], JSON.stringify(r.hits));
});

Deno.test("utf16-bytes gate: aio-ok on the line, or the one above, justifies", () => {
  const here = scanSource(
    `if (d.length > MAX_BYTES) no(); // aio-ok(utf16-bytes): d is a Uint8Array`,
  );
  assertEquals(here.hits, []);
  assertEquals(here.justified, 1);
  const above = scanSource(`
    // aio-ok: d is always an ArrayBuffer view here
    if (d.length > MAX_BYTES) no();
  `);
  assertEquals(above.hits, []);
  assertEquals(above.justified, 1);
  assertEquals(
    scanSource(`if (d.length > MAX_BYTES) no(); // aio-ok`).hits.length,
    1,
  );
});
