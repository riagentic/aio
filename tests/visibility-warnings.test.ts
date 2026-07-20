// Dev-safety warnings for field-level visibility config (risoto #1/#2):
// non-top-level filter keys are silent no-ops; secret-looking exposed fields
// are likely leaks. Both must warn loudly at compose time.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";

// deno-lint-ignore no-explicit-any
type AnyEntry = Parameters<typeof composeCellsWiring>[0]["cellEntries"];

function warningsFor(entries: AnyEntry): string[] {
  setLogger(null); // force console fallback so we can capture
  const out: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  try {
    composeCellsWiring({ cellEntries: entries });
  } finally {
    console.log = orig;
  }
  return out.filter((l) => l.includes("WARN") && l.includes("visibility"));
}

Deno.test("visibility #1: exclude key that isn't a top-level field warns", () => {
  const c = cell("wallet", {
    state: { accounts: [] as { encSecKey: string }[] },
    methods: { noop(_s) {} },
  });
  // Simulate a nested key slipping past the types (loose state shape / a cast) —
  // `encSecKey` lives under accounts[], not top-level, so the filter is a no-op.
  (c.__aio as { ui?: unknown }).ui = { exclude: ["encSecKey"] };
  const w = warningsFor([c]);
  assert(
    w.some((l) => l.includes("encSecKey") && l.includes("not a top-level")),
    `expected a top-level warning; got: ${w.join(" | ")}`,
  );
});

Deno.test("visibility #1: a valid top-level exclude does NOT warn", () => {
  const c = cell("wallet2", {
    state: { encSecKey: "x", pub: "y" },
    ui: { exclude: ["encSecKey"] }, // top-level — legit
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assertEquals(
    w.filter((l) => l.includes("not a top-level")).length,
    0,
  );
});

Deno.test("visibility #4: public/id fields do NOT trip the secret heuristic", () => {
  // risoto #4: the name heuristic over-fired on public keys and id/type fields.
  const c = cell("wallet_pub", {
    state: {
      activeAccountPubKey: "", // public key — "pub" hint
      publicKey: "",
      seedId: 0, // identifier, not the seed
      seedPathType: "", // metadata suffix
      keyName: "", // Name suffix
    },
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assertEquals(
    w.filter((l) => l.includes("looks secret")).length,
    0,
    `no field here is a secret; got: ${w.join(" | ")}`,
  );
});

Deno.test("visibility #4: soft-secret-looking fields still WARN (encSecKey)", () => {
  // Ambiguous secret-ish names stay a warning, not a hard failure.
  const c = cell("wallet_soft", {
    state: { encSecKey: "cipher", pub: "y" },
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assert(
    w.some((l) => l.includes("encSecKey") && l.includes("looks secret")),
    `expected encSecKey warned; got: ${w.join(" | ")}`,
  );
});

Deno.test("visibility (AIO-426): an exposed credential REFUSES to boot in dev", () => {
  // inews Ugly #6: a warning is too soft for an unambiguous credential.
  for (const field of ["privateKey", "mnemonic", "apiKey", "password"]) {
    const c = cell("cred_" + field.toLowerCase(), {
      state: { [field]: "leak", ok: 1 },
      methods: { noop(_s: Record<string, unknown>) {} },
    });
    const err = assertThrows(
      () => composeCellsWiring({ cellEntries: [c] as never }),
      Error,
    );
    assert(
      /SECURITY/.test(err.message) && err.message.includes(field),
      `expected a SECURITY refusal naming ${field}; got: ${err.message}`,
    );
  }
});

Deno.test("visibility (AIO-426): a credential that's excluded or declared public boots fine", () => {
  const excluded = cell("cred_excl", {
    state: { password: "x", ok: 1 },
    ui: { exclude: ["password"] },
    methods: { noop(_s) {} },
  });
  const publicOk = cell("cred_pub", {
    state: { apiKey: "public-token", ok: 1 },
    ui: { publicFields: ["apiKey"] },
    methods: { noop(_s) {} },
  });
  // Neither should throw.
  warningsFor([excluded]);
  warningsFor([publicOk]);
});

Deno.test("visibility: a deep-excluded container no longer warns (risoto 10/10)", () => {
  // The correct fix (deep-exclude the secret sub-path) must NOT re-arm the
  // secret heuristic on the container field.
  const c = cell("seedvault", {
    state: { seeds: [] as { encSeed: string }[], seedNextId: 0 },
    ui: { exclude: ["seeds.encSeed"] },
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assertEquals(
    w.filter((l) => l.includes("looks secret")).length,
    0,
    `deep-excluded container should not warn; got: ${w.join(" | ")}`,
  );
});

Deno.test("visibility: ui.publicFields explicitly silences the heuristic", () => {
  const c = cell("navcell", {
    state: { masterKey: "public-id", n: 0 },
    ui: { publicFields: ["masterKey"] },
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assertEquals(w.filter((l) => l.includes("looks secret")).length, 0);
});

Deno.test("visibility #2: a secret-looking exposed field warns", () => {
  const c = cell("wallet3", {
    state: { encSecKey: "cipher", pub: "y" },
    // ui defaults to "all" → encSecKey broadcast to clients
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assert(
    w.some((l) => l.includes("encSecKey") && l.includes("looks secret")),
    `expected a secret-exposure warning; got: ${w.join(" | ")}`,
  );
});

Deno.test("visibility #2: excluding the secret field silences the warning", () => {
  const c = cell("wallet4", {
    state: { encSecKey: "cipher", pub: "y" },
    ui: { exclude: ["encSecKey"] },
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assertEquals(w.filter((l) => l.includes("looks secret")).length, 0);
});

Deno.test("visibility #2: forUser transform suppresses the secret heuristic", () => {
  const c = cell("wallet5", {
    state: { encSecKey: "cipher", pub: "y" },
    ui: {
      include: ["encSecKey", "pub"],
      forUser: (s: { encSecKey: string; pub: string }) => ({
        ...s,
        encSecKey: "",
      }),
    },
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assertEquals(w.filter((l) => l.includes("looks secret")).length, 0);
});
