// One suppression marker, honoured by every checker, with a scope.
//
// There were two, one letter apart (report 3 §8.1). `aiol-ok` worked for the
// project linter and for nothing else; `aio-ok` worked for every script gate.
// Both get placed by copying a nearby line, so the wrong one is SILENT: you
// write `aiol-ok` beside a `check:silent-catch` finding, the gate keeps
// failing, and nothing says the marker was addressed to someone else.
//
// And neither had a scope. `// aio-ok: reason` silenced whichever gate looked
// at that line — including a different finding that lands there later, months
// after the reason was written for something else.
import { assert, assertEquals } from "@std/assert";
import {
  justified,
  justifiedFor,
  justifiedLoose,
} from "../src/diagnostics/ok-marker.ts";

Deno.test("both spellings are the same marker", () => {
  for (const spelling of ["aio-ok", "aiol-ok"]) {
    assert(
      justified(`// ${spelling}: a reason`),
      `${spelling} was not honoured — the one-letter trap is the whole bug`,
    );
    assert(justifiedLoose(`// ${spelling}`), `${spelling} (bare, aiol form)`);
  }
});

Deno.test("a reason is required by the script gates, optional for aiol", () => {
  // The gates have always demanded one; aiol has always accepted a bare
  // marker and dozens of lines in this repo are written that way. Tightening
  // that would be a silent behaviour change for no finding.
  assertEquals(justified("// aio-ok"), false, "a bare marker is not a reason");
  assertEquals(justified("// aio-ok:"), false, "an empty reason is not one");
  assertEquals(justified("// aio-ok: x"), true);
  assertEquals(justifiedLoose("// aio-ok"), true);
});

Deno.test("a scope binds the marker to ONE gate", () => {
  const line = "// aio-ok(silent-catch): the close races teardown";
  assertEquals(justified(line, "silent-catch"), true);
  assertEquals(
    justified(line, "vacuous"),
    false,
    "a reason written for one finding must not cover a different one that " +
      "lands on the same line later",
  );
  // Several, comma separated.
  const two = "// aio-ok(vacuous,dead-wiring): a seam with a literal probe";
  assertEquals(justified(two, "vacuous"), true);
  assertEquals(justified(two, "dead-wiring"), true);
  assertEquals(justified(two, "temp-dirs"), false);
});

Deno.test("an UNSCOPED marker still means what every existing one means", () => {
  // Hundreds of lines in this repo carry the unscoped form. It has to keep
  // silencing whoever is looking, or this change breaks the repo it tidies.
  const line = "// aio-ok: teardown is fire-and-forget by design here";
  for (const rule of ["silent-catch", "vacuous", "dead-wiring", undefined]) {
    assertEquals(justified(line, rule), true, `unscoped failed for ${rule}`);
  }
});

Deno.test("a caller with no name cannot claim a scoped marker", () => {
  // Otherwise a gate that forgot to identify itself silently inherits every
  // scoped suppression in the repo — the over-broad behaviour this replaces.
  assertEquals(justified("// aio-ok(vacuous): x"), false);
  assertEquals(justifiedLoose("// aio-ok(aiol)"), false);
  assertEquals(justifiedLoose("// aio-ok(aiol)", "aiol"), true);
});

Deno.test("every gate that reads a marker reads THIS one", async () => {
  // The point of the module. A gate with its own copy of the regex is exactly
  // how the two spellings diverged, so a new private one is the regression.
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const offenders: string[] = [];
  let scanned = 0;
  for (const dir of ["scripts", "aiol"]) {
    for await (const e of Deno.readDir(`${root}/${dir}`)) {
      if (!e.isFile || !e.name.endsWith(".ts")) continue;
      const text = await Deno.readTextFile(`${root}/${dir}/${e.name}`);
      scanned++;
      // A literal marker pattern of its own, rather than the shared import.
      if (
        /\/\\baiol?-ok\\b/.test(text) && !text.includes("ok-marker.ts")
      ) offenders.push(`${dir}/${e.name}`);
    }
  }
  assert(scanned > 20, `the scan saw only ${scanned} files`);
  assertEquals(
    offenders,
    [],
    "these carry their own marker regex — import justified() from " +
      "src/diagnostics/ok-marker.ts instead, or the two spellings drift apart " +
      "again",
  );
});

Deno.test("justifiedFor: some rules cannot afford an unscoped marker", () => {
  // Found by the gate that exists for it. Routing graph-validator's server-only
  // check through the permissive `justified` let an unscoped
  // `// aio-ok: some other reason` silence a server-only finding — and that
  // function's own test says, in so many words, "a marker for one rule must not
  // quietly cover another". Its neighbours are BLOCKING categories: a
  // guaranteed blank screen, and a silenceable one would be worse than the
  // noise the feature removes.
  assertEquals(
    justifiedFor(
      "// aio-ok(server-only): it only runs on the server",
      "server-only",
    ),
    true,
  );
  assertEquals(
    justifiedFor("// aio-ok: some other reason entirely", "server-only"),
    false,
    "an unscoped marker must NOT reach a rule that requires its own name",
  );
  assertEquals(justifiedFor("// aio-ok(vacuous): x", "server-only"), false);
  assertEquals(
    justifiedFor("// aio-ok(server-only)", "server-only"),
    false,
    "a reason is still required",
  );
  // …while the ordinary gates keep taking the unscoped form, which is what
  // every existing marker in this repo is.
  assertEquals(
    justified("// aio-ok: some other reason entirely", "vacuous"),
    true,
  );
});
