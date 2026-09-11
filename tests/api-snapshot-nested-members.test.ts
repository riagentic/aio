// A new optional member brings its own fields with it — that is ONE change.
//
// Member keys in the snapshot are dotted paths, so an optional property whose
// type is an inline object contributes `rect`, `rect.x`, `rect.y`, `rect.w`,
// `rect.h`. Each leaf is required WITHIN the object, and the diff read them as
// five independent additions:
//
//   BREAKING — 4 changes a caller can feel:
//     + UIElementInfo.rect.h added (REQUIRED — every existing caller must change)
//     …
//   additive — 1:
//     + UIElementInfo.rect added (optional)
//
// The verdict is the opposite of the truth. Nobody can hold a `rect`, so nobody
// can be missing `rect.x`; the one change is additive and the policy allows it.
// And it is the worst kind of false red: the gate is the frozen-surface
// promise, its refusal text says there is no approval path, so a false BREAKING
// does not slow someone down — it tells them the additive shape they already
// found is forbidden.
//
// The same on the way out: a removed member takes its subtree with it, and
// listing every leaf turns one removal into a wall of them.
import { assert, assertEquals } from "@std/assert";
import { diffMembers } from "../scripts/api-snapshot.ts";

type Entry = Parameters<typeof diffMembers>[2];

const entry = (
  members: Record<string, string>,
): Entry => ({ sig: "x", members } as unknown as Entry);

/** The digest half is irrelevant here; `opt:`/`req:` is what the diff reads. */
const req = (n: string) => `req:${n}`;
const opt = (n: string) => `opt:${n}`;

Deno.test("adding an optional member with an inline object is ONE additive change", () => {
  const before = entry({ name: req("a"), path: req("b") });
  const after = entry({
    name: req("a"),
    path: req("b"),
    "rect": opt("c"),
    "rect.x": req("d"),
    "rect.y": req("e"),
    "rect.w": req("f"),
    "rect.h": req("g"),
  });
  const changes = diffMembers("./testing", "UIElementInfo", before, after)!;
  assertEquals(
    changes.filter((c) => c.breaking),
    [],
    `a new optional member cannot break a caller who has never seen it: ${
      changes.map((c) => c.line).join(" | ")
    }`,
  );
  assertEquals(changes.length, 1, changes.map((c) => c.line).join(" | "));
  assert(changes[0]!.line.includes("rect added (optional)"));
});

Deno.test("a removed member takes its subtree with it — one line, not five", () => {
  const before = entry({
    name: req("a"),
    "rect": opt("c"),
    "rect.x": req("d"),
    "rect.y": req("e"),
  });
  const after = entry({ name: req("a") });
  const changes = diffMembers("./testing", "UIElementInfo", before, after)!;
  assertEquals(changes.length, 1, changes.map((c) => c.line).join(" | "));
  assertEquals(changes[0]!.breaking, true, "a removal is still breaking");
  assert(changes[0]!.line.includes("rect removed"));
});

Deno.test("a REQUIRED member added on its own is still breaking", () => {
  // The suppression is only for a child of something that also just arrived.
  // Nothing about the real rule is softened.
  const changes = diffMembers(
    "./testing",
    "T",
    entry({ a: req("1") }),
    entry({ a: req("1"), b: req("2") }),
  )!;
  assertEquals(changes.length, 1);
  assertEquals(changes[0]!.breaking, true);
  assert(changes[0]!.line.includes("REQUIRED"));
});

Deno.test("a new required child of an EXISTING member is still breaking", () => {
  // The other half of the same rule, and the case that keeps it honest: the
  // parent was already there, so a caller who has built one is now missing a
  // field.
  const changes = diffMembers(
    "./testing",
    "T",
    entry({ "rect": opt("c"), "rect.x": req("d") }),
    entry({ "rect": opt("c"), "rect.x": req("d"), "rect.z": req("n") }),
  )!;
  assertEquals(changes.length, 1, changes.map((c) => c.line).join(" | "));
  assertEquals(
    changes[0]!.breaking,
    true,
    "the parent already existed, so this really is a field callers must add",
  );
});

Deno.test("a bracketed symbol key is not mistaken for a parent path", () => {
  // `[Symbol.asyncDispose]` contains a dot. Splitting on it names a prefix
  // `[Symbol`, which is never itself a member — so the lookup finds nothing and
  // the key is judged on its own.
  const changes = diffMembers(
    "./testing",
    "T",
    entry({ a: req("1") }),
    entry({ a: req("1"), "[Symbol.asyncDispose]": req("2") }),
  )!;
  assertEquals(changes.length, 1);
  assertEquals(
    changes[0]!.breaking,
    true,
    "a required [Symbol.asyncDispose] is a real addition, not a child of " +
      "some member called `[Symbol`",
  );
});
