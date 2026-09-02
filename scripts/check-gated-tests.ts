// check:gated-tests — a test nobody runs is a test that is not there.
//
// A test case can opt IN behind an env var: `ignore: Deno.env.get("X") !== "1"`,
// or an early `return "…set X=1 to run"`. That is the right shape for a case
// that needs a display, a device or four minutes of compiling — as long as
// SOMETHING turns it on. Nothing checked that.
//
// Two were found dark at once:
//   AIO_BUILD_SMOKE  set only by `check:matrix`, which is in neither
//                    release-check.ts nor ci.yml. The build smoke inside it
//                    had been red for FOUR releases with every release gate
//                    green — it still asserted `./app` in the project root,
//                    which nothing has written since "one path, one dist/".
//   ELECTRON_E2E     set by nothing at all. Three Electron E2E cases, on a
//                    machine with Electron and a display, had never run. They
//                    passed the moment they were switched on.
//
// So: every opt-in env gate must be SET by a deno.json task, and that task must
// be reachable from a gate chain (release-check.ts or ci.yml) — or be listed
// here as needing hardware this repo cannot have, with the row in the physical
// proof matrix that tracks it.
//
// Opt-OUTs (`=== "0"` disables) are not gates: those run by default.
//
// Usage: deno run --allow-read scripts/check-gated-tests.ts
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Opt-in gates that no task can turn on here, and why that is correct. Each
 *  must be a row in `scripts/proof.ts` so it is COUNTED as unproven rather than
 *  forgotten — an exemption that hides the gap is the bug this gate is about. */
const NEEDS_HARDWARE: Record<string, string> = {
  AIO_VM_LAB:
    "a real Windows or macOS host — tracked as `windows (real)` / `macos (real)` in the physical proof matrix",
  AIO_WINE_E2E:
    "builds a ~5 GB Wine image; run by hand as `deno task test:wine` — tracked as `windows (wine)` in the physical proof matrix, which records the run that proved it",
};

/** Env names a test opts IN on — names that SKIP a case when unset.
 *
 *  Two shapes, and only two, because everything else is a false positive: an
 *  env var the test SETS for a child it spawns (`AIO_PROBE_DEV`), or a speed
 *  switch inside a case that runs either way (`AIO_WINE_NO_BUILD`), reads
 *  identically to a gate if you only look for `Deno.env.get`.
 *
 *    ignore: Deno.env.get("X") !== "1"        — Deno's own skip
 *    if (!Deno.env.get("X")) return "…"       — a skip-reason helper
 *
 *  Restricted to names this project owns (`AIO_*`, or `*_E2E`): `DISPLAY` and
 *  `WAYLAND_DISPLAY` gate the same cases, but no task can or should set them —
 *  they describe the machine, and their absence is a real skip, not a dark
 *  test. */
export function optInGates(src: string): Set<string> {
  const names = new Set<string>();
  const own = (n: string) => n.startsWith("AIO_") || n.endsWith("_E2E");
  const add = (n: string | undefined) => {
    if (n && own(n)) names.add(n);
  };
  // `ignore:` — the expression up to the end of its line.
  for (const m of src.matchAll(/\bignore:\s*([^\n]*)/g)) {
    for (
      const e of m[1]!.matchAll(/Deno\.env\.get\("([A-Z][A-Z0-9_]*)"\)/g)
    ) add(e[1]);
  }
  // `const GATED = Deno.env.get("X") === "1"` … `ignore: !GATED`. The read and
  // the skip are in different statements, so neither shape above sees it — and
  // a gate that cannot see the gate is worse than no gate. Found by checking
  // that this detector still reported a case it had reported before.
  const ignores = [...src.matchAll(/\bignore:\s*([^\n]*)/g)].map((m) => m[1]!)
    .join("\n");
  for (
    const m of src.matchAll(
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*Deno\.env\.get\("([A-Z][A-Z0-9_]*)"\)[^\n;]*;/g,
    )
  ) {
    if (new RegExp(`\\b${m[1]!}\\b`).test(ignores)) add(m[2]);
  }
  // A skip-reason helper: the condition guards a `return "<reason>"`.
  for (
    const m of src.matchAll(
      /if\s*\([^)]*Deno\.env\.get\("([A-Z][A-Z0-9_]*)"\)[^)]*\)\s*\{?\s*(?:\n\s*)?return\s+["'`]/g,
    )
  ) add(m[1]);
  return names;
}

async function testSources(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) await walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        out.set(p.slice(ROOT.length), await Deno.readTextFile(p));
      }
    }
  };
  await walk(join(ROOT, "tests"));
  return out;
}

if (import.meta.main) {
  const tasks = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")))
    .tasks as Record<string, string>;
  const releaseCheck = await Deno.readTextFile(
    join(ROOT, "scripts/release-check.ts"),
  );
  const ci = await Deno.readTextFile(
    join(ROOT, ".github/workflows/ci.yml"),
  );

  // Which env vars each task sets, and whether a gate chain runs that task.
  const setBy = new Map<string, string[]>();
  for (const [name, cmd] of Object.entries(tasks)) {
    for (const m of String(cmd).matchAll(/\b([A-Z][A-Z0-9_]*)=1\b/g)) {
      setBy.set(m[1]!, [...(setBy.get(m[1]!) ?? []), name]);
    }
  }
  const inAGate = (task: string) =>
    releaseCheck.includes(`"${task}"`) || ci.includes(`deno task ${task}`);

  const dark: string[] = [];
  const ungated: string[] = [];
  for (const [file, src] of await testSources()) {
    for (const name of optInGates(src)) {
      if (name in NEEDS_HARDWARE) continue;
      const setters = setBy.get(name) ?? [];
      if (setters.length === 0) {
        dark.push(`  ${name}  (${file}) — no deno.json task sets ${name}=1`);
        continue;
      }
      if (!setters.some(inAGate)) {
        ungated.push(
          `  ${name}  (${file}) — set only by ${
            setters.join(", ")
          }, which no gate chain runs`,
        );
      }
    }
  }
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const d = uniq(dark), u = uniq(ungated);
  if (d.length || u.length) {
    console.error(
      `✗ ${d.length + u.length} opt-in test gate(s) nothing turns on:\n`,
    );
    if (d.length) console.error(`dark — nothing sets them:\n${d.join("\n")}\n`);
    if (u.length) {
      console.error(
        `set, but by a task no gate runs:\n${u.join("\n")}\n`,
      );
    }
    console.error(
      `  fix: set the variable in a deno.json task that release-check.ts or\n` +
        `  ci.yml runs, or — if it needs hardware this repo cannot have — add\n` +
        `  it to NEEDS_HARDWARE here AND give it a row in scripts/proof.ts.`,
    );
    Deno.exit(1);
  }
  const exempt = Object.keys(NEEDS_HARDWARE).length;
  console.log(
    `✓ gated tests: every opt-in gate is turned on by a task a gate runs` +
      (exempt ? ` (${exempt} need hardware, tracked in the proof matrix)` : ""),
  );
}
