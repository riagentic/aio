// testUI's name lookup and its misses — resolving a handle name to a
// surface node, ranking near-miss names, the failure-trace file, and the
// refusal messages that point at the right spelling. Split out of
// ui-test.ts; internal to it — nothing here was ever exported.

import { withRefusalCode } from "../state/method-rejection.ts";
import {
  collectElementPaths,
  findComponents,
  findElementsDeep,
  serializeSurface,
} from "../air/ui-surface.ts";
import type { UIElementInfo, UISurfaceNode } from "../air/ui-surface.ts";
import type { KeyModifiers } from "../air/ui-trigger.ts";
import { isMacPlatform, pressChord } from "../air/key-chord.ts";
import { _missSurface, _traceSource } from "./ui-test-build.ts";

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** The key a test MEANT: `"enter"` → `"Enter"`, `"esc"` → `"Escape"`,
 *  `"space"` → `" "`, and the `am trigger` chord spelling (`"ctrl+k"`,
 *  `"shift+Enter"`) → the key plus its modifiers, merged with any passed.
 *  These used to dispatch a KeyboardEvent whose `key` was the literal
 *  spelling — no handler or default action matched it, and the test stayed
 *  green having pressed nothing. A spelling that can mean no key (an unknown
 *  modifier like `"hyper+k"`, an empty string) throws. */
export function resolveKey(
  spec: string,
  mods: KeyModifiers | undefined,
  /** The DOM window's `navigator.platform` — what `mod` resolves against. */
  platform: string | undefined,
): { key: string; mods?: KeyModifiers } {
  let chord;
  try {
    chord = pressChord(
      spec,
      platform === undefined ? undefined : isMacPlatform(platform),
    );
  } catch (e) {
    throw new Error(
      `testUI: ${(e as Error).message} Or pass the modifiers: ` +
        `press("k", { ctrlKey: true }).`,
    );
  }
  return {
    key: chord.key,
    mods: chord.mods || mods ? { ...chord.mods, ...mods } : undefined,
  };
}

/** Does this component instance put anything on screen?
 *
 *  A component that returned `null` still HAS a node in the surface — it was
 *  rendered, it just produced nothing. Counting that as "present" made
 *  `absent("PlacementAdvice")` false while the screen showed no advice at all,
 *  which is the exact case the docstring used as its example. "Present" has to mean *showing*, or the
 *  assertion answers a question nobody asked.
 *
 *  Showing = it contributes an element, a child that shows something, or text.
 *  A component that renders only non-interactive, textless markup is therefore
 *  absent from the SEMANTIC surface — which is the right answer for an API whose
 *  whole premise is "what can be seen and done here". */
export function showsSomething(n: UISurfaceNode): boolean {
  if (n.elements.length > 0) return true;
  if (typeof n.text === "string" && n.text.trim().length > 0) return true;
  return n.children.some(showsSomething);
}

/** A failure message you can actually read.
 *
 *  A timeout used to stringify the WHOLE serialized surface, pretty-printed and
 *  uncapped: on one real page that is tens of KB per failure, and the assertion
 *  itself scrolls off the screen. `am surface` grew a text cap
 *  and --component/--path/--depth for exactly this problem; the harness's own
 *  output had not. Same idea here: names first (what you assert against), then a
 *  capped pretty tree, and the full JSON only when it is small enough to help. */
