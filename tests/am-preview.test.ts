// `am preview <file> --export=Name --props=JSON`.
//
// Checking a component in a state the app does not currently have meant
// driving the whole app into that state — a dispatch, a fixture, sometimes a
// login — or writing a throwaway script with happy-dom, a document and an
// import in it (report 3 §12.5). Neither is a thing anyone does while iterating
// on an empty state or an error card.
//
// The render is the SAME path `am surface` and `am testgen` use, so what is
// tested here is the two things `preview` adds: reading props off a command
// line, and printing what came back in the vocabulary `am trigger` takes.
import { assert, assertEquals } from "@std/assert";
import { parsePreviewProps, previewLines } from "../src/am/am-cmd-preview.ts";
import type { UISurfaceNode } from "../src/air/ui-surface.ts";

Deno.test("no --props is an empty object, not an error", () => {
  const r = parsePreviewProps(undefined);
  assert(r.ok && Object.keys(r.props).length === 0);
});

Deno.test("a non-OBJECT is refused, because it would render as no props at all", () => {
  // `--props=42` parses as JSON and then spreads into nothing, so the
  // component renders with every prop undefined — which looks exactly like
  // the bug the author is hunting.
  for (const raw of ["42", '"hi"', "null", "true", '["a"]']) {
    const r = parsePreviewProps(raw);
    assert(!r.ok, `${raw} must be refused`);
    assert(r.error.includes("OBJECT"), r.error);
  }
});

Deno.test("bad JSON says it is bad JSON, and how shells eat quotes", () => {
  const r = parsePreviewProps('{title:"x"}');
  assert(!r.ok);
  assert(r.error.includes("not valid JSON"), r.error);
  assert(r.error.includes("single-quote"), `the shell tip: ${r.error}`);
});

Deno.test("an empty --props= is refused rather than silently ignored", () => {
  const r = parsePreviewProps("");
  assert(!r.ok);
  assert(r.error.includes("omit the flag"), r.error);
});

const node = (
  component: string,
  elements: Array<
    Partial<{ name: string; tag: string; text: string; value: string }>
  >,
  children: UISurfaceNode[] = [],
  extra: Partial<UISurfaceNode> = {},
): UISurfaceNode =>
  ({
    component,
    path: component,
    text: "",
    elements: elements.map((e) => ({
      name: e.name ?? "x",
      tag: e.tag ?? "div",
      events: [],
      text: e.text ?? "",
      ...(e.value !== undefined ? { value: e.value } : {}),
    })),
    children,
    ...extra,
  }) as UISurfaceNode;

Deno.test("elements print in the form `am trigger` takes", () => {
  // A preview that printed a different vocabulary would be one more thing to
  // translate by hand, every time.
  const lines = previewLines([
    node("Card", [
      { name: "title", tag: "h2", text: "Inbox" },
      { name: "act", tag: "button", text: "Go" },
    ]),
  ]);
  assert(lines.some((l) => l.includes("Card:title")), lines.join("\n"));
  assert(lines.some((l) => l.includes("Card:act")), lines.join("\n"));
  assert(lines.some((l) => l.includes("<button>")), "the tag is useful");
  assert(lines.some((l) => l.includes("Inbox")), "and so is the text");
});

Deno.test("a value is shown, because an input with the wrong one looks right", () => {
  const lines = previewLines([
    node("Form", [{ name: "email", tag: "input", value: "a@b.c" }]),
  ]);
  assert(lines.some((l) => l.includes('value="a@b.c"')), lines.join("\n"));
});

Deno.test("children are walked, and a `t` handle is shown beside the name", () => {
  const lines = previewLines([
    node("Page", [], [node("Row", [{ name: "go" }], [], { handle: "first" })]),
  ]);
  assert(lines.some((l) => l.includes("Row (t=first)")), lines.join("\n"));
  assert(lines.some((l) => l.includes("Row:go")), lines.join("\n"));
});

Deno.test("`preview` is findable in help by what it DOES", async () => {
  // The round's meta-finding: an agent greps `am help` for its own word and
  // composes primitives when it does not find it. RENDER is that word here.
  const { HELP_TEXT } = await import("../src/am/am-help-text.ts");
  assert(HELP_TEXT.includes("preview <file>"), "the command must be listed");
  assert(/RENDER/.test(HELP_TEXT), "…as an intent word");
  assert(HELP_TEXT.includes("--props="), "and its flags");
});
