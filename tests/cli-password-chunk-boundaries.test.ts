// aio/cli password(): "chunk boundaries are invisible" (docs/clients/
// cli-toolkit.md) and readLine keeps "bytes past the newline … for the next
// call, so chunking is invisible" (src/cli/io.ts). password() broke both:
//   • it decoded each 64-byte read with a fresh `dec.decode(chunk)` (no
//     `stream: true`), so a multi-byte character straddling a read boundary
//     became two U+FFFD — a long pasted secret with a non-ASCII char is
//     silently a DIFFERENT secret;
//   • it threw away everything after the Enter in the chunk it was reading,
//     so the answer to the NEXT prompt (typed ahead / piped in one chunk) was
//     lost and that prompt saw EOF.
import { assertEquals } from "@std/assert";
import { password, prompt, testIO } from "../src/cli.ts";

Deno.test("password: a UTF-8 char across a read boundary survives", async () => {
  const secret = "a".repeat(63) + "é"; // é's two bytes straddle byte 64
  const io = testIO({ input: secret + "\n" });
  assertEquals(await password("Token", { io }), secret);
});

Deno.test("password: input after the Enter is kept for the next prompt", async () => {
  const io = testIO({ input: "s3cret\nalice\n" });
  assertEquals(await password("Token", { io }), "s3cret");
  let next: string | Error;
  try {
    next = await prompt("Name", { io });
  } catch (e) {
    next = e as Error;
  }
  assertEquals(next, "alice");
});
