// The class "a line in `deno task dev`, NOTHING in a packaged app" cannot
// grow back unnoticed.
//
// Every client-side diagnostic used to sit behind `isDevMode()` / `__aioDev`.
// For advice that is right. For a DEFECT it made the built app the quiet one,
// and 1.0.19 and the round after it moved those lines to "prod says it once"
// (protocol/said-once.ts). Nothing stopped the next one being written the old
// way: `if (isDevMode()) console.warn(…)` type-checks, lints and passes every
// behavioural test.
//
// So every dev-gated print in the client folders must be one of:
//
//   says  it reaches the shared helper (`saysOnce` / `firstTime` / `_wrong`),
//         so a production page says the fact too — detected, not declared;
//   a     observe-only: advice, a lint, a perf tripwire, an overlay. Prod
//         does nothing differently and has nothing to report;
//   b     dev is STRICTER (it throws); prod degrades and says so itself.
//
// (a) and (b) are declared in REGISTRY with the reason — which is the point:
// the next dev-only line is a decision somebody writes down, not a default.
// A registry row that matches nothing, or matches a site that now says it in
// production, is red too.
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const DIRS = ["src/air", "src/browser", "src/ui", "src/protocol", "src/state"];

/** A dev gate: the flag itself, or the helper that is nothing but the flag
 *  and a `console.warn`. */
