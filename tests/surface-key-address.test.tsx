// A list key containing `/` made a whole page unaddressable.
//
// Field report (cc, a file-tree UI): surface paths join their segments with `/`
// and wrap a key in `[…]`, so a row keyed by an absolute path produced
//
//     App/TreePage/TreeRow[/home/dev/tmp/cc/src]:SrcButton
//
// "…which nothing can parse back." An absolute path is the NATURAL key for a
// file tree — it IS the row's identity — so this is a shape apps keep arriving
// at, and the reporter had to re-key their rows to make the page driveable.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { getLiveSurfaces, runUITrigger } from "../src/air/ui-remote.ts";

function Row({ path }: { path: string }) {
  return <button t="Open">{path}</button>;
}
const PATHS = ["/home/dev/tmp/cc/src", "/home/dev/tmp/cc/tests"];
const Tree = () => <div>{PATHS.map((p) => <Row key={p} path={p} />)}</div>;

/** Every component path in the live surface, flattened. */
function paths(): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    const node = n as {
      path?: string;
      children?: unknown[];
      elements?: { path: string }[];
    };
    if (node.path) out.push(node.path);
    for (const e of node.elements ?? []) out.push(e.path);
    for (const c of node.children ?? []) walk(c);
  };
  for (const r of getLiveSurfaces()) walk(r);
  return out;
}

testUI(Tree, "surface: a `/` in a key never reaches the address", (_ui) => {
  const rows = paths().filter((p) => p.includes("Row["));
  assertEquals(rows.length, 4, `two rows, each with its button: ${rows}`);
  for (const p of rows) {
    // The grammar is `A/B[key]:element`. A `/` inside the key breaks every
    // reader of it — `--path=` prefix matching, the surface tree, a person.
    const key = p.slice(p.indexOf("[") + 1, p.indexOf("]"));
    assert(
      !key.includes("/") && !key.includes("]"),
      `the key must not carry a path separator into the address: ${p}`,
    );
    // …and it is still legible: the original is recoverable.
    assertStringIncludes(decodeURIComponent(key), "/home/dev/tmp/cc/");
  }
  // The segment count is now meaningful — this is what "parse it back" means.
  assertEquals(rows[0]!.split("/").length, 2, rows[0]);
});

testUI(Tree, "surface: the escaped address DRIVES the row", async (_ui) => {
  // The fix is worth nothing if the address it prints cannot be pasted back.
  const target = paths().find((p) => p.includes("Row[") && p.endsWith(":Open"));
  assert(target, `expected an addressable row button; got ${paths()}`);
  const r = await runUITrigger({ path: target, action: "click" });
  assertEquals(r.ok, true, `the printed address must resolve: ${r.error}`);
});

function Plain({ n }: { n: number }) {
  return <span t="v">{String(n)}</span>;
}
const Plains = () => <div>{[1, 2].map((n) => <Plain key={n} n={n} />)}</div>;

testUI(
  Plains,
  "surface: an ordinary key is byte-identical to before",
  (_ui) => {
    // Encoding only the three characters that break the grammar is what makes
    // this a fix rather than a rename: every address that worked still works,
    // and every test pinning one still passes.
    const rows = paths().filter((p) => p.includes("Plain["));
    assert(rows.includes("Plains/Plain[1]"), rows.join(" · "));
    assert(rows.includes("Plains/Plain[1]:v"), rows.join(" · "));
    // The key itself is untouched — no `%` anywhere in an ordinary address.
    assert(
      rows.every((r) => !r.includes("%")),
      `a key with nothing to escape must not be encoded: ${rows.join(" · ")}`,
    );
  },
);
