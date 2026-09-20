// `am link` reported "(pinned in deno.json)" for a pin that lives in the
// git-ignored `.aio/pin.local`. Doctor already got this right, from the same
// reader — the two lines disagreed, and the wrong one is the one a developer
// acts on (they open deno.json and find no pin at all).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { _linkTarget } from "../src/am/am-cmd-link.ts";
import { cmdFix } from "../src/am/am-cmd-fix.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import {
  LOCAL_PIN_FILE,
  readFrameworkPinSync,
} from "../src/server/deno-json.ts";

Deno.test("am link: a path pin names .aio/pin.local, a release pin names deno.json", () => {
  assertStringIncludes(
    _linkTarget({
      pin: "path:/src/aio",
      pinSource: "local",
      root: "/src/aio",
      explicitRoot: false,
    }),
    LOCAL_PIN_FILE,
  );
  assertStringIncludes(
    _linkTarget({
      pin: "v1.2.3",
      pinSource: "deno.json",
      root: "/x",
      explicitRoot: false,
    }),
    "pinned in deno.json",
  );
  assertStringIncludes(
    _linkTarget({
      pin: null,
      pinSource: null,
      root: "/x",
      explicitRoot: true,
    }),
    "--aio override",
  );
  assertStringIncludes(
    _linkTarget({
      pin: null,
      pinSource: null,
      root: "/x",
      explicitRoot: false,
    }),
    "am pin latest",
  );
});

Deno.test("am link: the source it reports is the one THE reader resolved", async () => {
  // End to end through readFrameworkPin — the same predicate doctor uses, so
  // the two commands can never drift apart again.
  const dir = await Deno.makeTempDir({ prefix: "aio-link-pin-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ aioVersion: "v1.2.3" }),
    );
    await Deno.mkdir(join(dir, ".aio"));
    // The reader verifies the target IS a checkout (mod.ts), so point it at
    // this one.
    const checkout = new URL("../", import.meta.url).pathname;
    await Deno.writeTextFile(join(dir, LOCAL_PIN_FILE), checkout + "\n");
    const { pin, source } = readFrameworkPinSync(dir);
    assertEquals(source, "local", "the local override wins over aioVersion");
    const line = _linkTarget({
      pin,
      pinSource: source,
      root: checkout,
      explicitRoot: false,
    });
    assertStringIncludes(line, LOCAL_PIN_FILE);
    assert(
      !line.includes("pinned in deno.json"),
      `deno.json still says v1.2.3 — naming it here is the lie. Got: ${line}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// The same fact, decided twice again — this time between `am fix` and
// `am fix --dry-run`. On an app pinned to a local checkout (`am create
// --mirror`, `am link <path>`, the documented framework-development setup) the
// dry run announced a repair the real run does not make, and named a directory
// that cannot exist:
//
//   dep/aio framework link · would-fix
//     → /home/dev/.local/lib/aio-versions/path:/home/dev/code/aio (was …)
//
// It reached for `versionPath(pin)` — join(versionsDir(), ref) — while the real
// run resolves the pin through `ensureVersion`, which knows a `path:` pin IS
// the checkout. `pinnedFrameworkPath` is the one decider for "where must
// dep/aio point", and a preview that contradicts the run is worse than no
// preview: --dry-run is what a careful person runs BEFORE the repair.
Deno.test("am fix --dry-run: a path-pinned link is already right, not 'would-fix'", async () => {
  const dir = await tempDir("aio-fix-dry-");
  const checkout = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
  const orig = Deno.cwd();
  const realLog = console.log;
  const printed: string[] = [];
  try {
    await Deno.mkdir(join(dir, ".aio"));
    await Deno.mkdir(join(dir, "dep"));
    await Deno.symlink(checkout, join(dir, "dep", "aio"));
    await Deno.writeTextFile(join(dir, LOCAL_PIN_FILE), checkout + "\n");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ name: "fix-dry", imports: { aio: "./dep/aio/mod.ts" } }),
    );
    Deno.chdir(dir);
    console.log = (...a: unknown[]) => printed.push(a.join(" "));
    await cmdFix(["--dry-run"], { json: true } as GlobalFlags);
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
  const doc = JSON.parse(printed.at(-1)!) as {
    results: { name: string; outcome: string; note: string }[];
  };
  const link = doc.results.find((r) => r.name === "dep/aio framework link")!;
  assert(link, `no link check in the report: ${printed.at(-1)}`);
  assert(
    !link.note.includes("path:"),
    `a path pin is a checkout, never a directory inside the version store: ` +
      `${link.note}`,
  );
  assertEquals(
    link.outcome,
    "ok",
    `dep/aio already points at the pinned checkout: ${JSON.stringify(link)}`,
  );
});
