// THE execution-context vocabulary, and the gate that keeps it one vocabulary.
//
// Field report §4.1: "aio has roughly six execution contexts that all look like
// ordinary TypeScript, and almost nothing in the source tells you which one you
// are in. Today the same idea has five spellings across `src/`: `browser` (181
// files), `renderer` (72), `standalone` (44), `isolate` (36), `client context`
// (1 — and it is the clearest of them). A reader cannot build a map from a
// vocabulary that changes per file."
//
// The fix is NOT a rename: each of those words also has a legitimate narrow
// meaning — a build target, a log tag, an Electron process, a thread — and a
// blanket sweep would have destroyed exactly the distinctions that matter. It
// is a single source: when a message means THE CONTEXT it takes the name from
// `src/diagnostics/contexts.ts`, and these tests are what stop a seventh
// spelling from appearing the next time someone writes an error.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  context,
  contextNote,
  CONTEXTS,
  SIDE,
  WHERE_DOC,
  WHERE_HINT,
} from "../src/diagnostics/contexts.ts";
import { whereRules } from "../src/am/am-cmd-where.ts";

const ROOT = join(import.meta.dirname!, "..");

Deno.test("vocabulary: six contexts, each on exactly one side, no duplicates", () => {
  assertEquals(CONTEXTS.length, 6);
  const names = CONTEXTS.map((c) => c.name);
  assertEquals(new Set(names).size, 6, `duplicate name: ${names.join(", ")}`);
  for (const c of CONTEXTS) {
    assert(c.side === "client" || c.side === "server", c.name);
    assert(c.name.length > 0 && c.surprise.length > 0, c.name);
    // A name is used INSIDE a sentence ("you are in a component body"), so it
    // carries its own article and never a capital.
    assert(
      /^(a|an) /.test(c.name),
      `"${c.name}" must read inside a sentence — start it with "a"/"an"`,
    );
  }
  // Tracked reads happen in exactly ONE context. If that ever stops being
  // true, every doc that says "the only tracked window" is wrong.
  assertEquals(CONTEXTS.filter((c) => c.tracked).map((c) => c.name), [
    "a component body",
  ]);
});

Deno.test("vocabulary: a context that does not exist is refused, not returned", () => {
  // The five old spellings are the ones a writer would reach for. None of them
  // is a context, and asking for one has to fail loudly at the call site — a
  // silent `undefined` is how a wrong name reaches a user's terminal.
  for (
    const wrong of [
      "browser",
      "renderer",
      "standalone",
      "isolate",
      "the renderer process",
    ]
  ) {
    assertThrows(
      () => context(wrong),
      Error,
      "is not one of the execution contexts",
      `"${wrong}" must not resolve as a context name`,
    );
  }
  assertEquals(context("a worker isolate").side, "server");
});

Deno.test("vocabulary: there is no helper that guesses which side you are ON", () => {
  // A `youAreIn(name)` existed for a day, rendering the DECLARED side. The
  // first refusal to use it was the hidden-read guard for a sync method
  // replaying in the browser — where the declared side (server) is exactly
  // the wrong answer, and it said so to the reader whose entire problem was
  // that they were in client context.
  //
  // A context's declared side is not always the side it is RUNNING on. Any
  // helper that hides that distinction gets reached for where it does the
  // most damage, so this pins its absence rather than its behaviour.
  const src = Deno.readTextFileSync(
    join(ROOT, "src/diagnostics/contexts.ts"),
  );
  assert(
    !/export function youAreIn/.test(src),
    "a refusal must name the side it OBSERVED, not one derived from the " +
      "context's declaration",
  );
  assert(
    src.includes("There is deliberately NO"),
    "…and the module says why, so it is not re-added next quarter",
  );
});

