// aiol rule 26 — the static port of aio.run()'s credential-name boot refusal
// (field report §3.5): a display label named `namePrivateKey` refused the boot AFTER
// a green suite, and the override took a docs search. The lint names the field
// and BOTH fixes in one line, and its regexes are pinned to the runtime's.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkCredentialFieldName } from "../aiol/checks.ts";

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
    await checkCredentialFieldName(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const wrap = (body: string) =>
  `import { cell } from "aio";\nexport const c = cell("c", {\n${body}\n});\n`;

Deno.test("aiol: a client-visible credential-named field is an ERROR naming both fixes", async () => {
  const found = await issues({
    "src/c.ts": wrap(
      `  state: { label: "", namePrivateKey: "Private key", n: 0 },
  methods: {},`,
    ),
  });
  assertEquals(found.length, 1, JSON.stringify(found));
  const i = found[0]!;
  assertEquals(i.severity, "error");
  assertEquals(i.line, 2);
  assert(i.message.includes('["namePrivateKey"]'), i.message);
  assert(i.message.includes("REFUSES to boot"), i.message);
  assert(
    i.message.includes('visible: { exclude: ["namePrivateKey"] }'),
    "names the hide fix",
  );
  assert(
    i.message.includes('visible: { publicFields: ["namePrivateKey"] }'),
    "names the override in the SAME line",
  );
});

Deno.test("aiol: every runtime guard is honoured — exclude, publicFields, deep-exclude, public hint, metadata suffix, include, none, client scope", async () => {
  const clean = await issues({
    "src/a.ts": wrap(`  state: { password: "", apiKey: "" },
  visible: { exclude: ["password"], publicFields: ["apiKey"] },
  methods: {},`),
    "src/b.ts": `import { cell } from "aio";
export const b = cell("b", {
  state: { seeds: [{ privateKey: "" }], publicKey: "", apiKeyName: "", ok: 1 },
  visible: { exclude: ["seeds.privateKey"] },
  methods: {},
});
export const d = cell("d", {
  state: { mnemonic: "", n: 0 },
  visible: { include: ["n"] },
  methods: {},
});
export const e = cell("e", {
  state: { mnemonic: "" },
  visible: "none",
  methods: {},
});
export const f = cell("f", {
  state: { password: "" },
  scope: "client",
  methods: {},
});
`,
  });
  assertEquals(clean, []);
});

Deno.test("aiol: soft secret-ish names (bare `secret`, `token`) stay out of the lint — the boot only warns", async () => {
  const clean = await issues({
    "src/c.ts": wrap(`  state: { secret: "", token: "", secretSanta: "" },
  methods: {},`),
  });
  assertEquals(clean, []);
});

Deno.test("aiol: the lint's regexes are byte-identical to aio-composition's (one fact, one spelling)", async () => {
  const lint = await Deno.readTextFile(
    new URL("../aiol/checks.ts", import.meta.url),
  );
  const runtime = await Deno.readTextFile(
    new URL("../src/server/aio-composition.ts", import.meta.url),
  );
  for (
    const name of ["HARD_SECRET_RE", "PUBLIC_HINT_RE", "NONSECRET_SUFFIX_RE"]
  ) {
    const re = new RegExp(`const ${name} =\\s*(/.*?/[a-z]*);`, "s");
    const a = re.exec(lint)?.[1];
    const b = re.exec(runtime)?.[1];
    assert(a && b, `${name} must exist in both files`);
    assertEquals(a, b, `${name} drifted between aiol and the boot refusal`);
  }
});
