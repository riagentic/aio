// hook-tiers.test.ts — every hook on `aio/air` says which tier it is in, in
// the one place an editor reads: its own JSDoc.
//
// 23 hooks on the main surface, and every example app plus amui together use
// ONE of them. The docs group them; a tooltip did not, so at the moment of
// choosing — typing `use` and reading the completion list — nothing said
// which four you actually need. `@tier` is that sentence, at the definition,
// where the tooltip comes from.
//
//   Core      the jobs every app does. The React spellings are Core too:
//             they are first-class, so a tooltip must not rank them lower
//             than the aio spelling of the same job.
//   Kit       a whole feature, packaged. Reached for when you need it.
//   Advanced  real and supported, and not what a first app needs.
//
// The gate is that no hook is left UNTIERED and that Core stays small — a
// tier list everything joins says nothing.

import { assert, assertEquals } from "@std/assert";

const ROOT = new URL("../", import.meta.url);
const TIERS = ["Core", "Kit", "Advanced"] as const;

/** Every `use*` name `aio/air` re-exports, read from src/air.ts. */
async function exportedHooks(): Promise<string[]> {
  const src = await Deno.readTextFile(new URL("src/air.ts", ROOT));
  const names = new Set<string>();
  // Only export statements — a `use*` inside a comment is not a surface.
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.replace(/\btype\b/, "").split(" as ")[0]!.trim();
      if (/^use[A-Z]/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

/** The `@tier` values in the JSDoc directly above each `use*` definition,
 *  across src/. Read as text, because that is what a tooltip reads. */
async function declaredTiers(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const walk = async function* (dir: URL): AsyncGenerator<URL> {
    for await (const e of Deno.readDir(dir)) {
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) yield* walk(u);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) yield u;
    }
  };
  for await (const file of walk(new URL("src/", ROOT))) {
    const lines = (await Deno.readTextFile(file)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /^export (?:function|const) (use[A-Z]\w*)/.exec(lines[i]!);
      if (!m) continue;
      // Walk up through blank lines and line comments to the JSDoc block.
      let j = i - 1;
      while (
        j >= 0 && (lines[j]!.trim() === "" || lines[j]!.startsWith("//"))
      ) {
        j--;
      }
      if (j < 0 || !lines[j]!.trim().endsWith("*/")) continue;
      const end = j;
      while (j >= 0 && !lines[j]!.trim().startsWith("/**")) j--;
      if (j < 0) continue;
      const doc = lines.slice(j, end + 1).join("\n");
      const tier = /@tier\s+(\w+)/.exec(doc)?.[1];
      if (tier) found.set(m[1]!, [...(found.get(m[1]!) ?? []), tier]);
    }
  }
  return found;
}

Deno.test("every hook on aio/air declares a tier", async () => {
  const tiers = await declaredTiers();
  const untiered = (await exportedHooks()).filter((h) => !tiers.has(h));
  assertEquals(
    untiered,
    [],
    `these hooks are on the public surface with no @tier in their JSDoc, so ` +
      `an editor tooltip cannot say whether a first app needs them. Add ` +
      `\`@tier Core|Kit|Advanced\` at the definition: ${untiered.join(", ")}`,
  );
});

Deno.test("a tier is one of the three, once", async () => {
  const tiers = await declaredTiers();
  // The scanner returning NOTHING — a refactor that moves a hook, a regex that
  // stops matching — would make every assertion below vacuous while the test
  // stayed green. That is the failure this whole file exists to prevent, so it
  // is checked on the instrument first.
  assert(tiers.size >= 20, `the scanner found ${tiers.size} tiered hooks`);
  for (const [hook, values] of tiers) {
    assertEquals(values.length, 1, `${hook} declares @tier ${values.length}×`);
    assert(
      (TIERS as readonly string[]).includes(values[0]!),
      `${hook} is @tier ${values[0]} — the tiers are ${TIERS.join(", ")}`,
    );
  }
});

Deno.test("Core stays small enough to mean something", async () => {
  const tiers = await declaredTiers();
  const hooks = await exportedHooks();
  const core = hooks.filter((h) => tiers.get(h)?.[0] === "Core");
  // Four jobs, each with its aio spelling and its React one. A ceiling, not
  // a target: if a ninth hook wants to be Core, one of these stopped being a
  // job every app does.
  assert(
    core.length <= 8,
    `${core.length} hooks are Core (${core.join(", ")}) — a tier everything ` +
      `joins says nothing. Move one to Kit or Advanced.`,
  );
  assert(core.length >= 3, "Core cannot be empty — every app needs some");
});

Deno.test("every tier is actually used", async () => {
  const tiers = await declaredTiers();
  const used = new Set(
    (await exportedHooks()).map((h) => tiers.get(h)?.[0]).filter(Boolean),
  );
  for (const t of TIERS) {
    assert(used.has(t), `no hook is @tier ${t} — drop the tier or use it`);
  }
});
