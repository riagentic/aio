// A lone namespace (`JSX`) is read member by member, as `blocking` +
// `blocking.cancel` already was: ADDING a member (`JSX.ElementType`) breaks
// nobody, and the gate used to call it a reshape of the whole namespace —
// refusing the additive fix it exists to allow. Changing or removing a member
// still reads as BREAKING. Pinned against the real `deno doc --json` shape.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  _extractMembersForTest,
  diffMembers,
} from "../scripts/api-snapshot.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

async function membersOf(src: string): Promise<Record<string, string>> {
  const dir = await tempDir("aio-ns-members");
  const file = join(dir, "t.ts");
  await Deno.writeTextFile(file, src);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", file],
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const j = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    nodes: Record<
      string,
      { symbols?: { name: string; declarations: unknown[] }[] }
    >;
  };
  const sym = Object.values(j.nodes).flatMap((f) => f.symbols ?? []).find(
    (n) => n.name === "NS",
  );
  assert(sym, "NS not in the doc graph");
  const m = await _extractMembersForTest(sym.declarations);
  assert(m, "a lone namespace produced no member map");
  return m;
}

const ns = (body: string) =>
  `// deno-lint-ignore no-namespace\nexport namespace NS {\n${body}\n}`;
const diff = (a: Record<string, string>, b: Record<string, string>) =>
  diffMembers(".", "NS", { sig: "x", members: a } as never, {
    sig: "y",
    members: b,
  } as never)!;

Deno.test("adding a member to a lone namespace is additive", async () => {
  const before = await membersOf(ns("export type A = string;"));
  const after = await membersOf(
    ns("export type A = string;\nexport type B = number;"),
  );
  const d = diff(before, after);
  assertEquals(d.filter((c) => c.breaking).map((c) => c.line), []);
  assert(
    d.some((c) => /NS\.B added/.test(c.line)),
    d.map((c) => c.line).join(),
  );
});

Deno.test("changing or removing a member of a lone namespace is BREAKING", async () => {
  const before = await membersOf(
    ns("export type A = string;\nexport type B = number;"),
  );
  const changed = await membersOf(
    ns("export type A = boolean;\nexport type B = number;"),
  );
  const removed = await membersOf(ns("export type A = string;"));
  assert(diff(before, changed).some((c) => c.breaking && /NS\.A/.test(c.line)));
  assert(diff(before, removed).some((c) => c.breaking && /NS\.B/.test(c.line)));
});