export function surfaceDigest(node: UISurfaceNode, maxChars = 2000): string {
  const names: string[] = [];
  const walk = (n: UISurfaceNode, depth: number) => {
    if (depth > 3) return;
    names.push(
      `${"  ".repeat(depth + 1)}${n.component}${
        n.handle ? ` (t=${n.handle})` : ""
      }${
        n.elements.length ? `: ${n.elements.map((e) => e.name).join(", ")}` : ""
      }`,
    );
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(node, 0);
  // BOUNDED, like every other name list this harness prints. The JSON half was
  // already capped and the TREE was not, so a wide app turned one timeout into
  // 31 769 characters of component names (report 9 §9.0) — a wall nobody reads, in
  // place of the six lines that would have said what happened. Same escape as
  // `fail()`: one environment variable prints all of it.
  const all = Deno.env.get("AIO_TEST_NAMES") === "all";
  const shown = all ? names : names.slice(0, NAME_LIMIT);
  const hidden = names.length - shown.length;
  const tree = shown.join("\n") +
    (hidden > 0
      ? `\n  (${hidden} more component${hidden === 1 ? "" : "s"} — ` +
        `AIO_TEST_NAMES=all prints the whole tree)`
      : "");
  const full = JSON.stringify(serializeSurface(node), null, 2);
  if (!all && full.length > maxChars) {
    return `\n${tree}\n\n  (surface JSON omitted — ${full.length} chars; ` +
      `print it with JSON.stringify(ui.surface()) if you need the detail)`;
  }
  return `\n${tree}\n\n${full}`;
}

/** Last addressable segment of a path — `App/Stage/Row[3]:title` → `title`. */
export function lastSegment(s: string): string {
  // aio-ok: path-split — a surface path (`App/Row[3]:title`)
  const cut = Math.max(s.lastIndexOf(":"), s.lastIndexOf("/"));
  return cut >= 0 ? s.slice(cut + 1) : s;
}

/** Edit distance, capped — only used to rank a listing, so an early exit past
 *  the cap is free accuracy nobody can observe. */
function editDistance(a: string, b: string, cap = 12): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** How many candidate names a failure lists before it stops helping.
 *
 *  A missing handle used to dump EVERY registered name in the app: one field
 *  report's screen has ~50, several hundred characters each, on one line — the
 *  assertion that failed scrolls off the top and the reader has to grep their
 *  own error message. The fix is the one `am surface` already made: rank by
 *  closeness to what was actually asked for, show the few that could plausibly
 *  be meant, and put the exhaustive list behind a flag. */
export const NAME_LIMIT = 8;

/** Rank candidates by how close they are to `target`'s last segment, so the
 *  name the caller probably meant is the first thing they read. */
function rankNames(target: string | undefined, names: string[]): string[] {
  const uniq = [...new Set(names)];
  if (!target) return uniq;
  const want = lastSegment(target).toLowerCase();
  return uniq
    .map((n) => {
      const seg = lastSegment(n).toLowerCase();
      // A containment relation beats raw distance: `image-negative` should rank
      // `toggle-image-negative` above an unrelated same-length name.
      const contains = seg.includes(want) || want.includes(seg) ? -1 : 0;
      return { n, score: contains + editDistance(want, seg) / 100 };
    })
    .sort((a, b) => a.score - b.score)
    .map((x) => x.n);
}

/** How many failure traces to keep. Names sort by timestamp, so the oldest
 *  are the first `length - TRACE_KEEP`. */
const TRACE_KEEP = 20;

/** Everything a failure knows, written where a reader can open it.
 *
 *  "dump the AIR tree and the last N dispatches, and name the file in the
 *  error" (report 2 §9.5). A failing assertion prints what the surface looks like
 *  NOW; what it can never print is how it got there, and reconstructing the
 *  sequence from a test body is the work this removes.
 *
 *  SYNCHRONOUS, and never fatal. It is called from `fail()`, which throws, so
 *  there is nothing to await it — an async write would outlive the test and be
 *  reported by the leak sanitizers against whoever ran next. And a trace that
 *  cannot be written must not replace the assertion's own error with a
 *  filesystem one: the failure is the point, the trace is a convenience.
 *
 *  Returns the line to append, or "" when nothing was written. */
export function writeTrace(body: Record<string, unknown>): string {
  try {
    const dir = `${Deno.cwd()}/.aio/traces`;
    Deno.mkdirSync(dir, { recursive: true });
    const file = `${dir}/ui-${Date.now()}-${
      Math.random().toString(36).slice(2, 7)
    }.json`;
    Deno.writeTextFileSync(file, JSON.stringify(body, null, 2));
    // BOUNDED. A suite with a hundred failures must not leave a hundred
    // artifacts behind, and an unbounded directory is one nobody ever cleans
    // — it just grows until someone notices the disk. The newest are the ones
    // anyone reads.
    try {
      const files = [...Deno.readDirSync(dir)]
        .filter((e) => e.isFile && e.name.endsWith(".json"))
        .map((e) => e.name)
        .sort();
      for (
        const old of files.slice(0, Math.max(0, files.length - TRACE_KEEP))
      ) {
        Deno.removeSync(`${dir}/${old}`);
      }
    } catch {
      // aio-ok: pruning is housekeeping — the trace just written is what the
      // reader needs, and a failure to tidy must not cost them the name of it.
    }
    return `\n  trace: ${file}`;
  } catch {
    // aio-ok: a read-only cwd or a full disk must not turn a failed assertion
    // into a filesystem error — the assertion is what the reader needs.
    return "";
  }
}

/** One trace field, or the reason it could not be read.
 *
 *  Per FIELD, not per trace: a surface that throws must not take the call
 *  list with it, and the call list is usually the half that explains the
 *  failure. */
export function traceSafe(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (e) {
    return { unavailable: e instanceof Error ? e.message : String(e) };
  }
}

/** How a test SPELLS one name on `ui` — dot form when it is an identifier,
 *  bracket form otherwise. One decider, so every miss quotes a spelling that
 *  can be pasted back into the test. */
export function uiSpelling(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `ui.${name}`
    : `ui[${JSON.stringify(name)}]`;
}

/** Every LIVE element in a component's subtree, in tree order. */
export function liveSubtreeElements(node: UISurfaceNode): UIElementInfo[] {
  const out: UIElementInfo[] = [];
  const visit = (n: UISurfaceNode) => {
    for (const e of n.elements) if (e._el) out.push(e);
    n.children.forEach(visit);
  };
  visit(node);
  return out;
}

/** The component instance that OWNS `node`, or null when `node` is the root. */
export function parentOf(
  root: UISurfaceNode,
  node: UISurfaceNode,
): UISurfaceNode | null {
  let found: UISurfaceNode | null = null;
  const visit = (n: UISurfaceNode) => {
    for (const c of n.children) {
      if (c.path === node.path) found = n;
      else visit(c);
    }
  };
  visit(root);
  return found;
}

/** Up to `n` element candidates, spelled and tagged — the ones that actually
 *  HANDLE events first, since "which of these can I click" is the question
 *  being answered. Ranking is read off the surface (`events`), never a
 *  hand-kept action→event table that could drift from the renderer. */
export function elementSuggestions(
  els: UIElementInfo[],
  n: number,
  article: string,
): string[] {
  const ranked = [
    ...els.filter((e) => e.events.length > 0),
    ...els.filter((e) => e.events.length === 0),
  ];
  return ranked.slice(0, n).map((e) =>
    `${uiSpelling(e.name)} (${article} ${e.tag})`
  );
}

/** How THIS harness reaches an element path: `ui.start` when the name is
 *  unique on the surface (the top-level hoist), else the path itself —
 *  `ui["App/Button#2:start"]`, which the top level also accepts. The am path
 *  alone (`App/Button:start`) is a grammar `ui.<name>` does not take, so a
 *  miss that printed only that left the working spelling unstated (h3 F10). */
function harnessSpelling(
  path: string,
  root: UISurfaceNode | null,
): { spelled: string; tNamed: boolean } {
  const name = lastSegment(path);
  const hits = root ? findElementsDeep(root, name) : [];
  const me = hits.find((e) => e.path === path);
  const t = (me?._vnode as { props?: Record<string, unknown> } | undefined)
    ?.props?.t;
  const unique = hits.length === 1;
  const spelled = unique ? uiSpelling(name) : `ui[${JSON.stringify(path)}]`;
  return { spelled, tNamed: typeof t === "string" && t === name };
}

/** DOM / test antipattern names authors reach for instead of testUI readers.
 *  Caught in the proxy get traps BEFORE treating the name as a missing child,
 *  so the error aims at the right question (same family as the
 *  component-action-miss fix — a field report reached for `.getAttribute` on a
 *  handle and got "no element named getAttribute"). */
export const DOM_ANTIPATTERN_PROPS = new Set([
  "getAttribute",
  "setAttribute",
  "hasAttribute",
  "querySelector",
  "querySelectorAll",
  "closest",
  "matches",
]);

export function refuseDomAntipattern(prop: string): never {
  return fail(
    `testUI: "${prop}" is not a testUI action or child. On an element use ` +
      `.attr("…"), or the state readers .checked/.pressed/.expanded/` +
      `.value/.text/.disabled/.readonly/.required. For CSS queries use ` +
      `ui.document.`,
    [],
  );
}

export function fail(msg: string, available: string[], target?: string): never {
  const all = Deno.env.get("AIO_TEST_NAMES") === "all";
  const ranked = rankNames(target, available);
  const shown = all ? ranked : ranked.slice(0, NAME_LIMIT);
  const hidden = ranked.length - shown.length;
  // Each ELEMENT path (the `Component:name` entries — the same list
  // `uiNames` / `am surface` print) gets the harness spelling beside it.
  // Components are listed as they are already addressed (`Row`, `Row2`).
  let root: UISurfaceNode | null = null;
  try {
    root = _missSurface?.() ?? null;
  } catch {
    // aio-ok: nothing mounted — the miss is already being raised, and the
    // spelling falls back to the path form, which needs no surface.
  }
  let closestHasT = false;
  let firstElement = true;
  const listed = shown.map((p) => {
    if (!p.includes(":") || p.includes(" ")) return p;
    const { spelled, tNamed } = harnessSpelling(p, root);
    if (firstElement) closestHasT = tNamed;
    firstElement = false;
    return `${p} → ${spelled}`;
  });
  throw withRefusalCode(
    new Error(
      `${msg}\n  available: ${listed.length ? listed.join(", ") : "(none)"}` +
        (hidden > 0
          ? `\n  (closest ${shown.length} of ${ranked.length} shown — ` +
            `AIO_TEST_NAMES=all lists every one)`
          : "") +
        // The closest candidate already HAS a `t` name — telling the reader to
        // add one sends them to fix what is not broken; the spelling beside it
        // is the answer.
        (closestHasT
          ? ""
          : `\n  tip: name elements explicitly with the t prop, e.g. <button t="save">`) +
        (_traceSource ? writeTrace(_traceSource()) : ""),
    ),
    "UI_LOOKUP",
  );
}

/** List a node's addressable names for error messages, annotating same-named
 *  sibling components with their count and the ordinal escape hatch:
 *  `Button ×2 — use Button2 for the 2nd`. */
export function listNames(node: UISurfaceNode): string[] {
  // Element half = the same paths uiNames / am surface --names use. Local
  // short names here used to disagree with discovery in both directions.
  const out = collectElementPaths(node);
  const counts = new Map<string, number>();
  for (const c of node.children) {
    counts.set(c.component, (counts.get(c.component) ?? 0) + 1);
  }
  for (const [name, n] of counts) {
    out.push(
      n > 1
        ? `${name} ×${n} — use ${name}2${
          n > 2 ? `…${name}${n}` : ""
        } for the later instance${n > 2 ? "s" : ""}`
        : name,
    );
  }
  return out;
}

/** Resolve the ordinal component form: `Button2` → the 2nd `Button` instance
 *  in tree (depth-first) order, mirroring element name de-duping (`Input`,
 *  `Input2`, …). Only kicks in when no exact name matched, so a component
 *  genuinely named `Button2` always wins.
 *
 *  `Button1` is accepted too — the explicit spelling of "the first one". It had
 *  no spelling at all while the bare name silently meant it; now that an
 *  ambiguous bare name is an error, "I really do mean the first" must be
 *  sayable. */
export function ordinalComponent(
  scope: UISurfaceNode,
  prop: string,
): UISurfaceNode | undefined {
  const m = /^(.*[^\d])(\d+)$/.exec(prop);
  if (!m) return undefined;
  const n = Number(m[2]);
  if (n < 1) return undefined;
  const hits = findComponents(scope, m[1]!);
  return hits.length >= n ? hits[n - 1] : undefined;
}

/** The component instance named `name` in `scope`, or fail loud.
 *
 *  Same-named siblings are POSITIONAL by design, not ambiguous: the bare name
 *  is the first instance and `Name2`, `Name3`, … are the later ones — the
 *  convention the miss listings themselves teach (`Button ×2 — use Button2 for
 *  the 2nd`) and that `tests/ui-kit-semantic.test.tsx` fuzzes as a property.
 *  (Making ambiguity an error here was tried and reverted: it contradicts that
 *  contract, and it makes an element reachable only by an ordinal the author
 *  has no reason to know. Element HOISTING is the different case — a deep
 *  search with two hits genuinely has no answer, so that one throws.) */
export function oneComponent(
  scope: UISurfaceNode,
  name: string,
  key?: string | number,
): UISurfaceNode {
  const hits = findComponents(scope, name, key);
  if (hits.length === 0) {
    // ONE name can address two different things: a COMPONENT (`<Stage/>`, or
    // `t` on a component) and an ELEMENT (`t` on a `<button>`). A miss that
    // says "component X not found" and lists only what is directly in scope
    // sends the reader looking in the wrong namespace — two field reports lost
    // time to exactly that, one of them concluding it had misnamed a component
    // while the thing it wanted was an element two levels down. So when the
    // name IS on the surface as an element, say so and name the spelling that
    // works.
    const asElement = findElementsDeep(scope, name).filter((e) => e._el);
    if (asElement.length > 0) {
      fail(
        `testUI: no COMPONENT named "${name}" under ${scope.path} — but there ` +
          `IS an element by that name (${
            asElement.map((e) => e.path).join(", ")
          }).\n  fix: address elements directly — ui["${name}"] (or ` +
          `ui.<Component>.${name}); find() resolves components only`,
        listNames(scope),
        name,
      );
    }
    fail(
      `testUI: no component or element named "${name}"${
        key !== undefined ? ` [key=${key}]` : ""
      } under ${scope.path}`,
      listNames(scope),
      name,
    );
  }
  return hits[0]!;
}
