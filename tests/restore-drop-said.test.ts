// What restore does NOT bring back is said — at restore, and (dev) already at
// the write that stored it.
//
// Measured before the fix, on a real boot:
//  • `opts: { a: 1 }` declared, a method set `opts.b = 3`: it persisted, then
//    DEV refused to boot and PROD booted without it — while the prod warning
//    said the value "stays on disk (persistence preserves it)". It did not:
//    the first write after boot stored `{ a: 2 }`, and b was gone.
//  • `profile: { name: "default" }` declared, a method set `profile = null`:
//    it restored as `{ name: "default" }` with 0 warnings and was written
//    over. (Documented — a declared object does not take a stored null — so
//    the rule stays; what changed is that it is no longer silent.)
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetParsedCli } from "../src/server/aio-cli.ts";
import {
  restoreDropWatcher,
  shapeDriftRefusal,
  shapeDriftSummary,
} from "../src/server/aio-boot.ts";
import { deepMerge } from "../src/state/deep-merge.ts";

const _argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;
function setMode(mode: "dev" | "prod"): void {
  Object.defineProperty(Deno, "args", {
    value: mode === "prod" ? ["--prod"] : [],
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
}
function restoreArgs(): void {
  Object.defineProperty(Deno, "args", _argsDesc);
  _resetParsedCli();
}

async function captureWarn<T>(fn: () => T | Promise<T>) {
  const lines: string[] = [];
  const orig = { warn: console.warn, error: console.error };
  const cap = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.warn = cap;
  console.error = cap;
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
}

Deno.test("restore: a stored null under a declared object is SAID, naming the path (arrays keep theirs)", async () => {
  const { value, lines } = await captureWarn(() =>
    deepMerge(
      { profile: { name: "default" }, list: [1], n: 0, maybe: null },
      { profile: null, list: null, n: null, maybe: { some: 1 } },
    )
  );
  // The documented rule is unchanged…
  assertEquals(value, {
    profile: { name: "default" },
    list: null,
    n: null,
    maybe: { some: 1 },
  });
  // …and no longer silent, and only the healed path is named.
  const w = lines.filter((l) => l.includes("restore replaced a stored null"));
  assertEquals(w.length > 0, true, lines.join("\n"));
  assert(w[0]!.includes("$.profile"), w[0]);
  assert(!w[0]!.includes("$.list") && !w[0]!.includes("$.maybe"), w[0]);

  const quiet = await captureWarn(() =>
    deepMerge({ profile: { name: "d" } }, { profile: { name: "ada" } })
  );
  assertEquals(
    quiet.lines.filter((l) => l.includes("stored null")).length,
    0,
  );
});

Deno.test("shape drift: the warning no longer claims a dropped field is preserved on disk", () => {
  const drift = [{
    cell: "rt",
    path: "opts.b",
    issue: "unknown-field" as const,
    storedType: "number",
  }];
  const summary = shapeDriftSummary(drift);
  assert(!summary.includes("persistence preserves it"), summary);
  assert(summary.includes("NOT restored"), summary);
  assert(summary.includes("next write replaces them on disk"), summary);
  assert(summary.includes("declare it in `state:`"), summary);
  const refusal = shapeDriftRefusal(drift, summary);
  assert(!refusal.includes("the stale shape is loaded"), refusal);
  assert(refusal.includes("dropped by the first write"), refusal);
  // A stored cell that is no longer declared IS carried verbatim (orphan
  // cells), so it must not be told it was deleted.
  const orphan = shapeDriftSummary([{
    cell: "gone",
    path: "",
    issue: "unknown-cell",
    storedType: "object",
  }]);
  assert(orphan.includes("kept on disk verbatim"), orphan);
  assert(!orphan.includes("NOT restored"), orphan);
});

Deno.test("restoreDropWatcher: names undeclared keys, changed types and null-over-object once per path", () => {
  const warned: string[] = [];
  const watch = restoreDropWatcher(
    {
      rt: { opts: { a: 1 }, count: 0, profile: { name: "d" }, dict: {} },
      migrated: { x: 1 },
    },
    new Set(["migrated"]),
    (m) => warned.push(m),
  );
  const slice = {
    opts: { a: 2, b: 3 },
    count: "7",
    profile: null,
    dict: { anyKey: 1 }, // an open record: its keys are data, never drift
  };
  watch({ rt: slice, migrated: { x: 1, extra: true } });
  assertEquals(warned.length, 3, warned.join("\n"));
  assert(warned.some((w) => w.includes("rt.opts.b (number)")), warned[0]);
  assert(
    warned.some((w) => w.includes("declare `opts` as `{}`")),
    warned.join("\n"),
  );
  assert(
    warned.some((w) =>
      w.includes("rt.count is being written as string") &&
      w.includes("declared number")
    ),
    warned.join("\n"),
  );
  assert(
    warned.some((w) => w.includes("rt.profile is being written as null")),
    warned.join("\n"),
  );
  // the same slice again, and a NEW slice with the same problems: said once
  watch({ rt: slice });
  watch({ rt: { ...slice } });
  assertEquals(warned.length, 3);
});

Deno.test("dev boot: a method writing an undeclared key is named at the WRITE, not first at the next boot", async () => {
  const dir = await Deno.makeTempDir({ prefix: "restore-drop-said-" });
  setMode("dev");
  try {
    const c = cell("rds", {
      state: { opts: { a: 1 } } as Record<string, unknown>,
      methods: {
        addKey(s: Record<string, unknown>) {
          (s.opts as Record<string, unknown>).b = 3;
        },
      },
    });
    const { lines } = await captureWarn(async () => {
      const app = await aio.run({
        cells: [c],
        appId: "restore-drop-said",
        client: "server-only",
        libraryMode: true,
        port: freePort(),
        dbPath: join(dir, "data.db"),
        baseDir: dir,
        persistDebounceMs: 10,
      });
      try {
        await (c as unknown as { addKey: () => Promise<void> }).addKey();
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        await app.close();
      }
    });
    assert(
      lines.some((l) =>
        l.includes("persist (dev): rds.opts.b (number) is being written")
      ),
      lines.join("\n"),
    );
  } finally {
    restoreArgs();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