Deno.test("vocabulary: the docs table IS the module, row for row", () => {
  // The failure this prevents: the table and the code agreeing on the day they
  // were written and drifting after. A doc that teaches names the errors no
  // longer use is worse than no doc, because it is believed.
  const md = Deno.readTextFileSync(join(ROOT, WHERE_DOC));
  // The FIRST table on the page, under its own heading — the page has others
  // (the `am where` verdicts), and a parse that swallowed them would compare
  // the wrong rows and pass for the wrong reason.
  const section = md.slice(md.indexOf("## The six contexts"));
  const rows = section.slice(0, section.indexOf("\n\n", section.indexOf("|")))
    .split("\n")
    .filter((l) => l.startsWith("| ") && !/^\|\s*-/.test(l))
    .map((l) => l.split("|").map((c) => c.trim()).filter(Boolean));
  const body = rows.slice(1); // drop the header
  assertEquals(
    body.length,
    CONTEXTS.length,
    `${WHERE_DOC} must have one row per context`,
  );
  for (const [i, c] of CONTEXTS.entries()) {
    const row = body[i]!;
    assertEquals(row[0], c.name, `row ${i}: name`);
    assertEquals(row[1], SIDE[c.side], `row ${i} (${c.name}): side`);
    assertEquals(row[2], c.reachedBy, `row ${i} (${c.name}): reached by`);
    assertEquals(
      row[3],
      c.deno ? "yes" : "no",
      `row ${i} (${c.name}): Deno.*`,
    );
    assertEquals(
      row[5],
      c.tracked ? "**yes**" : "no",
      `row ${i} (${c.name}): tracked`,
    );
    assertEquals(row[6], c.surprise, `row ${i} (${c.name}): surprise`);
  }
});

Deno.test("vocabulary: `am where` renders from it, never from a second copy", () => {
  // Three renderings of one fact — the docs table, the command, the errors —
  // rather than three claims that happen to agree.
  for (
    const v of [
      "browser-eager",
      "server-only",
      "unreached",
      "browser-deferred",
    ] as const
  ) {
    const r = whereRules(v, false);
    assert(
      r.headline.includes(SIDE.client) || r.headline.includes(SIDE.server),
      `every verdict names its side: ${r.headline}`,
    );
  }
  const server = whereRules("server-only", false);
  const sync = context("a sync method");
  assert(
    server.rules.some((x) => x.includes(sync.surprise)),
    "the sync-method exception is quoted, not paraphrased",
  );
});

Deno.test("vocabulary: no message invents a SIXTH spelling for the side", () => {
  // The specific drift the report measured: one sentence naming three of the
  // five spellings at once ("enforced on ALL client reads (browser and
  // standalone/electron alike)"). Those exact co-occurrences are what a new
  // message must not reintroduce; each word alone stays legal, because each
  // still has a narrow meaning worth keeping.
  const BANNED = [
    /browser and standalone/i,
    /standalone\/electron/i,
    /browser or standalone/i,
    /browser\/electron\/standalone/i,
  ];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of Deno.readDirSync(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        const text = Deno.readTextFileSync(p);
        // COMMENTS are exempt, and deliberately: the module that owns the
        // vocabulary quotes the old sentence to explain what it replaced, and
        // so does the site it was removed from. A rule that cannot tell a
        // message from the note explaining it would delete its own history.
        // Offsets are preserved so a finding still names the real line.
        const code = text
          .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
          .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
        for (const re of BANNED) {
          const m = re.exec(code);
          if (!m) continue;
          const line = code.slice(0, m.index).split("\n").length;
          offenders.push(`${p}:${line} — "${m[0]}"`);
        }
      }
    }
  };
  walk(join(ROOT, "src"));
  assertEquals(
    offenders,
    [],
    `these name the side by listing runtimes instead of calling it ` +
      `"${SIDE.client}" — see src/diagnostics/contexts.ts:\n  ` +
      offenders.join("\n  "),
  );
});

Deno.test("vocabulary: every context refusal can point at the map", () => {
  assert(WHERE_HINT.includes(WHERE_DOC));
  assert(WHERE_HINT.includes("am where"), "the command is the other half");
  Deno.statSync(join(ROOT, WHERE_DOC)); // the doc it names must exist
});

