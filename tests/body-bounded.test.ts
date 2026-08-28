// A request body is bounded by the bytes that ARRIVE, never by the length the
// sender declared. Those are different numbers whenever the sender wants them
// to be, and every route in src/server/ used to trust the second one.
//
// Two ways that went wrong, both live before `read-body.ts`:
//   `Number("abc") > MAX` is false, so an unparseable Content-Length satisfied
//   the cap; and declaring 10 while sending 10 GB satisfied it honestly.
// In both cases the guard passed and an unbounded `req.text()` ran anyway.
import { assertEquals } from "@std/assert";
import {
  CONTROL_MAX_BODY,
  declaresOverLimit,
  readBounded,
  SNAPSHOT_MAX_BODY,
} from "../src/server/read-body.ts";

/** A POST whose Content-Length says one thing and whose body does another.
 *  `Request` will not compute a length for a stream, so the header is exactly
 *  and only what we put there — which is the point. */
function lying(declared: string | null, bodyBytes: number): Request {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(bodyBytes).fill(65));
      c.close();
    },
  });
  const headers = new Headers();
  if (declared !== null) headers.set("content-length", declared);
  return new Request("http://x/y", { method: "POST", body, headers });
}

Deno.test("body cap: a body that lies about its length is still cut off", async () => {
  const req = lying("10", 64 * 1024);
  // The early-out believes the header, and is meant to: it is an optimisation,
  // not the bound. It says "nothing to refuse yet".
  assertEquals(declaresOverLimit(req, 4096), false);
  // The bound is what actually holds.
  assertEquals(await readBounded(req, 4096), null);
});

Deno.test("body cap: an unparseable Content-Length does not pass the cap", async () => {
  // `Number("abc") > MAX` is false — the shape that let garbage through.
  const req = lying("abc", 64 * 1024);
  assertEquals(declaresOverLimit(req, 4096), false);
  assertEquals(await readBounded(req, 4096), null);
});

Deno.test("body cap: no Content-Length at all is read, not refused", async () => {
  // A chunked body has no length to declare. The old pairing guard turned that
  // into a 413 for every such client; the header's absence was never the risk.
  const req = lying(null, 16);
  assertEquals(declaresOverLimit(req, 4096), false);
  assertEquals((await readBounded(req, 4096))?.length, 16);
});

Deno.test("body cap: an honestly over-declared body is refused before reading", async () => {
  const req = lying(String(9 * 1024 * 1024), 8);
  assertEquals(declaresOverLimit(req, CONTROL_MAX_BODY), true);
});

Deno.test("body cap: a body exactly at the limit is allowed", async () => {
  // Off-by-one on a cap is how a legitimate payload starts failing in the
  // field, so the boundary is pinned rather than assumed.
  assertEquals((await readBounded(lying(null, 4096), 4096))?.length, 4096);
  assertEquals(await readBounded(lying(null, 4097), 4096), null);
});

Deno.test("body cap: an empty body reads as empty, never null", async () => {
  // `null` means REFUSED. A GET with no body must not look like a refusal.
  const req = new Request("http://x/y", { method: "GET" });
  assertEquals(await readBounded(req, 4096), "");
});

Deno.test("body cap: the snapshot cap is one fact", () => {
  // server-trojan.ts and server-static.ts each used to declare their own
  // 10_000_000. Two spellings of one number is how they drift apart.
  assertEquals(SNAPSHOT_MAX_BODY, 10_000_000);
  for (const f of ["server-trojan.ts", "server-static.ts"]) {
    const src = Deno.readTextFileSync(`src/server/${f}`);
    // Not "the literal 10_000_000 is absent" — `TROJAN_SQL_MAX_RESULT_BYTES`
    // is a genuinely different cap that happens to share the value, and a
    // gate that cannot tell those apart teaches people to edit the gate.
    // The claim is narrower: this name is DEFINED from the shared one.
    assertEquals(
      /=\s*10_?0{6}/.test(
        src.replace(/TROJAN_SQL_MAX_RESULT_BYTES[^\n]*/g, ""),
      ),
      false,
      `${f} spells the snapshot cap itself instead of importing it`,
    );
  }
});
