// A named signal set to its current value is a no-op. Only an OBJECT set to
// itself is worth a dev warning (the mutate-then-set bug: the change reaches
// no reader). A primitive reset — `matchCount.set(0)` when it is already 0 —
// is an ordinary idiom, and warning on it taught apps to guard every set with
// `if (s.peek() !== v)` for nothing (a field report).
import { assertEquals, assertStringIncludes } from "@std/assert";
import { signal } from "../src/state/signal.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { log } from "../src/diagnostics/logger-api.ts";

function captureWarnings(fn: () => void): string[] {
  const out: string[] = [];
  // deno-lint-ignore no-explicit-any
  const l = log as any;
  const orig = l.warn;
  l.warn = (...args: unknown[]) => out.push(args.map(String).join(" "));
  setDevModeOverride(true);
  try {
    fn();
  } finally {
    l.warn = orig;
    setDevModeOverride(null);
  }
  return out;
}

Deno.test("signal: a same-value PRIMITIVE set is silent, even in dev", () => {
  const warnings = captureWarnings(() => {
    const n = signal(0, "matchCount");
    const s = signal("", "query");
    const b = signal(false, "open");
    const u = signal<number | null>(null, "cursor");
    n.set(0);
    s.set("");
    b.set(false);
    u.set(null);
  });
  assertEquals(warnings, []);
});

Deno.test("signal: an OBJECT set to itself still warns — the mutate-then-set bug", () => {
  const warnings = captureWarnings(() => {
    const list = signal<number[]>([], "items");
    const arr = list.peek();
    arr.push(1); // mutated in place…
    list.set(arr); // …and set to the same reference: nobody is notified
  });
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assertStringIncludes(warnings[0]!, "items");
  assertStringIncludes(warnings[0]!, "set a copy");
});
