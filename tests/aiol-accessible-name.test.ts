// An interactive element with no accessible name has no TEST HANDLE.
//
// aio names UI by LABEL + ROLE: `<div class="button">Submit</div>` is
// `SubmitButton`. An element with no name gets no semantic path, so it is absent
// from `am surface`, unreachable by `am trigger`, and has no handle in `testUI`
// — a framework-specific consequence no general linter can state (report 9 §9.4).
//
// The rule is deliberately NARROW: one line, an empty body, no naming
// attribute. A name can come from a variable, a child component or a multi-line
// body, and none of that is knowable from source. A lint that cries wolf is one
// people learn to pass with `|| true`, and the true positives go with it — so
// the cases below pin the silence as hard as they pin the finding.
import { assert, assertEquals } from "@std/assert";
import { checkUI } from "../aiol/checks.ts";

type Finding = { level: string; area: string; msg: string; fix?: string };

/** Run `checkUI` over one synthetic .tsx file and collect what it says. */
function lintTsx(content: string): Finding[] {
  const found: Finding[] = [];
  // deno-lint-ignore no-explicit-any
  const ctx: any = {
    tsxFiles: [{ relative: "src/App.tsx", ext: ".tsx", content }],
    appTsx: { relative: "src/App.tsx", ext: ".tsx", content },
    cells: [],
    denoJson: { imports: {} },
    report: (
      level: string,
      area: string,
      msg: string,
      opts?: { fix?: string },
    ) => found.push({ level, area, msg, fix: opts?.fix }),
    pass: () => {},
  };
  checkUI(ctx);
  return found.filter((f) => f.msg.includes("accessible name"));
}

Deno.test("aiol: an unnamed interactive element is reported", async (t) => {
  await t.step("an empty <button>", () => {
    const f = lintTsx(
      `export const A = () => <button type="button"></button>;`,
    );
    assertEquals(f.length, 1, "an empty button was not reported");
    assert(
      f[0]!.msg.includes("am trigger"),
      `the message must name the CONSEQUENCE, not just the omission: ${
        f[0]!.msg
      }`,
    );
    assert(
      f[0]!.fix!.includes("t="),
      `the fix must name aio's own escape: ${f[0]!.fix}`,
    );
  });

  await t.step("a bare <input>", () => {
    assertEquals(lintTsx(`const A = () => <input type="text" />;`).length, 1);
  });

  await t.step("<select> and <textarea> too", () => {
    assertEquals(lintTsx(`const A = () => <select></select>;`).length, 1);
    assertEquals(lintTsx(`const A = () => <textarea></textarea>;`).length, 1);
  });
});

Deno.test("aiol: anything that HAS a name is silent", async (t) => {
  const quiet = (src: string, why: string) =>
    assertEquals(lintTsx(src).length, 0, `${why}: ${src}`);

  await t.step("text content names a button", () => {
    quiet(`const A = () => <button type="button">Save</button>;`, "has text");
  });
  await t.step("every naming attribute", () => {
    quiet(`const A = () => <input aria-label="Search" />;`, "aria-label");
    quiet(`const A = () => <input placeholder="Search" />;`, "placeholder");
    quiet(`const A = () => <button t="save"></button>;`, "aio's t prop");
    quiet(`const A = () => <input aria-labelledby="x" />;`, "aria-labelledby");
    quiet(`const A = () => <button title="Save"></button>;`, "title");
  });
  await t.step("an id can be paired with <label htmlFor>", () => {
    // Not visible from this line. A false NEGATIVE is cheap; a false positive
    // is what makes a lint ignorable.
    quiet(`const A = () => <input id="email" />;`, "id + label htmlFor");
  });
  await t.step("a multi-line body is not judged", () => {
    quiet(
      `const A = () => (\n  <button type="button">\n    {label}\n  </button>\n);`,
      "the name may be in the body",
    );
  });
  await t.step("a suppression is honoured", () => {
    quiet(
      `// aio-ok: an icon-only decorative control\nconst A = () => <button></button>;`,
      "aio-ok on the line above",
    );
  });
});

// Code, not text. A `<button></button>` inside a comment, a string or a regex
// literal is not an element; the rule read raw lines and reported all three,
// which is the tax the round set out to remove (1.0.0-beta field report).
Deno.test("aiol: an unnamed element that exists only in a comment, a string or a regex is silent", () => {
  const found = lintTsx(`
// The old markup was <button></button> and nobody missed it.
const example = "<input />";
const re = /<select><\\/select>/;
export default function App() {
  return <button t="go">Go</button>;
}
`);
  assertEquals(found, [], "nothing here is an element");
});
