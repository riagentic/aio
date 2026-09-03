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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  aliasTarget,
  cliSurface,
  diffSnapshots,
  helpEntryVerbs,
  releaseChannel,
  type Snapshot,
} from "../scripts/api-snapshot.ts";

const snap = (
  symbols: Record<
    string,
    { kind: string; sig: string; experimental?: true; alias?: string }
  >,
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

// ── the symbols that were never pinned at all ───────────────────────
//
// `deno doc` describes some `export const` declarations as bare
// `{"kind":"const"}` — no type, no value. Digesting that produced ONE hash
// (`1588a0f075829371`) shared by ten public exports, which in the snapshot
// reads exactly like a real signature. `export const jsxs = jsx` carried it,
// so a change to `jsx()`'s signature could never have been caught through
// `jsxs`. When deno 2.9.6 started describing those aliases properly, the gate
// called the improvement "BREAKING" and told the release to get a compat break
// approved for a promise that had just got STRONGER.
const UNPINNED_LEGACY = { kind: "variable", sig: "1588a0f075829371" } as const;
const UNPINNED = { kind: "variable", sig: "unpinned" } as const;

Deno.test("api: 'unpinned' and the legacy placeholder hash are the same non-promise", () => {
  assertEquals(
    diffSnapshots(snap({ f: UNPINNED_LEGACY }), snap({ f: UNPINNED })),
    [],
  );
  assertEquals(
    diffSnapshots(snap({ f: UNPINNED }), snap({ f: UNPINNED_LEGACY })),
    [],
  );
});

Deno.test("api: an unpinned symbol gaining a real signature is additive, and says so", () => {
  for (const before of [UNPINNED_LEGACY, UNPINNED]) {
    const d = diffSnapshots(
      snap({ jsxs: before }),
      snap({ jsxs: { kind: "function", sig: "abc", alias: "jsx" } }),
    );
    assertEquals(d.length, 1);
    assertEquals(d[0]!.breaking, false, d[0]!.line);
    assertStringIncludes(d[0]!.line, "now carries a real signature");
    assertStringIncludes(d[0]!.line, "an alias of jsx");
  }
});

Deno.test("api: a symbol LOSING its signature is a break — the gate stops watching it", () => {
  const d = diffSnapshots(snap({ f: stable }), snap({ f: UNPINNED }));
  assertEquals(d.length, 1);
  assertEquals(d[0]!.breaking, true, d[0]!.line);
  assertStringIncludes(d[0]!.line, "became UNPINNED");
});

Deno.test("api: an alias resolves to its target's initializer, and a real value does not", () => {
  const src = [
    "export const jsxs = jsx;",
    "export const plainWidth = width;",
    "const inner = other;",
    "export const Fragment = Symbol('f');",
    "export const arrow = (x: number) => x;",
  ].join("\n");
  assertEquals(aliasTarget(src, "jsxs"), "jsx");
  assertEquals(aliasTarget(src, "plainWidth"), "width");
  assertEquals(aliasTarget(src, "inner"), "other");
  // A real value is not an alias — `Fragment` must stay unpinned rather than
  // borrowing a signature it does not have.
  assertEquals(aliasTarget(src, "Fragment"), null);
  assertEquals(aliasTarget(src, "arrow"), null);
  assertEquals(aliasTarget(src, "absent"), null);
});

// ── Member level ─────────────────────────────────────────────────────
//
// A whole-declaration digest cannot tell an ADDED optional config key from a
// RENAMED one: both flip the hash, both printed "signature changed", both read
// BREAKING. Since adding an optional key is the most common legitimate change
// there is, the gate's alarm was usually noise — and the only way past a
// failing gate is `update:api`, which erases the record of what changed. A
// freeze beta must hold until 1.0 cannot rest on an alarm nobody believes.

/** A symbol carrying member digests. `sig` differs from the committed side in
 *  every case below, because a member change always flips the whole digest —
 *  that is what sends the diff down the member-level path. */
const withMembers = (
  sig: string,
  members: Record<string, string>,
): { kind: string; sig: string; members: Record<string, string> } => ({
  kind: "typeAlias",
  sig,
  members,
});

const memberDiff = (
  before: Record<string, string>,
  after: Record<string, string>,
) =>
  diffSnapshots(
    snap({ C: withMembers("a", before) } as never),
    snap({ C: withMembers("b", after) } as never),
  );

Deno.test("api: adding an OPTIONAL member is additive", () => {
  const d = memberDiff({ a: "opt:1" }, { a: "opt:1", b: "opt:2" });
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, false, d[0]!.line);
  assertStringIncludes(d[0]!.line, "C.b added (optional)");
});

