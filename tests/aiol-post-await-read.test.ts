// `await cell.method()` then reading `cell.field` in the next breath: on a
// browser client the patch may not have landed, so the read returns the
// PREVIOUS value. The method's
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

// ── report 9 §3: the rule could not be discharged at all ────────────────────
//
// Its sibling (a draft read after an await) honours `// aio-ok` and says so;
// this one honoured nothing, in any of six placements. The call site in the
// report was a dev script that IS the server process — no bridge between the
// write and the read, so the rule's premise did not apply and there was no way
// to say so. It was also anchored at the `await`, not at the read it is about
// (where the reader first put the marker), and never mentioned suppression.

const READ_PAIR = (
  above: string,
  onRead: string,
  aboveAwait = "",
  onAwait = "",
) =>
  `import { cart } from "./cart.ts";
export async function pay() {
${aboveAwait ? `  ${aboveAwait}\n` : ""}  await cart.checkout();${
    onAwait ? ` ${onAwait}` : ""
  }
${above ? `  ${above}\n` : ""}  const id = cart.orderId;${
    onRead ? ` ${onRead}` : ""
  }
  return id;
}
`;

for (
  const [where, src] of [
    [
      "`// aio-ok` on the line above the read",
      READ_PAIR("// aio-ok: server process", ""),
    ],
    [
      "`// aio-ok` trailing the read",
      READ_PAIR("", "// aio-ok: server process"),
    ],
    ["`// aiol-ok` on the line above the read", READ_PAIR("// aiol-ok", "")],
    ["`// aiol-ok` trailing the read", READ_PAIR("", "// aiol-ok")],
    [
      "`// aio-ok` on the line above the await",
      READ_PAIR("", "", "// aio-ok: no bridge here"),
    ],
    [
      "`// aio-ok` trailing the await",
      READ_PAIR("", "", "", "// aio-ok: no bridge here"),
    ],
    ["`// aiol-ok` trailing the await", READ_PAIR("", "", "", "// aiol-ok")],
  ] as const
) {
  Deno.test(`aiol post-await read: ${where} suppresses it (report 9 §3)`, async () => {
    assertEquals(await hints(src), []);
  });
}

Deno.test("aiol post-await read: anchored at the READ line, and the message names the marker (report 9 §3)", async () => {
  const found = await hints(`import { cart } from "./cart.ts";
export async function pay() {
  await cart.checkout();

  const id = cart.orderId;
  return id;
}
`);
  assertEquals(found.length, 1, JSON.stringify(found));
  assertEquals(found[0]!.line, 5, "the read, not the await on line 3");
  assert(found[0]!.message.includes("App.tsx:5"), found[0]!.message);
  assert(found[0]!.message.includes("// aio-ok"), "names the suppression");
});

Deno.test("aiol post-await read: a suppressed site does not hide a later genuine one in the same file", async () => {
  const found = await hints(`import { cart } from "./cart.ts";
export async function a() {
  await cart.checkout();
  const id = cart.orderId; // aio-ok: server process
  return id;
}
export async function b() {
  await cart.checkout();
  return cart.orderId;
}
`);
  assertEquals(found.map((f) => f.line), [9], JSON.stringify(found));
});
