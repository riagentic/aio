// Docs-completeness gate (roadmap B2): every public export of every deno.json
// entry point must carry a JSDoc comment. _-prefixed / @internal symbols are
// exempt (the api-snapshot gate enforces their tagging).
// Run: deno task docs:coverage

const ROOT = new URL("..", import.meta.url);

// deno-lint-ignore no-explicit-any
type DocDeclaration = Record<string, any>;
type DocSymbol = { name: string; declarations: DocDeclaration[] };

function hasTag(decl: DocDeclaration, tag: string): boolean {
  const tags = decl.jsDoc?.tags as { kind: string }[] | undefined;
  return tags?.some((t) => t.kind === tag) ?? false;
}

function hasDoc(decl: DocDeclaration): boolean {
  const doc = decl.jsDoc?.doc as string | undefined;
  return typeof doc === "string" && doc.trim().length > 0;
}

async function docEntry(path: string): Promise<DocSymbol[]> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", path],
    cwd: ROOT.pathname,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `deno doc --json ${path} failed:\n${new TextDecoder().decode(stderr)}`,
    );
  }
  const parsed = JSON.parse(new TextDecoder().decode(stdout)) as {
    nodes: Record<string, { symbols: DocSymbol[] }>;
  };
  const mod = Object.values(parsed.nodes)[0];
  return mod?.symbols ?? [];
}

const denoJson = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", ROOT)),
) as { exports: Record<string, string> };

let missing = 0;
let total = 0;
for (const [entry, path] of Object.entries(denoJson.exports)) {
  const symbols = await docEntry(path);
  const undocumented: string[] = [];
  for (const sym of symbols) {
    if (sym.name.startsWith("_")) continue;
    const decls = sym.declarations ?? [];
    if (decls.some((d) => hasTag(d, "internal"))) continue;
    total++;
    if (!decls.some(hasDoc)) undocumented.push(sym.name);
  }
  if (undocumented.length) {
    console.error(
      `✗ ${entry} (${path}) — ${undocumented.length} undocumented:`,
    );
    for (const n of undocumented) console.error(`    ${n}`);
    missing += undocumented.length;
  }
}

if (missing) {
  console.error(
    `\n${missing} of ${total} public symbols lack JSDoc. Document them (a one-line /** ... */ is enough).`,
  );
  Deno.exit(1);
}
console.log(`✓ all ${total} public symbols documented`);
