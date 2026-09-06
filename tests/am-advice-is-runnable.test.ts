// A command inside an error message is a promise: type it and it should work.
//
// The "Already running" refusal said `am stop <id>` for a long time, and that
// command answers "this project declares no components" and stops nothing
// (fixed separately). The same class, mechanically: a message naming a verb
// that `am` refuses. Two were live — an error that opened with `am tt goto`
// (removed in alpha70, so the CLI answers "`am tt` is spelled `am timetravel`
// now" — an error inside an error), and `definePlugin` pointing at
// `am plugins`, which has never been a command at all.
//
// The command list is read from `am help` itself, so this cannot drift from
// what `am` actually accepts.
import { assert } from "@std/assert";
import { REMOVALS } from "../src/state/removals.ts";

const ROOT = new URL("..", import.meta.url).pathname;

async function liveCommands(): Promise<Set<string>> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${ROOT}src/am.ts`, "help", "--all"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  const cmds = new Set<string>();
  for (const m of text.matchAll(/^\s{2}([a-z][a-z-]+)/gm)) cmds.add(m[1]!);
  return cmds;
}

/** Prose that is ABOUT a retired spelling, not advice to run it. */
const ABOUT_A_REMOVAL =
  /removed|is spelled|used to|no longer|retired|alpha\d+|renamed|supersede/i;

Deno.test("every `am <verb>` a message suggests is a verb am accepts", async () => {
  const commands = await liveCommands();
  // The verbs that USED to work are the ones that linger in messages, and
  // they are enumerable — the registry `am` itself answers from. Scoping to
  // them is exact: a prose sentence that happens to start with the word "am"
  // ("`am does not know which app…") can never be one of these, so the guard
  // needs no heuristic about what looks like a command.
  const retired = new Set(
    REMOVALS.filter((r) => r.kind === "am-verb").map((r) => r.key),
  );
  assert(retired.size >= 5, `read ${retired.size} retired am verbs`);
  assert(retired.has("tt") && retired.has("log"), "registry sanity");
  // VERIFY THE INSTRUMENT: an empty/short list would make this vacuous.
  assert(
    commands.size > 30,
    `read ${commands.size} commands from \`am help\` — the parse broke`,
  );
  assert(commands.has("timetravel") && commands.has("logs"), "sanity");

  const offenders: string[] = [];
  let scanned = 0;
  async function walk(dir: string, exts: RegExp): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) {
        await walk(p, exts);
        continue;
      }
      if (!exts.test(e.name)) continue;
      // the registry of removed spellings must name them; so must its tests
      if (p.includes("removals")) continue;
      // Release notes are a HISTORICAL record: alpha24 really did say
      // `am update`, and rewriting that would falsify the history rather than
      // fix advice. `.katana/docs.md` exempts them for the same reason.
      if (/RELEASE_NOTES|release-notes/.test(p)) continue;
      // Dated design specs are the same kind of record: `docs/specs/2026-07-26-…`
      // proposes `am update-app`, which is a DESIGN, not advice to a user
      // standing at a shell today.
      if (p.includes("/docs/specs/")) continue;
      // …and so are the upgrade guides: `from-alpha29-to-alpha30.md` says
      // `am update` because that is what that upgrade actually required. A
      // migration guide is a record of a moment, and editing it would make it
      // lie about the version it documents.
      if (p.includes("/docs/upgrade/")) continue;
      scanned++;
      const text = await Deno.readTextFile(p);
      const lines = text.split("\n");
      lines.forEach((l, i) => {
        const t = l.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
          return;
        }
        // In PROSE a sentence about a removal can wrap ("The older commands
        // (`am interact`,\n`am dom`) were removed" is one sentence, two
        // lines), so markdown reads a small window. Source does NOT: a
        // neighbouring comment explaining why a spelling was fixed would
        // otherwise silence the very line it explains — which is exactly what
        // happened to the first version of this guard, and the mutation test
        // is what said so.
        const scope = p.endsWith(".md")
          ? lines.slice(Math.max(0, i - 1), i + 2).join(" ")
          : l;
        if (ABOUT_A_REMOVAL.test(scope)) return;
        // An INLINE CODE SPAN — `am foo …` closed on the same line, short,
        // and free of sentence punctuation. A
        // backtick that merely OPENS a template literal whose sentence starts
        // with the word "am" ("`am does not know which app…`) is prose, not a
        // command, and matching it made this test cry wolf five times.
        for (const m of l.matchAll(/`am ([a-z][a-z-]+)/g)) {
          const verb = m[1]!;
          if (!retired.has(verb)) continue; // prose, or a live verb
          if (commands.has(verb)) continue; // re-added under the old name
          offenders.push(`${p}:${i + 1}  am ${verb}   ${t.slice(0, 80)}`);
        }
      });
    }
  }
  await walk(`${ROOT}src`, /\.tsx?$/);
  await walk(`${ROOT}docs`, /\.md$/);
  assert(scanned > 100, `only ${scanned} files scanned — the walk broke`);

  assert(
    offenders.length === 0,
    `these name an \`am\` verb that was REMOVED — the CLI answers "is spelled` +
      ` … now", so the reader gets an error inside an error. Run it and see:\n${
        offenders.join("\n")
      }`,
  );
});
