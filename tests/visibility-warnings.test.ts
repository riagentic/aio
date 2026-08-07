// Dev-safety warnings for field-level visibility config:
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
    visible: { exclude: ["encSecKey"] }, // top-level — legit
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assertEquals(
    w.filter((l) => l.includes("not a top-level")).length,
    0,
  );
});

Deno.test("visibility #4: public/id fields do NOT trip the secret heuristic", () => {
  // the name heuristic over-fired on public keys and id/type fields.
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
  // a warning is too soft for an unambiguous credential.
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
    visible: { exclude: ["password"] },
    methods: { noop(_s) {} },
  });
  const publicOk = cell("cred_pub", {
    state: { apiKey: "public-token", ok: 1 },
    visible: { publicFields: ["apiKey"] },
    methods: { noop(_s) {} },
  });
  // Neither should throw.
  warningsFor([excluded]);
  warningsFor([publicOk]);
});

Deno.test("visibility: a deep-excluded container no longer warns", () => {
  // The correct fix (deep-exclude the secret sub-path) must NOT re-arm the
  // secret heuristic on the container field.
  const c = cell("seedvault", {
    state: { seeds: [] as { encSeed: string }[], seedNextId: 0 },
    visible: { exclude: ["seeds.encSeed"] },
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
    visible: { publicFields: ["masterKey"] },
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assertEquals(w.filter((l) => l.includes("looks secret")).length, 0);
});

Deno.test("visibility: all offending fields in ONE paste-ready message", () => {
  // We used to throw on the FIRST credential field, forcing a fix-one-rerun loop
  //. Now one boot names them
  // all, with a single paste-ready ui.publicFields array.
  const c = cell("multicred", {
    state: { privateKey: "a", mnemonic: "b", apiKey: "c", ok: 1 },
    methods: { noop(_s: Record<string, unknown>) {} },
  });
  const err = assertThrows(
    () => composeCellsWiring({ cellEntries: [c] as never }),
    Error,
  );
  // Every offending field named, in one message, as a paste-ready array.
  for (const f of ["privateKey", "mnemonic", "apiKey"]) {
    assert(err.message.includes(f), `expected ${f} in the message`);
  }
  assert(
    /publicFields:\s*\["privateKey",\s*"mnemonic",\s*"apiKey"\]/.test(
      err.message,
    ),
    `expected a single paste-ready array of all fields; got: ${err.message}`,
  );
  assert(!err.message.includes("ok"), "non-secret field must not be listed");
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
    visible: { exclude: ["encSecKey"] },
    methods: { noop(_s) {} },
  });
  const w = warningsFor([c]);
  assertEquals(w.filter((l) => l.includes("looks secret")).length, 0);
});

Deno.test("visibility #2: forUser transform suppresses the secret heuristic", () => {
  const c = cell("wallet5", {
    state: { encSecKey: "cipher", pub: "y" },
    visible: {
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

Deno.test("visibility: an ordinary word containing 'enc' is not a credential", () => {
  // `enc` was matched as a bare SUBSTRING, so it fired on latency, sequence,
  // currency, reference, influence, agency, cadence — ordinary words with an
  // `enc` in the middle. A field report hit it with `lastLatencyMs`, a
  // millisecond count that belongs on screen. A security warning that cries
  // wolf on measurements teaches people to reach for the escape hatch without
  // reading it, which is the one outcome such a warning must never produce.
  const c = cell("metrics", {
    state: {
      lastLatencyMs: 0, // the reported case
      sequenceId: 0,
      currency: "EUR",
      reference: "",
      influence: 0,
      cadence: 0,
      agency: "",
      // measurement suffixes, whatever the stem
      keyPressCount: 0,
      seedRatio: 0,
      privBytes: 0,
    },
    methods: { noop(_s: unknown) {} },
  });
  const w = warningsFor([c]);
  assertEquals(
    w.filter((l) => l.includes("looks secret")).length,
    0,
    `no field here is a secret; got: ${w.join(" | ")}`,
  );
});

Deno.test("visibility: a real secret name is still caught at every boundary", () => {
  // The other half of the contract — narrowing the match must not blind it.
  // One cell per field so a hard-secret boot refusal can't mask the rest.
  for (
    const name of [
      "encKey", // word start
      "dataEnc", // camelCase hump
      "enc_seed", // separator
      "secretSauce",
      "privValue",
      "seedPhrase",
    ]
  ) {
    const c = cell(`sec_${name.toLowerCase()}`, {
      state: { [name]: "" } as Record<string, unknown>,
      methods: { noop(_s: unknown) {} },
    });
    const w = warningsFor([c]);
    assert(
      w.some((l) => l.includes("looks secret")),
      `"${name}" must still be flagged; got: ${w.join(" | ")}`,
    );
  }
});