const GATE = /\bisDevMode\(\)|__aioDev\b|\b_devWarn\(/;
/** …that returns early: everything below it in the function is dev-only. */
const EARLY = /(!\s*isDevMode\(\)|__aioDev\b)[^;{]*\)\s*return\b/;
const PRINT =
  /\bconsole\.(warn|error|debug|info|log)\(|\blog\.(warn|error|info|debug)\(|\b_devWarn\(|\bwarn\(|\bthrow new Error\(/;
const SAYS = /\bsaysOnce\(|\bfirstTime\(|\b_wrong\(/;
/** How many lines after a gate belong to it: the block it opens (braces
 *  counted from the gate line), and never fewer than a multi-line condition
 *  plus the call it guards. A print past that is another site. */
function extent(code: string[], at: number): number {
  let depth = 0, opened = false;
  for (let i = at; i < code.length && i < at + 120; i++) {
    for (const ch of code[i]!) {
      if (ch === "{") depth++, opened = true;
      else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return Math.max(MIN_WINDOW, i - at + 1);
    if (!opened && i - at >= 4) break; // a statement, not a block
  }
  return MIN_WINDOW;
}
const MIN_WINDOW = 14;

type Class = "a" | "b" | "p";
/** file → [a distinctive piece of the gate line (or the line after it, for a
 *  call whose arguments start on the next line), class, why]. `p` is a dev
 *  line whose PRODUCTION twin is said from another site, named in the why. */
const REGISTRY: Record<string, [string, Class, string][]> = {
  "src/air/dev-a11y.ts": [
    ["if (!isDevMode()) return;", "a", "the a11y lint: advice about markup"],
  ],
  "src/air/contrast-audit.ts": [
    ["!isDevMode() || !root", "a", "colour-contrast audit (dev chunk)"],
  ],
  "src/air/control-drift.ts": [
    [
      "!_EVENTS.has(evt) || !isDevMode()",
      "a",
      "a heuristic on a 1 s timer per input: a debounced store is legal",
    ],
  ],
  "src/air/dark-os-light-page.ts": [
    ["_warned || !isDevMode()", "a", "a theming hint (dev chunk)"],
    ["__aioDarkOsCheckInstalled", "a", "its installer"],
  ],
  "src/air/dev-readonly-hint.ts": [
    [
      "__aioDev !== true) return",
      "a",
      "a hint beside an error that is already thrown and logged in prod",
    ],
  ],
  "src/air/renderer-lifecycle.ts": [
    [
      "_callerFrame(new Error().stack)",
      "a",
      "telling two onUnmount()s apart needs a stack capture per call; a " +
      "changed hook COUNT is said in production (_checkHookOrder)",
    ],
  ],
  "src/air/selector-audit.ts": [
    ["!isDevMode() || !doc", "a", "#id-selector audit (dev chunk)"],
  ],
  "src/air/ui-trigger.ts": [
    ["if (!isDevMode()) return;", "a", "`am trigger` advice (dev chunk)"],
  ],
  "src/air/untracked-read.ts": [
    ["_hookSignalNames.has(sig)", "a", "names signals for dev messages"],
    [
      "if (!isDevMode()) return fn();",
      "a",
      "needs a tracking frame around every lifecycle callback",
    ],
  ],
  "src/air/vdom-create.ts": [
    [
      "__aioDev === true) { throw new Error(msg)",
      "b",
      "dev throws; prod says it (console.error, once per shape) and " +
      "renders nothing",
    ],
  ],
  "src/air/dev-keys.ts": [
    ["missing-keys", "a", "advice: positional reconciliation is still right"],
    ["mixed-keys", "a", "advice"],
    [
      "dup-key-",
      "p",
      "dev names every key; production says the fact once from diffKeyed",
    ],
  ],
  "src/air/dev-align.ts": [
    [
      "child-desync-",
      "a",
      "the alignment tripwire walks the DOM after every diff; the failures " +
      "it can lead to are said in production at the site (_wrong)",
    ],
  ],
  "src/air/dev-events.ts": [
    [
      "__aioDev) return;",
      "a",
      "a typo lint over a list of known names: a custom event is legal",
    ],
  ],
  "src/air/vdom-types.ts": [
    [
      "_devWarned.has(id)",
      "a",
      "the `_devWarn` helper itself — every caller is a site of its own",
    ],
  ],
  "src/browser/dev-overlay.ts": [
    ["_installed || !isDevMode()", "a", "the dev error overlay"],
  ],
  "src/state/blocking.ts": [
    [
      "!_warnedDupId.has(id)",
      "a",
      "advice: a blocking id is a group, and two tasks under one is legal",
    ],
  ],
  "src/state/cell-compose-reduce.ts": [
    [
      'log.warn("aio", msg);',
      "a",
      "a machine guard doing its job: production logs it at debug and " +
      "records the refusal (recordRejection, the action-guarded event)",
    ],
  ],
  "src/state/cell-methods-internals.ts": [
    [
      "__aioDev !== true) return eff;",
      "b",
      "dev refuses an effect that cannot be cloned in the method's stack; " +
      "production logs and drops it where it leaves the method",
    ],
    ['__aioDev !== "undefined"', "a", "a debug dump of the machine table"],
  ],
  "src/state/own.ts": [
    [
      "__aioDev === true;",
      "a",
      "advice: own.set replaces by key, which is the documented contract",
    ],
  ],
  "src/state/schedule.ts": [
    [
      "throw teachableError(what, fix, SCHEDULE_DOC)",
      "b",
      "dev throws; production waits 1 ms as before and says so (log.warn, " +
      "once per id and key)",
    ],
  ],
  "src/state/signal.ts": [
    [
      "this._name && isDevMode() &&",
      "a",
      "a heuristic: a set of the SAME object is the mutate-then-set bug or " +
      "a re-selected row, and nothing at the site can tell which",
    ],
    [
      "if (this._name && isDevMode()) {",
      "a",
      "a skipped shallow-equal set is the intended result, named in dev",
    ],
  ],
  "src/state/state-signals.ts": [
    [
      "__aioDev !== true) return value;",
      "b",
      "dev also freezes what a component reads, so a write to it throws " +
      "there; committed state is frozen in both modes",
    ],
  ],
  "src/ui/css.ts": [
    [
      "__aioDev === true) { throw new Error(msg)",
      "b",
      "dev throws; prod neutralises the value and says so (console.error)",
    ],
  ],
};

type Site = { file: string; line: number; text: string; says: boolean };

async function sites(): Promise<Site[]> {
  const out: Site[] = [];
  const walk = async (rel: string): Promise<void> => {
    for await (const e of Deno.readDir(ROOT + rel)) {
      const next = `${rel}/${e.name}`;
      if (e.isDirectory) await walk(next);
      else if (/\.tsx?$/.test(e.name)) {
        const lines = (await Deno.readTextFile(ROOT + next)).split("\n");
        const code = lines.map((l) =>
          /^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l.replace(/\s\/\/ .*$/, "")
        );
        let last = -9;
        for (let i = 0; i < code.length; i++) {
          if (!GATE.test(code[i]!)) continue;
          // The definitions of the gate and of the helper are not sites, and
          // a gate on the line after a gate is the same site.
          if (/^\s*(export )?function /.test(code[i]!) || i - last === 1) {
            continue;
          }
          const window = code.slice(i, i + extent(code, i)).join("\n");
          const prints = PRINT.test(window) || EARLY.test(code[i]!);
          if (!prints) continue; // the flag is passed along or stored
          last = i;
          out.push({
            file: next,
            line: i + 1,
            // The line after it too: `_devWarn(` alone names nothing, the id
            // on the next line does.
            text: (code[i]! + " " + (code[i + 1] ?? "")).replace(/\s+/g, " ")
              .trim(),
            says: SAYS.test(window),
          });
        }
      }
    }
  };
  for (const d of DIRS) await walk(d);
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

Deno.test("prod-says guard: every dev-gated print says it in production too, or is registered as (a)/(b)", async () => {
  const all = await sites();
  const used = new Set<string>();
  const unclassified: string[] = [];
  const nowSays: string[] = [];
  for (const s of all) {
    const row = (REGISTRY[s.file] ?? []).find(([piece]) =>
      s.text.includes(piece)
    );
    if (row) {
      used.add(`${s.file} :: ${row[0]}`);
      if (s.says) nowSays.push(`${s.file}:${s.line}  "${row[0]}"`);
    } else if (!s.says) {
      unclassified.push(`${s.file}:${s.line}  ${s.text.slice(0, 110)}`);
    }
  }
  assertEquals(
    unclassified,
    [],
    "a dev-gated diagnostic that a production page never says:\n  " +
      unclassified.join("\n  ") +
      "\n  If it reports a DEFECT (an update lost, an event or a prop " +
      "dropped, server markup discarded), production must say it once: use " +
      "`_wrong(id, what, fix)` (air/vdom-types.ts) or `saysOnce` / " +
      "`firstTime` (protocol/said-once.ts). If it is advice, a lint or a " +
      "perf tripwire (a), or dev throwing where prod degrades and says so " +
      "(b), add a REGISTRY row here with the reason.",
  );
  assertEquals(
    nowSays,
    [],
    "registered as dev-only, but the site now reaches the prod-says " +
      "helper — delete the row:\n  " + nowSays.join("\n  "),
  );
  const stale = Object.entries(REGISTRY).flatMap(([file, rows]) =>
    rows.map(([piece]) => `${file} :: ${piece}`)
  ).filter((k) => !used.has(k));
  assertEquals(
    stale,
    [],
    "REGISTRY rows that match no dev-gated print any more — delete them:\n  " +
      stale.join("\n  "),
  );
});

Deno.test("prod-says guard: the scan sees the sites it is about", async () => {
  // An instrument that finds nothing passes everything. These three are the
  // shapes it must keep finding: a block gate that says it in production, a
  // `_devWarn` call, and an early-return gate.
  const all = await sites();
  const has = (file: string, piece: string, says: boolean) =>
    all.some((s) =>
      s.file === file && s.text.includes(piece) && s.says === says
    );
  assertEquals(
    [
      has("src/air/head.ts", "isDevMode()", true),
      has("src/air/dev-keys.ts", "missing-keys", false),
      has("src/air/control-drift.ts", "!isDevMode()", false),
    ],
    [true, true, true],
  );
  assertEquals(all.length > 30, true, `only ${all.length} sites found`);
});
