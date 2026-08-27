// The mutation ledger cannot rot between runs of the gate that uses it.
//
// `deno task check:mutations` breaks each load-bearing invariant on purpose
// and requires a named test to notice. It takes ~30 s, so it is a gate rather
// than a suite member — which leaves a gap: an entry whose enforcing line was
// reworded, or whose test was renamed, quietly stops mutating anything, and
// the gate keeps reporting a kill it never performed.
//
// So the STRUCTURE of the ledger is checked here, in milliseconds, on every
// `deno task test`:
//
//   • the enforcing line still exists, verbatim, exactly once in its file
//   • the mutation actually changes something
//   • the named test file exists and still declares a test by that name
//
// The behaviour — does the test go RED — stays with the gate. This is the
// tripwire that says the gate's questions are still being asked.
import { assertEquals } from "@std/assert";
import { LEDGER } from "../scripts/check-mutations.ts";

const ROOT = new URL("../", import.meta.url).pathname;

/** Every test name declared in a file: `Deno.test("…"`, the object form's
 *  `name: "…"`, and template literals — a name built as
 *  `` `persist (${mode}): …` `` is one `--filter` can still match, so a
 *  `${…}` hole is treated as "anything". */
function declares(src: string, filter: string): boolean {
  const decls = [
    ...src.matchAll(/Deno\.test\(\s*(["'`])((?:[^\\]|\\.)*?)\1/g),
    ...src.matchAll(/\bname:\s*(["'`])((?:[^\\]|\\.)*?)\1/g),
  ];
  return decls.some(([, , name]) => {
    const re = "^" + (name ?? "").split(/\$\{[^}]*\}/)
      .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^`]*") +
      "$";
    return new RegExp(re).test(filter);
  });
}

Deno.test("mutation ledger: every enforcing line still exists, exactly once", async () => {
  const bad: string[] = [];
  for (const m of LEDGER) {
    let src: string;
    try {
      src = await Deno.readTextFile(`${ROOT}${m.file}`);
    } catch {
      bad.push(`${m.what}\n     ${m.file} does not exist any more`);
      continue;
    }
    const n = src.split(m.find).length - 1;
    if (n !== 1) {
      bad.push(
        `${m.what}\n     ${m.file}: the enforcing line occurs ${n} times ` +
          `(must be exactly 1) — it moved or was reworded, so the gate has ` +
          `been mutating nothing. Re-copy it verbatim:\n       ${
            m.find.trim().slice(0, 90)
          }`,
      );
    }
    if (m.replace === m.find) {
      bad.push(
        `${m.what}\n     ${m.file}: \`replace\` is identical to \`find\``,
      );
    }
  }
  assertEquals(bad, [], `\n  ${bad.join("\n\n  ")}\n`);
});

Deno.test("mutation ledger: every named test still exists", async () => {
  const bad: string[] = [];
  const cache = new Map<string, string | null>();
  for (const m of LEDGER) {
    if (!cache.has(m.test)) {
      cache.set(
        m.test,
        await Deno.readTextFile(`${ROOT}${m.test}`).catch(() => null),
      );
    }
    const src = cache.get(m.test);
    if (src === null) {
      bad.push(`${m.what}\n     ${m.test} does not exist any more`);
      continue;
    }
    if (!declares(src!, m.filter)) {
      bad.push(
        `${m.what}\n     ${m.test} no longer declares a test named ` +
          `"${m.filter}" — \`--filter\` would match nothing and the gate ` +
          `would report a kill it never made.`,
      );
    }
  }
  assertEquals(bad, [], `\n  ${bad.join("\n\n  ")}\n`);
});

Deno.test("mutation ledger: an invariant is described by what it costs", () => {
  // The `what` is the whole output of a failure: the reviewer reads it and
  // decides how alarmed to be. "sha256 check" is not a cost; "a tampered zip
  // runs as the user's desktop app" is.
  const thin = LEDGER.filter((m) => m.what.trim().split(/\s+/).length < 8);
  assertEquals(
    thin.map((m) => `${m.file}: ${m.what}`),
    [],
    "each entry's `what` must say what a silent regression COSTS, in a " +
      "sentence — not name the mechanism",
  );
});
