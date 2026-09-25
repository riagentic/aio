// `maxHeap: 0` (a number) was refused, but "0GB" / "0MB" / "0%" parsed to 0,
// were floored to the default, and so silently meant "default" — the typo'd
// memory setting parseMaxHeap exists to refuse.
import { assertThrows } from "@std/assert";
import { parseMaxHeap } from "../src/server/heap-policy.ts";

Deno.test("heap: a zero size string is refused like the number 0", () => {
  const ram = 16 * 1024 ** 3;
  for (const v of ["0GB", "0mb", "0 %", "0.0g"]) {
    assertThrows(() => parseMaxHeap(v, ram), Error, "positive", v);
  }
  assertThrows(() => parseMaxHeap(0, ram), Error, "positive");
});
