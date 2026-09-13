// The documented dispatch ceiling must be the one the code enforces.
//
// `dispatch.ts` records a deliberate 1,000 → 10,000 change (a legitimate
// 1,500-action cascade was being rejected). Neither doc followed, and
// `check:docs` does not read prose numbers — so an author sizing a bulk
// cascade against the documented 1,000 got the wrong budget in BOTH
// directions: they would throttle work that was fine, and be surprised by a
// refusal ten times later than they expected.
//
// Pinned against the constant rather than against a number typed here, so the
// next deliberate change to the ceiling updates the docs or fails.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

Deno.test("docs: the DISPATCH_LOOP ceiling matches dispatch.ts", async () => {
  const src = await Deno.readTextFile(`${ROOT}src/state/dispatch.ts`);
  const m = /const QUEUE_MAX = ([\d_]+);/.exec(src);
  assert(m, "QUEUE_MAX must be readable from dispatch.ts");
  const max = Number(m[1]!.replace(/_/g, ""));
  assertEquals(max > 0, true);

  // Every spelling a doc might use for the same number.
  const spellings = [
    String(max), // 10000
    max.toLocaleString("en-US"), // 10,000
  ];

  for (
    const doc of [
      "docs/debugging/errors.md",
      "docs/debugging/troubleshooting.md",
    ]
  ) {
    const text = await Deno.readTextFile(`${ROOT}${doc}`);
    const line = text.split("\n").find((l) => l.includes("DISPATCH_LOOP"));
    assert(line, `${doc} must document DISPATCH_LOOP`);
    assert(
      spellings.some((s) => line.includes(s)),
      `${doc} states a ceiling the code does not enforce (QUEUE_MAX is ` +
        `${max}):\n  ${line.trim()}`,
    );
  }
});
