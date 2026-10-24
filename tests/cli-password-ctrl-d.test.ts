// In raw mode the terminal's EOF key (^D) arrives as a byte, not as EOF — so
// `password()` appended it to the secret and returned "\x04" (or "ab\x04")
// on Enter. ^D ends the input, the same as ^C and a closed stdin.
import { assertEquals, assertRejects } from "@std/assert";
import { InputClosedError, password, testIO } from "../src/cli.ts";

Deno.test("cli password: ^D in raw mode is input closed, never part of the secret", async () => {
  for (const input of ["\x04", "ab\x04\r"]) {
    const io = testIO({ input });
    await assertRejects(() => password("Token", { io }), InputClosedError);
    assertEquals(io.raw, [true, false], "raw mode restored");
  }
  assertEquals(
    await password("Token", { io: testIO({ input: "s3\r" }) }),
    "s3",
  );
});
