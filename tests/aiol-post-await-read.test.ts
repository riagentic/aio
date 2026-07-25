// `await cell.method()` then reading `cell.field` in the next breath: on a
// browser client the patch may not have landed, so the read returns the
// PREVIOUS value (risoto 2026-07-26 — "almost always the bug"). The method's
// return value crosses the bridge; use it.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkPostAwaitRead } from "../aiol/checks.ts";

async function hints(source: string) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "cart.ts"),
      `import { cell } from "aio";
export const cart = cell("cart", {
  state: { orderId: "", items: [] },
  methods: { checkout(s: { orderId: string }) { s.orderId = "x"; return "x"; } },
});
`,
    );
    await Deno.writeTextFile(join(dir, "src", "App.tsx"), source);
    const { ctx, report } = await buildContext(dir);
    await checkPostAwaitRead(ctx);
    return report.issues.filter((i) => i.message.includes("right after"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("aiol: reading a cell field right after awaiting its method is hinted", async () => {
  const found = await hints(`import { cart } from "./cart.ts";
export async function pay() {
  await cart.checkout();
  const id = cart.orderId;   // ← may still be the old value on a client
  return id;
}
`);
  assertEquals(found.length, 1, JSON.stringify(found));
  assert(found[0]!.message.includes("cart.orderId"), found[0]!.message);
  assert(found[0]!.message.includes("return value"), "names the fix");
});

Deno.test("aiol: using the RETURN value instead is not hinted", async () => {
  const clean = await hints(`import { cart } from "./cart.ts";
export async function pay() {
  const id = await cart.checkout();   // the value crosses the bridge
  return id;
}
`);
  assertEquals(clean, []);
});

Deno.test("aiol: awaiting something that isn't a cell is not hinted", async () => {
  const clean = await hints(
    `export async function pay(api: { charge(): Promise<string> }) {
  await api.charge();
  const x = api.charge;
  return x;
}
`,
  );
  assertEquals(clean, []);
});
