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

// The rule has ONE home now, and this is what replaced the byte-comparison.
//
// The old test read `HARD_SECRET_RE`, `PUBLIC_HINT_RE` and
// `NONSECRET_SUFFIX_RE` out of both `aiol/checks.ts` and
// `src/server/aio-composition.ts` and compared the text. Right instinct, wrong
// mechanism: it could only catch drift after someone wrote the comparison, it
// could not see a difference in how the two USED the same regex — each
// re-assembled the composite `isHardSecret(k) && !PUBLIC_HINT_RE.test(k) &&
// !NONSECRET_SUFFIX_RE.test(k)` by hand — and it made improving the rule a
// two-file edit that a refactor silently broke. Which is what happened: the
// substring fix landed in the runtime and left the linter still refusing to
// lint an app with a field called `passwordless`.
//
// So: neither file may hold a copy, both must reach the one module, and the two
// answers are compared as BEHAVIOUR on the names that actually caused trouble.
Deno.test("credential names: one home, and neither side keeps a copy", async () => {
  for (
    const rel of ["../aiol/checks.ts", "../src/server/aio-composition.ts"]
  ) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    for (
      const name of ["HARD_SECRET_RE", "PUBLIC_HINT_RE", "NONSECRET_SUFFIX_RE"]
    ) {
      assert(
        !new RegExp(`const ${name}\\s*=`).test(src),
        `${rel} declares its own ${name}. The rule lives in ` +
          `src/state/secret-names.ts — a second copy is how the lint and the ` +
          `boot refusal drifted the first time.`,
      );
    }
    assert(
      src.includes("secret-names.ts"),
      `${rel} must reach the shared rule, not re-derive it`,
    );
  }
});

Deno.test("credential names: the lint and the boot agree, name by name", async () => {
  const { isRefusableCredential } = await import(
    "../src/state/secret-names.ts"
  );
  // Must REFUSE — an unambiguous credential broadcast to every client.
  for (
    const k of [
      "apiKey",
      "api_key",
      "API_KEY",
      "privateKey",
      "secretKey",
      "accessToken",
      "authToken",
      "userPassword",
      "passphrase",
      "mnemonic",
    ]
  ) {
    assert(isRefusableCredential(k), `${k} must refuse the boot`);
  }
  // Must NOT — ordinary names that contain a credential word, plus the
  // public-hint and metadata-suffix escapes the runtime already had.
  for (
    const k of [
      "passwordless", // the one that would not boot
      "monkey",
      "keyboard",
      "seedling",
      "privacy",
      "publicKey",
      "pubKey",
      "owner_public_key",
      "apiKeyName",
      "privateKeyId",
      "tokenList",
      "secretSanta",
    ]
  ) {
    assert(!isRefusableCredential(k), `${k} must NOT refuse the boot`);
  }
});
