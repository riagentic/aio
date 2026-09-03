#!/usr/bin/env -S deno run --allow-read
// check-log-prefix.ts — one fact, one place, in every framework log line.
//
// The logger prints four columns: timestamp, level, CATEGORY, message. The
// category is not written by the call site — `logger-api.ts` infers it from the
// first non-logger stack frame (inside the framework's `src/` → `aio`, anywhere
// else → `app`). So a message literal that also begins `[aio]` prints the same
// fact twice:
//
//     2026-08-26 23:20:50.948  ERROR  aio         [aio] journal: true asks …
//                                     ^^^                ^^^^^
//
// And the `[aio:<subsystem>]` spellings — twenty different tags across sync,
// air, vdom, electron, vitals, cell, island, cli, schedule, … — are a
// hand-rolled category column beside the real one. The logger already takes a
// category as its first argument:
//
//     log.warn("[aio:sync] rebase dropped an op")   ✗ two categories
//     log.warn("sync", "rebase dropped an op")      ✓ one, in the column
//
// Neither is a cosmetic complaint: a reader filtering `am logs --json` by
// category gets nothing useful from a tag that lives inside the message, and a
// prefix that disagrees with the inferred category is a lie about where a line
// came from. `[aio-dev]`, `[aio-renderer]` and `[AIO]` are the same mistake in
// three more spellings.
//
// Too many sites to convert in one reviewable pass, so — like the swallowed
// errors — they are made COUNTABLE and SHRINKING.
//
// NOT counted: `console.*` calls. The browser has no aio logger and no category
// column, so a tag in the message is the only thing identifying the source
// there; `[aio:virtualList]` on a console.warn is correct as written.

/** Hand-written prefixes on `log.*` calls in `src/`. Only ever edit DOWNWARD.
 *
 *  To lower it: delete a bare `[aio] ` (the column already says it), or move a
 *  `[aio:<tag>] ` into the category argument — `log.warn("<tag>", "…")`. */
const CEILING = 56;

const ROOT = new URL("../src/", import.meta.url).pathname;

async function walk(dir: string, out: string[]): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}${e.name}`;
    if (e.isDirectory) await walk(`${p}/`, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** `log.<level>(` followed by a string literal that opens with an aio tag.
 *  The optional leading `\n` covers the several call sites that begin their
 *  message with a blank line to separate it from the boot banner. */
const PREFIXED =
  /log\.(?:trace|debug|info|warn|error)\(\s*[`"'](?:\\n)*\[(?:aio|AIO)(?::[^\]]*|-[a-z]+)?\]/g;

const files = (await walk(ROOT, [])).sort();
const hits: string[] = [];
for (const file of files) {
  const src = await Deno.readTextFile(file);
  PREFIXED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PREFIXED.exec(src))) {
    hits.push(
      `src/${file.slice(ROOT.length)}:${
        src.slice(0, m.index).split("\n").length
      }`,
    );
  }
}

if (Deno.args.includes("--list")) {
  for (const h of hits) {
    console.log(`  ${h}`);
  }
}

const n = hits.length;
if (n > CEILING) {
  console.error(
    `✗ ${n} log.* calls carry a hand-written [aio…] prefix in src/ (ceiling ${CEILING}).\n` +
      `  The logger already prints the category it inferred from the call site.\n` +
      `    log.warn("[aio] x")          → log.warn("x")\n` +
      `    log.warn("[aio:sync] x")     → log.warn("sync", "x")\n` +
      `  Run with --list to see all of them. Newest:\n` +
      hits.slice(-(n - CEILING)).map((h) => `      ${h}`).join("\n"),
  );
  Deno.exit(1);
}
if (n < CEILING) {
  console.error(
    `✗ ${n} prefixed log.* calls — below the ceiling of ${CEILING}.\n` +
      `  Good. Lower CEILING to ${n} in scripts/check-log-prefix.ts so the\n` +
      `  ground you just gained cannot be given back.`,
  );
  Deno.exit(1);
}
console.log(`✓ log prefixes: ${n} hand-written (ceiling ${CEILING})`);