Deno.test("api: adding a REQUIRED member is BREAKING", () => {
  const d = memberDiff({ a: "opt:1" }, { a: "opt:1", b: "req:2" });
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, true, d[0]!.line);
  assertStringIncludes(d[0]!.line, "REQUIRED");
});

Deno.test("api: removing a member is BREAKING", () => {
  const d = memberDiff({ a: "opt:1", b: "opt:2" }, { a: "opt:1" });
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, true, d[0]!.line);
  assertStringIncludes(d[0]!.line, "C.b removed");
});

Deno.test("api: a rename is one removal plus one addition, so it BREAKS", () => {
  const d = memberDiff({ showStatus: "opt:1" }, { showState: "opt:1" });
  assertEquals(d.length, 2, JSON.stringify(d));
  assertEquals(d.filter((c) => c.breaking).length, 1, JSON.stringify(d));
  assertStringIncludes(
    d.find((c) => c.breaking)!.line,
    "C.showStatus removed",
  );
});

Deno.test("api: a member whose TYPE changed is BREAKING", () => {
  const d = memberDiff({ a: "opt:1" }, { a: "opt:2" });
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, true, d[0]!.line);
  assertStringIncludes(d[0]!.line, "type changed");
});

Deno.test("api: optional↔required both BREAK — a reader relies on presence", () => {
  for (
    const [from, to, word] of [
      ["opt:1", "req:1", "REQUIRED"],
      ["req:1", "opt:1", "OPTIONAL"],
    ] as const
  ) {
    const d = memberDiff({ a: from }, { a: to });
    assertEquals(d.length, 1, JSON.stringify(d));
    assertEquals(d[0]!.breaking, true, d[0]!.line);
    assertStringIncludes(d[0]!.line, word);
  }
});

Deno.test("api: an appended optional param is additive; a shifted one is not", () => {
  const appended = memberDiff(
    { param0: "req:1", return: "req:9" },
    { param0: "req:1", param1: "opt:2", return: "req:9" },
  );
  assertEquals(appended.length, 1, JSON.stringify(appended));
  assertEquals(appended[0]!.breaking, false, appended[0]!.line);

  // Positional keys handle insertion for free: put a parameter in the middle
  // and every position after it changes type. Here param0 changes type AND
  // optionality and the tail gains a required position — three things a caller
  // feels, none of them additive. Verified end to end against the real
  // `bindCell`, which reports exactly this shape.
  const inserted = memberDiff(
    { param0: "req:1", return: "req:9" },
    { param0: "opt:2", param1: "req:1", return: "req:9" },
  );
  assertEquals(
    inserted.filter((c) => c.breaking).length,
    3,
    JSON.stringify(inserted),
  );
  assertEquals(inserted.filter((c) => !c.breaking).length, 0);
});

Deno.test("api: a changed digest no member explains is still reported", () => {
  // The member map does not cover every corner of a declaration. When it
  // cannot name the change, the gate must not print a clean diff.
  const d = memberDiff({ a: "opt:1" }, { a: "opt:1" });
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, true, d[0]!.line);
  assertStringIncludes(d[0]!.line, "signature changed");
});

Deno.test("api: an older snapshot without members keeps the blunt verdict", () => {
  const d = diffSnapshots(
    snap({ C: { kind: "typeAlias", sig: "a" } }),
    snap({ C: withMembers("b", { a: "opt:1" }) } as never),
  );
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, true, d[0]!.line);
  assertStringIncludes(d[0]!.line, "signature changed");
});

Deno.test("api: @experimental still carries no promise at member level", () => {
  const d = diffSnapshots(
    snap(
      {
        C: {
          ...withMembers("a", { a: "opt:1", b: "opt:2" }),
          experimental: true,
        },
      } as never,
    ),
    snap(
      {
        C: { ...withMembers("b", { a: "opt:1" }), experimental: true },
      } as never,
    ),
  );
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, false, d[0]!.line);
});

// ── The freeze ───────────────────────────────────────────────────────

Deno.test("api: only an alpha version may break; beta onward is frozen", () => {
  assertEquals(releaseChannel("1.0.0-alpha76"), "alpha");
  assertEquals(releaseChannel("1.0.0-alpha100"), "alpha");
  assertEquals(releaseChannel("1.0.0-beta1"), "frozen");
  assertEquals(releaseChannel("1.0.0-rc1"), "frozen");
  assertEquals(releaseChannel("1.0.0"), "frozen");
  assertEquals(releaseChannel("1.2.3"), "frozen");
});

// ── The command line is surface too ──────────────────────────────────
//
// A flag spelling is a promise: `deno.json` tasks, Dockerfiles, systemd units
// and CI jobs all name flags, and none of them type-check. `deno doc` cannot
// see any of it, so the only guard used to be a test asserting each flag was
// DOCUMENTED — which stays green when a flag is renamed in both places at once.

