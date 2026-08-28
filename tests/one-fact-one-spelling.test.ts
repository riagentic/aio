// One fact, one spelling.
//
// Every bug in the last two field reports was the same shape: ONE fact decided
// independently in N places, where a change reached some of them and not the
// others. Not one was a hard algorithm — they were all bookkeeping:
//
//   • `ui.entry` became configurable; the BUNDLER kept its hardcoded default,
//     so an app rendered one component in dev and another once compiled.
//   • …and so did the boot lint, so the same app failed its own startup check.
//   • a component that renders `null` was decided in SIX render paths; five
//     agreed and one did not, and a prompt written first rendered last.
//   • `build.targets` gained an object form; `aiol` read only the array form
//     and CRASHED, `am fix` read the key as a target name.
//
// The measurable version of that shape is a literal repeated across files:
// "App.tsx" was written 26 times in 12 files, almost always as its own
// `?? "App.tsx"` default. A fact spelled once can be threaded once; a fact
// spelled twenty-six times must be FOUND twenty-six times, and the ones you
// miss are found by users.
//
// So the counts are a LEDGER that may only shrink. Adding a hardcoded copy
// fails here and names the module to import instead. Lowering a number after
// removing copies is the intended direction — retighten the ledger and commit
// it.
import { assertEquals } from "@std/assert";

/** Facts that must be spelled in `src/server/app-files.ts` and read from
 *  there. The number is the count of files still holding a raw literal —
 *  doc comments and help text included, because a stale doc is its own bug
 *  (the numbers are small enough that the difference is not worth a parser). */
const LEDGER: Record<
  string,
  { pattern: RegExp; files: number; use: string; home?: string }
> = {
  "App.tsx": { pattern: /"App\.tsx"/g, files: 5, use: "UI_ENTRY" },
  // 6 → 2: every build-side copy now reads APP_STYLE; what is left is the
  // runtime's own two sites.
  "style.css": { pattern: /"style\.css"/g, files: 2, use: "APP_STYLE" },
  // 6 → 5 → 0. The four targets that each resolved `<appDir>/icon.png` for
  // themselves ask `resolveAppIcon` (F-2), which is also what tells them an
  // icon is sitting at the project root where the build cannot see it — and
  // the remaining raw copies (the build's dist/ sweep, the AppImage payload
  // list, the static server's asset table) now read the constants.
  //
  // Zero, not "a smaller number": APP_ICON and BUNDLE_JS were DECLARED as
  // the one-fact-one-spelling home and had no importer in `src/` at all, so
  // this ledger was capping the literals at whatever count they already had
  // — the gate asleep, guarding a migration nobody had performed. A ceiling
  // of 0 is the only one that cannot go back to sleep.
  "icon.png": { pattern: /"icon\.png"/g, files: 0, use: "APP_ICON" },
  "app.js": { pattern: /"app\.js"/g, files: 0, use: "BUNDLE_JS" },
  // The control plane's own prefix. The GATE that refuses a non-loopback
  // caller and the DISPATCHER that runs the route both tested for it, in
  // four raw literals across four files — so moving the prefix would have
  // moved the route and left the gate behind, dispatching raw state,
  // arbitrary SQL and shutdown with nothing in front of it. Zero, because
  // there is a constant and nothing else may spell it.
  "/__aio/trojan/": {
    pattern: /"\/__aio\/trojan\/"/g,
    files: 0,
    use: "TROJAN_PREFIX",
    home: "src/server/server-auth.ts",
  },
  "src/app.ts": {
    pattern: /"src\/app\.ts"/g,
    files: 6,
    use: "DEFAULT_ENTRY",
  },
};

/** The module that OWNS these names is exempt — that is the whole point.
 *  Most live in `app-files.ts`; an entry may name its own with `home`. */
const HOME = "src/server/app-files.ts";

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield p;
  }
}

/** The same rule one level up: HOW the app's config is read. `deno.json` is
 *  JSONC and `deno.jsonc` is legal, so `JSON.parse` on either is a bug — and
 *  it was written eleven times, fixed in exactly one of them, and left in the
 *  other ten (R-12). */
const JSON_PARSE_HOME = "src/server/deno-json.ts";

Deno.test("one fact, one spelling: nothing hand-parses the app config", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const offenders: string[] = [];
  for await (const f of walk(`${root}src`)) {
    const rel = f.slice(root.length);
    if (rel === JSON_PARSE_HOME) continue;
    const src = await Deno.readTextFile(f);
    // A JSON.parse whose ARGUMENT reaches for the config file — checked
    // across the call, since the reads are usually wrapped over two lines.
    for (const m of src.matchAll(/JSON\.parse\(([\s\S]{0,160}?)\)/g)) {
      if (/deno\.jsonc?/.test(m[1]!)) {
        offenders.push(`${rel}: ${m[0].split("\n")[0]!.slice(0, 70)}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    `these read the app's config with JSON.parse — which rejects the comments ` +
      `Deno accepts, and never finds deno.jsonc at all. Use readDenoJson / ` +
      `readDenoJsonSync / parseDenoJson from ${JSON_PARSE_HOME}:\n     ` +
      offenders.join("\n     "),
  );
});

Deno.test("one fact, one spelling: the hardcoded-literal ledger only shrinks", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const counts: Record<string, string[]> = {};
  for await (const f of walk(`${root}src`)) {
    const rel = f.slice(root.length);
    const src = await Deno.readTextFile(f);
    for (const [name, spec] of Object.entries(LEDGER)) {
      if (rel === (spec.home ?? HOME)) continue; // the module that owns it
      if (new RegExp(spec.pattern.source).test(src)) {
        (counts[name] ??= []).push(rel);
      }
    }
  }
  const over: string[] = [];
  const under: string[] = [];
  for (const [name, spec] of Object.entries(LEDGER)) {
    const files = counts[name] ?? [];
    if (files.length > spec.files) {
      over.push(
        `"${name}" is now hardcoded in ${files.length} files (ledger: ${spec.files}) — ` +
          `import ${spec.use} from ${spec.home ?? HOME} instead.\n     ${
            files.join("\n     ")
          }`,
      );
    } else if (files.length < spec.files) {
      under.push(
        `"${name}" is down to ${files.length} files (ledger says ${spec.files}) — ` +
          `good; tighten the ledger to ${files.length} and commit it.`,
      );
    }
  }
  assertEquals(over, [], over.join("\n\n"));
  assertEquals(under, [], under.join("\n"));
});
