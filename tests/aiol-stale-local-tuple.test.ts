// aiol: a `useLocal` tuple value read inside a closure that outlives its
// render (an `onMount` body, a listener it adds, a timer). The tuple copies
// THIS render's value, so `setN(n + 1)` from a window listener counts to one
// and stops — a field report, documented in air-reference.md and caught by
// nothing until this rule.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkStaleLocalTuple } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function issues(src: string) {
  const dir = await tempDir("aiol-stale-local-");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "C.tsx"), src);
    const { ctx, report } = await buildContext(dir);
    await checkStaleLocalTuple(ctx);
    return report.issues.filter((i) => i.message.includes("useLocal"));
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("aiol: the tuple value in an onMount listener is flagged once", async () => {
  const found = await issues(`import { onMount, useLocal } from "aio/air";
export function Clicks() {
  const [n, setN] = useLocal(0);
  onMount(() => {
    const onClick = () => setN(n + 1);
    globalThis.addEventListener("click", onClick);
    setTimeout(() => console.log(n), 10);
  });
  return <p>{n}</p>;
}
`);
  assertEquals(found.length, 1, JSON.stringify(found.map((i) => i.message)));
  assert(found[0]!.message.includes("C.tsx:4"), found[0]!.message);
  assertEquals(found[0]!.severity, "warn");
});

Deno.test("aiol: the correct shapes are not flagged", async () => {
  const found = await issues(`import { onMount, useLocal } from "aio/air";
export function A() {
  const clicks = useLocal(0);
  const [n, setN] = useLocal(0);
  onMount(() => {
    globalThis.addEventListener("click", () => clicks.set((v) => v + 1));
    globalThis.addEventListener("key", () => setN((n) => n + 1));
  });
  return <p onClick={() => setN(n + 1)}>{n}{clicks.local}</p>;
}
`);
  assertEquals(found, [], JSON.stringify(found.map((i) => i.message)));
});
