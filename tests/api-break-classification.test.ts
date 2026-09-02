// A compat break must not read like an addition.
//
// `check:api` has always DETECTED drift, and always reported every change with
// one verdict: "regenerate with `deno task update:api`, review the diff, and
// commit it." A removed export and a new one printed identically, so the
// additive-only policy — the post-alpha70 insurance, and the standing rule that
// a break needs explicit approval — rested on a person spotting which lines
// were which in an undifferentiated list, at the exact moment the tempting
// thing to do is regenerate and move on.
//
// The snapshot has tracked `@experimental` per symbol all along; nothing used
// it, and no doc mentioned it. It is the escape hatch that makes additive-only
// survivable, so the classifier honours it and the failure message names it.
import { assertEquals } from "@std/assert";
import { diffSnapshots, type Snapshot } from "../scripts/api-snapshot.ts";

const snap = (
  symbols: Record<string, { kind: string; sig: string; experimental?: true }>,
): Snapshot => ({ entries: { ".": { symbols } } }) as unknown as Snapshot;

const stable = { kind: "function", sig: "a" } as const;

Deno.test("api: adding a symbol is additive", () => {
  const d = diffSnapshots(snap({}), snap({ fresh: stable }));
  assertEquals(d.length, 1);
  assertEquals(d[0]!.breaking, false, d[0]!.line);
});

Deno.test("api: removing a stable symbol is BREAKING", () => {
  const d = diffSnapshots(snap({ gone: stable }), snap({}));
  assertEquals(d.length, 1);
  assertEquals(d[0]!.breaking, true, d[0]!.line);
});

Deno.test("api: reshaping a stable symbol is BREAKING", () => {
  const d = diffSnapshots(
    snap({ f: stable }),
    snap({ f: { kind: "function", sig: "b" } }),
  );
  assertEquals(d.length, 1);
  assertEquals(d[0]!.breaking, true, d[0]!.line);
});

Deno.test("api: an @experimental symbol carries no promise — removing it is not a break", () => {
  const exp = { kind: "function", sig: "a", experimental: true } as const;
  const removed = diffSnapshots(snap({ e: exp }), snap({}));
  assertEquals(removed[0]!.breaking, false, removed[0]!.line);
  assertEquals(removed[0]!.experimental, true);
  const reshaped = diffSnapshots(
    snap({ e: exp }),
    snap({ e: { kind: "function", sig: "b", experimental: true } }),
  );
  assertEquals(reshaped[0]!.breaking, false, reshaped[0]!.line);
});

Deno.test("api: promoting out of @experimental is additive; demoting INTO it is a break", () => {
  const exp = { kind: "function", sig: "a", experimental: true } as const;
  // experimental → stable: the promise got STRONGER.
  const promote = diffSnapshots(snap({ f: exp }), snap({ f: stable }));
  assertEquals(promote[0]!.breaking, false, promote[0]!.line);
  // stable → experimental: a promise callers already had is withdrawn.
  const demote = diffSnapshots(snap({ f: stable }), snap({ f: exp }));
  assertEquals(demote[0]!.breaking, true, demote[0]!.line);
});
