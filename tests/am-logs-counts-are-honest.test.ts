// `am logs --level=error --json | jq .total` is named in `am-cmd-inspect.ts`
// as "the natural health probe, and the reason `--level`/`--tag` were added".
// It could not answer the question it exists for.
//
// `logEventMatches` deliberately KEEPS an event whose head it cannot parse —
// "dropping what we cannot classify is how a filter comes to hide the one line
// that mattered" — and that is right for the output. It was wrong for the
// COUNT: every `deno` `Initialize npm:…` write has no aio header, so the probe
// read 28 on an app with zero errors and disagreed with `am errors`, which
// said none. The file records the same probe reading 1 for the same reason
// once before; the empty-line phantom was fixed and the general case was not.
//
// The fix is additive — `total` and `shown` keep their meaning for every
// script already reading them, and `matched`/`unclassified` are what a health
// probe wants. They add up.
import { assert, assertEquals } from "@std/assert";
import { logEventMatches } from "../src/am/am-cmd-inspect.ts";

const AIO_ERROR = ["2026-09-12 18:00:00.000+02:00  ERROR  aio  it broke"];
const AIO_INFO = ["2026-09-12 18:00:00.000+02:00  INFO   aio  all fine"];
const RAW = ["Initialize immer@10.2.0"];
const RAW2 = ["Add npm:happy-dom@17.6.3"];

Deno.test("am logs: an unclassifiable line is KEPT by the filter", () => {
  // This is the deliberate half, and it must not change: a stack frame or a
  // raw write must survive a filter, or the filter hides what mattered.
  assertEquals(
    logEventMatches(RAW, { level: "error" }),
    true,
    "a line with no aio header must still be shown",
  );
  assertEquals(logEventMatches(RAW, { tag: "nosuchtag" }), true);
});

Deno.test("am logs: an aio line is filtered by level, as documented", () => {
  assertEquals(logEventMatches(AIO_ERROR, { level: "error" }), true);
  assertEquals(
    logEventMatches(AIO_INFO, { level: "error" }),
    false,
    "an INFO line is not an error",
  );
});

// The counts. `matched` is the number a health check means; `unclassified` is
// what the filter kept because it could not read it; together they are total.
Deno.test("am logs: the counts separate what matched from what was merely kept", async () => {
  const { logEventHead } = await import("../src/am/am-cmd-inspect.ts");
  const events = [AIO_INFO, RAW, RAW2, AIO_INFO];
  const kept = events.filter((e) => logEventMatches(e, { level: "error" }));
  const classified = kept.filter((e) => logEventHead(e[0] ?? "") !== null);

  assertEquals(
    kept.length,
    2,
    "the two unreadable lines are kept, the two INFO lines are filtered out",
  );
  assertEquals(
    classified.length,
    0,
    "…and NONE of what was kept is actually an error — which is the number " +
      "a health probe must read, and the number it did not",
  );
  assert(
    kept.length !== classified.length,
    "if these were equal the distinction would be pointless",
  );
});