Deno.test("vocabulary: the raw `surprise` field is off limits outside the module", () => {
  // The class, made impossible instead of tested per instance. Every
  // `surprise` is written from inside its OWN context ("reads here do not
  // subscribe"), so interpolating one after a lead-in that already names a
  // context contradicts or repeats itself. Two shipped in one afternoon, in
  // two different files:
  //
  //   a read subscribes ONLY in a component body — reads here do not subscribe
  //   a sync method of a `sync` cell under `sync`/`localFirst` it ALSO runs …
  //
  // Neither was found by reading; both were found by running. So the field is
  // reachable only through `contextNote`, which renders the one shape that
  // always reads — and this is what keeps it that way.
  const ALLOWED = ["src/diagnostics/contexts.ts"];
  const offenders: string[] = [];
  const walk = (dir: string, rel = "") => {
    for (const e of Deno.readDirSync(dir)) {
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) walk(p, r);
      else if (/\.tsx?$/.test(e.name) && !ALLOWED.includes(`src/${r}`)) {
        const text = Deno.readTextFileSync(p);
        const m = /\.surprise\b/.exec(text);
        if (m) {
          offenders.push(
            `src/${r}:${text.slice(0, m.index).split("\n").length}`,
          );
        }
      }
    }
  };
  walk(join(ROOT, "src"));
  assertEquals(
    offenders,
    [],
    `read a context's caveat through \`contextNote(name)\`, never the raw ` +
      `field — it is written from inside its own context and does not compose:\n  ` +
      offenders.join("\n  "),
  );
});

Deno.test("vocabulary: contextNote always names the context it quotes", () => {
  assertEquals(CONTEXTS.length, 6, "an empty table would prove nothing below");
  for (const c of CONTEXTS) {
    const note = contextNote(c.name);
    assert(note.startsWith(c.name), note);
    assert(note.includes(c.surprise), note);
  }
  assertThrows(() => contextNote("browser"));
});

Deno.test("vocabulary: EVERY context refusal points at the map, not just one", () => {
  // Field report §8.4, grading its own §4.2 ask: "one call site of four".
  // `WHERE_HINT` shipped in the hidden-field read and nowhere else, while the
  // three refusals that are the same KIND of event said nothing about context
  // and pointed at no map.
  //
  // Why this outranked the `am where` bug in the reporter's own ranking, and
  // the reason to gate it: "a page you have to know to open, and a command you
  // have to know to run, both require the developer to already suspect that
  // context is the problem. The error message is the only one of the three
  // that arrives without being asked for, at the exact moment the person is
  // wrong about where their code runs."
  const SITES: Array<[file: string, what: string]> = [
    ["src/state/cell-reactive.ts", "a hidden-field read in client context"],
    ["src/state/dispatch.ts", "the dispatch-drain / after-close refusal"],
    ["src/server/graph-validator.ts", "a static *.server.ts import"],
    ["src/state/cell-impl.ts", "the call-ceiling rejection"],
  ];
  const missing: string[] = [];
  for (const [file, what] of SITES) {
    const src = Deno.readTextFileSync(join(ROOT, file));
    if (!src.includes("WHERE_HINT")) missing.push(`${file} — ${what}`);
  }
  assertEquals(
    missing,
    [],
    `these refusals are the same KIND of event and must offer the same way ` +
      `out (\`WHERE_HINT\`, src/diagnostics/contexts.ts):\n  ` +
      missing.join("\n  "),
  );
});

Deno.test("vocabulary: the map is named from ONE constant, never retyped", () => {
  // A path spelled out in an error is a path that rots when the doc moves —
  // and this doc is young enough to move. Every mention outside the module
  // that owns it must come through `WHERE_DOC`/`WHERE_HINT`.
  const offenders: string[] = [];
  const walk = (dir: string, rel = "") => {
    for (const e of Deno.readDirSync(dir)) {
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) walk(p, r);
      else if (
        /\.tsx?$/.test(e.name) && `src/${r}` !== "src/diagnostics/contexts.ts"
      ) {
        const text = Deno.readTextFileSync(p);
        // A literal path, not the constant that carries it.
        if (/["'`][^"'`]*where-code-runs\.md/.test(text)) {
          offenders.push(`src/${r}`);
        }
      }
    }
  };
  walk(join(ROOT, "src"));
  assertEquals(
    offenders,
    [],
    `name the map through WHERE_DOC / WHERE_HINT:\n  ${offenders.join("\n  ")}`,
  );
});