Deno.test("cli: the snapshot locks flags AND `am` verbs", () => {
  const cli = cliSurface();
  // A parse that came back short would un-guard the whole command line
  // silently; the builder treats that as a violation, so pin the floor here
  // too rather than trusting a number nobody looks at.
  assert(
    Object.keys(cli).length >= 60,
    `only ${Object.keys(cli).length} spellings parsed`,
  );
  assertEquals(cli["aio --takeover"], { kind: "flag", sig: "bool" });
  assertEquals(cli["aio --port"], { kind: "flag", sig: "value" });
  assertEquals(cli["am persist"], { kind: "verb", sig: "verb" });
  // The runtime's own `--__aio-…` flags are not anyone's to depend on.
  assertEquals(Object.keys(cli).filter((k) => k.includes("--__")), []);
});

Deno.test("cli: renaming a flag reads as a removal, not a rewrite", () => {
  const before = { "aio --takeover": { kind: "flag", sig: "bool" } };
  const after = { "aio --take-over": { kind: "flag", sig: "bool" } };
  const d = diffSnapshots(snap(before as never), snap(after as never));
  assertEquals(d.filter((c) => c.breaking).length, 1, JSON.stringify(d));
  assertStringIncludes(d.find((c) => c.breaking)!.line, "--takeover");
});

Deno.test("cli: a bool flag that starts needing a value BREAKS", () => {
  const d = diffSnapshots(
    snap({ "aio --takeover": { kind: "flag", sig: "bool" } } as never),
    snap({ "aio --takeover": { kind: "flag", sig: "value" } } as never),
  );
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, true, d[0]!.line);
});

Deno.test("cli: help verbs are the indented entry words, not their sub-words", () => {
  const verbs = helpEntryVerbs(
    "Onboard:\n  create <name>  Scaffold\n  auth users  Manage\n    nested\n  help\n",
  );
  assertEquals(verbs.sort(), ["auth", "create"]);
});

// A parameter that accepts strictly MORE is the one "signature changed" that
// no caller can feel — and it is the change a config option grows by
// constantly (`theme: string` becoming `string | Theme`). Reported as
// BREAKING, it made the gate cry wolf on ordinary additive work, and the only
// way past a failing gate is `update:api`, which erases the record.
//
// Parameters only: for a property the identical change is additive for
// something an app WRITES and breaking for something it READS, and the
// snapshot cannot tell which.
const PART_BOOL = "aaaaaaaaaaaaaaaa~boolean";
const PART_AUTO = 'bbbbbbbbbbbbbbbb~"auto"';

Deno.test("api: a widened PARAMETER is additive, and names what it gained", () => {
  const d = memberDiff(
    { param0: `req:d1|${PART_BOOL}` },
    { param0: `req:d2|${PART_BOOL}+${PART_AUTO}` },
  );
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, false, d[0]!.line);
  assertStringIncludes(d[0]!.line, 'widened — it now also accepts "auto"');
});

Deno.test("api: the same change NARROWED is still BREAKING", () => {
  const d = memberDiff(
    { param0: `req:d2|${PART_BOOL}+${PART_AUTO}` },
    { param0: `req:d1|${PART_BOOL}` },
  );
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, true, d[0]!.line);
  assertStringIncludes(d[0]!.line, "type changed");
});

Deno.test("api: swapping one branch for another is not a widening", () => {
  const other = "cccccccccccccccc~string";
  const d = memberDiff(
    { param0: `req:d1|${PART_BOOL}` },
    { param0: `req:d3|${other}+${PART_AUTO}` },
  );
  assertEquals(d[0]!.breaking, true, d[0]!.line);
});

Deno.test("api: a widened PROPERTY stays BREAKING — variance is unknowable", () => {
  const d = memberDiff({ theme: "opt:d1" }, { theme: "opt:d2" });
  assertEquals(d.length, 1, JSON.stringify(d));
  assertEquals(d[0]!.breaking, true, d[0]!.line);
});

Deno.test("api: the COMMITTED snapshot really carries parameter parts", () => {
  // The tests above feed member maps directly, so they prove the rule and not
  // the extraction. Without this, deleting the line that attaches parts leaves
  // every one of them green while the gate silently loses the ability to see a
  // widening at all — the same "verify the instrument" hole this whole file
  // exists to close.
  const snap = JSON.parse(
    Deno.readTextFileSync(
      new URL("../docs/api-snapshot.json", import.meta.url),
    ),
  ) as Snapshot;
  const m = snap.entries["./air"]?.symbols["setDevMode"]?.members;
  const p0 = m?.["param0"] ?? "";
  assertStringIncludes(p0, "|");
  assertEquals(
    p0.slice(p0.indexOf("|") + 1).split("+").length,
    2,
    `setDevMode(enabled: boolean | "auto") should record two parts: ${p0}`,
  );
});
