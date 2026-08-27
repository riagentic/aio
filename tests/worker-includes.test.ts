/**
 * EVERY worker `deno compile` cannot trace must be in the include list.
 *
 * `new Worker(new URL("./x.ts", import.meta.url))` is invisible to the module
 * graph, so a compiled binary carries the module only if something passed
 * `--include` for it. `db-worker.ts` learned this the hard way (field report
 * #7, `tests/db-worker-include.test.ts`); `blocking-worker.ts` — behind the
 * PUBLIC `blocking()` in `mod.ts` — repeated it, and was in no include list at
 * all. Reproduced: compile a program that calls `blocking()`, remove the source
 * tree, run the binary elsewhere →
 *
 *   error: Uncaught (in worker "") Module not found: …/blocking-worker.ts
 *
 * It passes on the build box only because the VFS falls through to the real
 * file still sitting at the same absolute path — so this is a bug that ships
 * green and dies in the user's hands.
 *
 * A per-worker test would have caught the same bug twice and the third one not
 * at all. This is the CLASS: enumerate the untraceable workers in `src/` from
 * the source itself, and assert each is embedded.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, relative, resolve } from "@std/path";
import { dbWorkerInclude } from "../src/build.ts";
import { blockingWorkerMissingHint } from "../src/state/blocking.ts";

const SRC = resolve(join(import.meta.dirname ?? ".", "..", "src"));

/** `new URL("<relative>.ts", import.meta.url)` — the untraceable specifier. */
const MODULE_URL = /new URL\(\s*"(\.[^"]+\.ts)"\s*,\s*import\.meta\.url\s*\)/g;

/** Every module in `src/` that is loaded as a Worker via a module-relative
 *  URL, as an absolute path. Read from the source, so a worker added tomorrow
 *  is in this list tomorrow. */
async function untraceableWorkers(): Promise<string[]> {
  const found = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const full = join(dir, e.name);
      if (e.isDirectory) {
        await walk(full);
      } else if (e.isFile && e.name.endsWith(".ts")) {
        const src = await Deno.readTextFile(full);
        // Only files that actually construct a Worker. `new URL(…,
        // import.meta.url)` is also how assets are located, and those are
        // `assetIncludes`' problem, not this one.
        if (!/new Worker\(/.test(src)) continue;
        for (const m of src.matchAll(MODULE_URL)) {
          found.add(fromFileUrl(new URL(m[1]!, new URL(`file://${full}`))));
        }
      }
    }
  };
  await walk(SRC);
  return [...found].sort();
}

Deno.test("every Worker module deno compile cannot trace is in the include list", async () => {
  const workers = await untraceableWorkers();
  // Two today (db-worker, blocking-worker). If this drops to zero the scanner
  // has stopped seeing the thing it exists to see.
  assert(
    workers.length >= 2,
    `the scanner found ${workers.length} worker module(s) in src/ — it should ` +
      `see at least db-worker.ts and blocking-worker.ts. The pattern it ` +
      `matches (${MODULE_URL.source}) has probably changed.`,
  );

  const args = dbWorkerInclude();
  const embedded = new Set(
    args.filter((_, i) => args[i - 1] === "--include").map((p) => resolve(p)),
  );

  for (const w of workers) {
    assert((await Deno.stat(w)).isFile, `${w} does not exist`);
    assert(
      embedded.has(resolve(w)),
      `${
        relative(SRC, w)
      } is started with new Worker(new URL(…)), which deno compile cannot ` +
        `trace, and NOTHING passes --include for it. Every binary that ` +
        `reaches this code path dies in the user's hands with ` +
        `"Module not found: …/${w.split("/").pop()}" — and passes on the ` +
        `build box, where the source file is still on disk.\n` +
        `  FIX: add \`new URL("${
          "../" + relative(SRC, w).split("\\").join("/")
        }", import.meta.url)\` to the worker list in dbWorkerInclude() ` +
        `(src/build/build-compile.ts).`,
    );
  }
});

Deno.test("the include list points at files that exist, in pairs", async () => {
  const args = dbWorkerInclude();
  assertEquals(args.length % 2, 0, "--include args come in pairs");
  for (let i = 0; i < args.length; i += 2) {
    assertEquals(args[i], "--include");
    // An --include of a wrong path is accepted by deno compile and only fails
    // in the user's hands.
    assert(
      (await Deno.stat(args[i + 1]!)).isFile,
      `${args[i + 1]} does not exist`,
    );
  }
});

Deno.test("blocking-worker.ts stays self-contained (nothing for the include to miss)", async () => {
  // The include embeds ONE module. If the worker ever grows an import, that
  // import rides along only because deno compile traces the worker's own
  // graph from the included file — which it does. What it must never grow is
  // a second `new Worker(new URL(…))` hop, invisible all over again.
  const src = await Deno.readTextFile(
    join(SRC, "state", "blocking-worker.ts"),
  );
  assert(!/new Worker\(/.test(src), "no worker-spawns-worker hop");
});

Deno.test("blocking: a missing worker module is CLASSIFIED, not a bare Module-not-found", () => {
  // Until the module is embedded, the failure reaches the user as a path
  // inside /tmp/deno-compile-… naming a file they have never heard of. Same
  // failure and same answer as db-worker.ts.
  const raw =
    'Module not found "file:///tmp/deno-compile-myapp/src/state/blocking-worker.ts".';
  const hint = blockingWorkerMissingHint(raw);
  assert(hint, "recognised");
  assertStringIncludes(hint, "--include");
  assertStringIncludes(hint, "blocking-worker.ts");
  assertStringIncludes(hint, "aio/build");
  assertStringIncludes(hint, "schedule.blocking()");
  // The original survives — the hint explains it, it does not hide it.
  assertStringIncludes(hint, raw);
  // …and it must not send the reader down the two dead ends.
  assert(!hint.includes("Fix permissions"));
  assertStringIncludes(hint, "NOT a permissions problem");
});

Deno.test("blocking: unrelated worker failures keep their own message", () => {
  assertEquals(blockingWorkerMissingHint("worker crashed: boom"), null);
  assertEquals(
    blockingWorkerMissingHint('Module not found "file:///app/other.ts".'),
    null,
    "a Module-not-found for something else is NOT this bug",
  );
  assertEquals(blockingWorkerMissingHint(""), null);
});
