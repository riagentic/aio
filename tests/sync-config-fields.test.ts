// `sync: { merge }` / `sync: { identity }` are keyed by STATE FIELD, and a key
// that names no field of the cell was accepted in silence.
//
// The engine merges per TOP-LEVEL field: `conflictWork` walks
// `Object.keys(after)` — the cell's own state — and looks each one up in
// `merge`. So `merge: { tag: "set-add" }` on a cell whose field is `tags`, or
// `merge: { "profile.tags": "set-add" }` (a nested path, which nothing ever
// walks), matches nothing: the field resolves last-write-wins, which is
// exactly the outcome `sync-config-values.test.ts` refuses a typo'd STRATEGY
// for — "lost data, later, on someone else's machine" — reached through the
// other half of the same entry.
//
// WARNED, not thrown, and for a reason the throwing checks do not have: a
// method may introduce a top-level field the declared state does not list, so
// a refusal could be wrong about a cell that works. An app that boots today
// keeps booting; it just stops being quiet about it. Same rule in dev and in
// prod — the log level is the only thing observe-only here.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

/** Warnings logged while `fn` runs. */
function warnings(fn: () => void): string[] {
  const got: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") got.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    fn();
  } finally {
    setLogger(prev);
  }
  return got;
}

Deno.test("sync: a merge key that names no state field is warned, and the cell still builds", () => {
  let built: unknown;
  const got = warnings(() => {
    built = cell("sync-typo-merge", {
      state: { tags: [] as string[], title: "" },
      sync: { merge: { tag: "set-add" } },
      methods: { touch(_s: { title: string }) {} },
    });
  });
  assertEquals(got.length, 1, got.join("\n"));
  assertStringIncludes(got[0]!, "sync-typo-merge");
  assertStringIncludes(got[0]!, `merge["tag"]`);
  assertStringIncludes(got[0]!, "last-write-wins");
  // …and it names the near miss, so the fix is one line away.
  assertStringIncludes(got[0]!, `"tags"`);
  assertEquals(typeof built, "object", "the cell still exists");
});

Deno.test("sync: a NESTED merge path is warned — merging is per top-level field", () => {
  const got = warnings(() => {
    cell("sync-nested-merge", {
      state: { profile: { tags: [] as string[] } },
      sync: { merge: { "profile.tags": "set-add" } },
      methods: { touch(_s: unknown) {} },
    });
  });
  assertEquals(got.length, 1, got.join("\n"));
  assertStringIncludes(got[0]!, `merge["profile.tags"]`);
  assertStringIncludes(got[0]!, "TOP-LEVEL");
  assertStringIncludes(got[0]!, `"profile"`);
});

Deno.test("sync: an identity key that names no state field is warned", () => {
  const got = warnings(() => {
    cell("sync-typo-identity", {
      state: { items: [] as { id: string }[] },
      sync: { merge: { items: "set-add" }, identity: { itmes: "uuid" } },
      methods: { touch(_s: unknown) {} },
    });
  });
  assertEquals(got.length, 1, got.join("\n"));
  assertStringIncludes(got[0]!, `identity["itmes"]`);
  assertStringIncludes(got[0]!, `"items"`);
});

Deno.test("sync: a config that names real fields says nothing", () => {
  // The other direction — a check that warns about everything would pass the
  // tests above and shout at every correct app.
  const got = warnings(() => {
    cell("sync-config-ok", {
      state: { items: [] as { id: string }[], count: 0, body: "" },
      sync: {
        merge: { items: "set-add", count: "counter", body: "text" },
        // identity ALONE on a field is a documented shape
        // (tests/local-first.test.ts) — it is the FIELD NAME that is checked.
        identity: { items: "uuid" },
      },
      methods: { touch(_s: unknown) {} },
    });
    // `sync: true` has nothing to check.
    cell("sync-config-bare", {
      state: { n: 0 },
      sync: true,
      methods: { touch(_s: unknown) {} },
    });
  });
  assertEquals(got, []);
});
