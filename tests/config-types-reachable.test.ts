// A type an app WRITES must be a type an app can NAME.
//
// `cell({ visible, persist, selectors })` and `aio.run({ auth, ui, wsLimits,
// security, feedback, updates, dispatchStorm, dbSchema })` are the two option
// bags every aio app fills in. Their keys have declared types — and about a
// dozen of those types were exported from no entry point at all. The moment an
// app lifted one key out into a named constant, a helper, a plugin's
// contribution or a test fixture, it had to re-declare the shape by hand and
// let the copy drift. `UiTheme` was the sharpest: its own jsdoc says "ONE
// spelling: every shell imports this type rather than re-typing the union" —
// a rule the framework kept internally and could not offer to an app.
//
// Adding an export is additive; it is also impossible after beta1, when the
// surface freezes. So this walks the two config declarations and requires
// every type they name to be importable from SOME `aio/*` entry. It reads the
// declarations, not a list, so a config key added tomorrow with a private type
// fails here rather than shipping unnameable. (audit a16/12)
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { AIO_ENTRY_PATHS, AIO_RUN_ONLY_ENTRIES } from "../src/entries.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Every name IMPORTABLE from an `aio/*` library entry.
 *
 *  `deno doc` also emits symbols that are merely REACHABLE from an exported
 *  one — a private type referenced by an exported interface — so the
 *  `declarationKind: "export"` filter is the whole check. Without it this test
 *  passes on exactly the bug it exists to catch: `UiConfig.theme?: UiTheme`
 *  drags `UiTheme` into the doc output whether or not anyone can import it.
 *  (`scripts/api-snapshot.ts` filters the same way, for the same reason.) */
async function publicNames(): Promise<Set<string>> {
  const paths = Object.entries(AIO_ENTRY_PATHS)
    .filter(([spec]) => !AIO_RUN_ONLY_ENTRIES.has(spec))
    .map(([, p]) => ROOT + p);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", ...paths],
    cwd: ROOT,
    stdout: "piped",
    stderr: "null",
  }).output();
  const doc = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    nodes: Record<
      string,
      {
        symbols?: {
          name: string;
          declarations?: { declarationKind: string }[];
        }[];
      }
    >;
  };
  const names = new Set<string>();
  for (const mod of Object.values(doc.nodes)) {
    for (const s of mod.symbols ?? []) {
      if ((s.declarations ?? []).some((d) => d.declarationKind === "export")) {
        names.add(s.name);
      }
    }
  }
  return names;
}

/** The `{ … }` block of a declaration, from its `export type X` / `interface X`
 *  to the brace that closes it. */
function declBody(text: string, name: string): string {
  const m = new RegExp(`export (?:type|interface) ${name}[<\\s]`).exec(text);
  if (!m) throw new Error(`no declaration for ${name}`);
  let depth = 0;
  const from = m.index;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  throw new Error(`unbalanced declaration for ${name}`);
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** TypeScript's own vocabulary and the declarations' generic parameters —
 *  never aio's to export. Kept SHORT on purpose: every name added here is a
 *  name this test stops checking, so an entry belongs here only when it is
 *  provably not an aio type. */
const NOT_OURS = new Set([
  // built-ins / lib.d.ts
  "Promise",
  "Record",
  "Partial",
  "Readonly",
  "Required",
  "Pick",
  "Omit",
  "Array",
  "Map",
  "Set",
  "Date",
  "Error",
  "RegExp",
  "Request",
  "Response",
  "Headers",
  "URL",
  "AbortSignal",
  "Uint8Array",
  "NoInfer",
  "Exclude",
  "Extract",
  "ReturnType",
  "Parameters",
  "Awaited",
  "Deno",
  // generic parameters declared by the two config types themselves
  "S",
  "A",
  "E",
  "K",
  "V",
  "T",
  "Sel",
  "States",
  "Methods",
]);

/** file · declaration · the call an app writes */
const TARGETS: [string, string, string][] = [
  ["src/server/aio-types.ts", "CellsConfig", "aio.run({ … })"],
  ["src/state/cell-config-types.ts", "MethodsCellConfig", "cell({ … })"],
  // The nested bags an app fills in just as directly. `ui.theme` is why this
  // list is not just the two top-level configs: `UiTheme` sits one level down,
  // and one level down was enough to hide it from every entry point.
  ["src/server/aio-types.ts", "UiConfig", "aio.run({ ui: { … } })"],
];

Deno.test("config types: every type an app writes is importable from an entry", async () => {
  const names = await publicNames();
  const unreachable: string[] = [];
  for (const [file, decl, what] of TARGETS) {
    const body = stripComments(
      declBody(await Deno.readTextFile(ROOT + file), decl),
    );
    for (const m of body.matchAll(/\b([A-Z][A-Za-z0-9]+)\b/g)) {
      const name = m[1]!;
      if (NOT_OURS.has(name) || names.has(name)) continue;
      unreachable.push(`${what} → ${decl}.${name} (declared in ${file})`);
    }
  }
  assertEquals(
    [...new Set(unreachable)].sort(),
    [],
    "These types appear in a config an app fills in, and are exported from no " +
      "aio entry point — so the app must re-declare them by hand and let the " +
      "copy drift. Export each from the entry that owns it (add the line to " +
      "the entry module; src/entries.ts stays the list of ENTRIES). Adding an " +
      "export is additive today and impossible after beta1.",
  );
});

Deno.test("config types: the reachability check can actually fail", async () => {
  // The instrument, verified. A name that is certainly not exported must be
  // reported — otherwise the test above passes for the wrong reason forever
  // (an empty name set, a doc invocation that silently returned nothing).
  const names = await publicNames();
  assertEquals(names.has("CellsConfig"), true, "the doc scan found nothing");
  assertEquals(names.has("ThisTypeDoesNotExist"), false);
  // And the filter that makes it an IMPORTABILITY check rather than a
  // reachability one: a private type behind an exported alias must not count.
  assertEquals(
    names.has("Common"),
    false,
    "a non-exported symbol leaked into the public-name set — the " +
      'declarationKind: "export" filter is not doing its job',
  );
});
