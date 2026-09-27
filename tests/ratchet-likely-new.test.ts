import { assertEquals } from "@std/assert";
import { likelyNew } from "../scripts/ratchet-kit.ts";

// A ceiling gate knows how many hits are over, not which. It named the LAST
// ones in walk order — alphabetical — so a new hit in `am/` was reported as an
// old one in `testing/`, and an `aio-ok` put where the message pointed turned
// the gate green with the new hit still in place.
Deno.test("ratchet: the over-ceiling hits named are the newest file's, not the alphabetically last", () => {
  const hits = [
    { file: "am/new.ts", line: 5 },
    { file: "server/old.ts", line: 9 },
    { file: "testing/old.ts", line: 3632 },
  ];
  const mtime = (f: string) => (f === "am/new.ts" ? 2_000 : 1_000);
  assertEquals(likelyNew(hits, 1, mtime), [{ file: "am/new.ts", line: 5 }]);
  // Ties within one file: the later line first; nothing asked, nothing named.
  assertEquals(
    likelyNew([{ file: "a", line: 1 }, { file: "a", line: 7 }], 1, () => 0),
    [{ file: "a", line: 7 }],
  );
  assertEquals(likelyNew(hits, 0, mtime), []);
});
