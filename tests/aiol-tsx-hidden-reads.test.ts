// aiol rule 25c — a COMPONENT reading a field `visible` hides.
//
// The runtime tripwire throws on any client read of a hidden field, dev and
// prod alike, and it is the guarantee. Rule 25 already names the two cases
// inside the cell literal (a sync method of a replaying cell, any selector).
// This is the third and most common one, and nothing saw it: a read in a `.tsx`
// file, which is client context by construction.
//
// Field report: "a lock screen asked 'does a vault exist?', got `undefined`
// forever, and behaved — in prod, where the warning scrolled past." The same
// report asked for a COMPILE error. That cannot be written: `cell()` returns
// ONE type used identically by a component body and an async method, so
// Omit'ting the excluded keys would refuse every legitimate server-side read
// too. The FILENAME carries the context, so the check goes here.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkTsxHiddenReads } from "../aiol/checks.ts";

async function issues(files: Record<string, string>) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await checkTsxHiddenReads(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const VAULT = `import { cell } from "aio";
export const vault = cell("vault", {
  state: { locked: true, encSecKey: "", hasVault: false },
  visible: { exclude: ["encSecKey"] },
  methods: { unlock(s: { locked: boolean }) { s.locked = false; } },
});
`;

Deno.test("aiol: a component reading a hidden field is an error naming the fix", async () => {
  const found = await issues({
    "src/vault.ts": VAULT,
    "src/App.tsx": `import { vault } from "./vault.ts";
export function App() {
  return <div>{vault.encSecKey ? "has vault" : "no vault"}</div>;
}
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found));
  const i = found[0]!;
  assertEquals(i.severity, "error");
  assertEquals(i.line, 3);
  assert(i.message.includes("vault.encSecKey"), i.message);
  assert(i.message.includes("CLIENT context"), i.message);
  assert(i.message.includes("THROWS"), i.message);
  assert(i.message.includes("hasEncSecKey: boolean"), "names the fact fix");
  assert(i.message.includes("server-side/async"), "names the other fix");
});

Deno.test("aiol: reading the VISIBLE fields of the same cell is fine", async () => {
  // The rule must be about the hidden field, not about the cell. Flagging an
  // ordinary read is how a rule teaches people to ignore it.
  assertEquals(
    await issues({
      "src/vault.ts": VAULT,
      "src/App.tsx": `import { vault } from "./vault.ts";
export function App() {
  return <div>{vault.locked ? "locked" : "open"}{vault.hasVault}</div>;
}
`,
    }),
    [],
  );
});

Deno.test("aiol: the same read in a .ts file is not this rule's business", async () => {
  // A `.ts` file may be server context — a cell method, a route, an effect —
  // where reading the hidden field is exactly right. Only `.tsx` is client by
  // construction; `am where` answers the general case.
  assertEquals(
    await issues({
      "src/vault.ts": VAULT,
      "src/server-side.ts": `import { vault } from "./vault.ts";
export const peek = () => vault.encSecKey.length;
`,
    }),
    [],
  );
});

Deno.test("aiol: a state field that shares the binding's name is not a read", async () => {
  // `s.vault.encSecKey` inside another cell is a STATE path, not a read of the
  // `vault` binding. The lookbehind that prevents this is the difference
  // between a rule people keep and one they suppress.
  assertEquals(
    await issues({
      "src/vault.ts": VAULT,
      "src/App.tsx": `import { cell } from "aio";
const ui = cell("ui", {
  state: { vault: { encSecKey: "local" } },
  methods: { show(s: { vault: { encSecKey: string } }) { return s.vault.encSecKey; } },
});
export function App() {
  return <div>{ui.vault.encSecKey}</div>;
}
`,
    }),
    [],
  );
});

Deno.test("aiol: one finding per field, not one per read", async () => {
  // Three reads of one mistake is one mistake. A rule that reports it three
  // times is a rule people scroll past.
  const found = await issues({
    "src/vault.ts": VAULT,
    "src/App.tsx": `import { vault } from "./vault.ts";
export function App() {
  const a = vault.encSecKey;
  const b = vault.encSecKey;
  return <div>{a}{b}{vault.encSecKey}</div>;
}
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found));
});
