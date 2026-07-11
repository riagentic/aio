// Config-allowlist drift gate — kills a recurring bug class permanently.
// validateConfig() EXITS THE PROCESS on unknown keys, so any key that exists
// on the typed config but is missing from the VALID_* allowlist turns a
// documented feature into a boot-fatal error (found twice in the wild:
// ui.entry, then wsLimits/fatalOnStart/dispatchStorm/allowedOrigins/
// strictOrigin on the cells API). This test extracts the REAL typed keys via
// `deno doc --json` and asserts every public one is allowlisted.
import { assert } from "@std/assert";
import {
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
} from "../src/server/config.ts";

async function typedKeys(typeName: string): Promise<string[]> {
  const out = await new Deno.Command(Deno.execPath(), {
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
