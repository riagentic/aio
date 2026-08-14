// Config-allowlist drift gate — kills a recurring bug class permanently.
// validateConfig() EXITS THE PROCESS on unknown keys, so any key that exists
// on the typed config but is missing from the VALID_* allowlist turns a
// documented feature into a boot-fatal error (found twice in the wild:
// ui.entry, then wsLimits/fatalOnStart/dispatchStorm/allowedOrigins/
// strictOrigin on the cells API). This test extracts the REAL typed keys via
// `deno doc --json` and asserts every public one is allowlisted.
import { assert, assertEquals } from "@std/assert";
import {
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
} from "../src/server/config.ts";

// Coverage profiles from spawned deno processes go to a throwaway temp dir —
// never into the repo (an empty DENO_COVERAGE_DIR means "cwd"), never into
// the parent's coverage profile.
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

async function typedKeys(typeName: string): Promise<string[]> {
  const out = await new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir },
    args: ["doc", "--json", "src/server/aio-types.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "piped",
    stderr: "null",
  }).output();
  const doc = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    nodes: Record<string, { symbols: Array<Record<string, unknown>> }>;
  };
  const symbols = Object.values(doc.nodes)[0]!.symbols;
  const sym = symbols.find((s) => s.name === typeName) as {
    declarations: Array<{
      kind: string;
      // deno-lint-ignore no-explicit-any
      def: any;
    }>;
  } | undefined;
  assert(sym, `type ${typeName} not found in aio-types.ts doc output`);

  const props: string[] = [];
  // deno-lint-ignore no-explicit-any
  const collect = (t: any): void => {
    if (!t) return;
    if (t.kind === "typeLiteral") {
      for (const p of t.value?.properties ?? t.typeLiteral?.properties ?? []) {
        props.push(p.name);
      }
    } else if (t.kind === "intersection" || t.kind === "union") {
      for (const part of t.value ?? []) collect(part);
    }
  };
  for (const decl of sym.declarations) {
    if (decl.kind === "typeAlias") collect(decl.def?.tsType);
    if (decl.kind === "interface") {
      for (const p of decl.def?.properties ?? []) props.push(p.name);
    }
  }
  assert(
    props.length > 3,
    `extracted too few keys for ${typeName} — doc shape drifted?`,
  );
  return props.filter((p) => !p.startsWith("_"));
}

function assertCovered(keys: string[], allow: Set<string>, label: string) {
  const missing = keys.filter((k) => !allow.has(k));
  assert(
    missing.length === 0,
    `${label}: typed key(s) missing from the allowlist — using them is ` +
      `BOOT-FATAL (validateConfig exits): ${missing.join(", ")}\n` +
      `fix: add to the ${label} Set in src/server/config.ts`,
  );
}

Deno.test("config allowlists cover every typed key (drift gate)", async () => {
  assertCovered(
    await typedKeys("UiConfig"),
    VALID_UI_KEYS,
    "VALID_UI_KEYS",
  );
  assertCovered(
    await typedKeys("CellsConfig"),
    VALID_FEATURES_CONFIG_KEYS,
    "VALID_FEATURES_CONFIG_KEYS",
  );
  assertCovered(
    await typedKeys("AioConfig"),
    VALID_AIO_CONFIG_KEYS,
    "VALID_AIO_CONFIG_KEYS",
  );
});

// The REVERSE direction, and the one that let `host` through: a key can be
// allowlisted, forwarded by the config bridge, read by the server, printed by
// `aio doctor` and used in the docs — and still be missing from the TYPE, the
// one surface an app must compile against. Following the documentation then
// fails `deno task check`. "Present in 2 of 3 surfaces" is the recurring trap
// this project keeps gates for; this is the third gate.
//
// Exemptions are keys deliberately accepted without being offered: they must
// stay a short, named list, never a growing one.
const UNTYPED_ON_PURPOSE = new Set([
  // Compat-only: AIR is the only renderer, so the key is accepted and ignored
  // rather than being a boot-fatal unknown for an app upgrading from an older
  // config (src/server/config.ts documents it in CONFIG_DOCS).
  "renderer",
]);

function assertTyped(allow: Set<string>, typed: Set<string>, label: string) {
  const untyped = [...allow].filter((k) =>
    // `_`-prefixed keys are internal wiring the runtime passes to itself —
    // never offered to an app, so never expected on a public type (the
    // forward gate above drops them for the same reason).
    !k.startsWith("_") && !typed.has(k) && !UNTYPED_ON_PURPOSE.has(k)
  );
  assert(
    untyped.length === 0,
    `${label}: allowlisted key(s) that no public type offers — an app that ` +
      `uses them (as the docs say) fails \`deno task check\`: ` +
      `${untyped.join(", ")}\n` +
      `fix: add them to the matching type in src/server/aio-types.ts, or, if ` +
      `they are compat-only, to UNTYPED_ON_PURPOSE here with the reason`,
  );
}

Deno.test("config allowlists offer nothing the types withhold (reverse drift gate)", async () => {
  const ui = new Set(await typedKeys("UiConfig"));
  const cells = new Set(await typedKeys("CellsConfig"));
  const aio = new Set(await typedKeys("AioConfig"));
  assertTyped(VALID_UI_KEYS, ui, "VALID_UI_KEYS");
  assertTyped(VALID_FEATURES_CONFIG_KEYS, cells, "VALID_FEATURES_CONFIG_KEYS");
  // `aio.run()` accepts either shape, so its allowlist is judged against both.
  assertTyped(
    VALID_AIO_CONFIG_KEYS,
    new Set([...aio, ...cells]),
    "VALID_AIO_CONFIG_KEYS",
  );
});

// The specific key that was missing, pinned by USE: this file type-checks, so
// a `host` that is not on the type fails the test run itself.
Deno.test("config: `host` is expressible in code, not just on the CLI", () => {
  const cfg: import("../src/server/aio-types.ts").CellsConfig = {
    host: "0.0.0.0",
    port: 8000,
  };
  assertEquals(cfg.host, "0.0.0.0");
  assert(VALID_FEATURES_CONFIG_KEYS.has("host"), "and it is allowlisted");
});
