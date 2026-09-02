// check:lock — a dependency cannot drift without a source file changing.
//
// `deno.lock` maps a REQUEST to the version it resolved to. A request of `@*`
// asks for "whatever is newest", so the same commit resolves differently on
// different days — the one way this repo's exact-pin invariant can be broken
// without a single tracked file being edited.
//
// It had been. 17 test files imported `jsr:@std/assert` bare while 862 used the
// pinned `@std/assert` mapping from deno.json. Two spellings of one dependency,
// one bounded and one floating; today they happened to resolve to the same
// 1.0.19, which is exactly why nobody noticed. A stray `deno eval` in the repo
// root is enough to add another.
//
// A BOUNDED range is fine and is what the project uses (`@1`, `@^1.1.4`,
// `@1.0.19`): the lock still records one resolved version, and widening it is a
// visible edit. Only an unbounded request is refused.
//
// Usage: deno run --allow-read scripts/check-lock.ts
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Unbounded requests that are not this repo's to pin, with the reason. Kept
 *  as a map rather than a pattern so each one is a decision someone made. */
const NOT_OURS: Record<string, string> = {
  // Deno's own `deno install` machinery, pulled in by the onboarding tests
  // that run it. Deno requests it unversioned, so the entry reappears in the
  // lock after any suite run; nothing in this repo imports it, and pinning it
  // is not this repo's call. Removing it "as stale" is what the first version
  // of this gate did — and `tests/lock-is-pinned.test.ts` failed on the very
  // next full run, which is the only reason it is documented rather than
  // silently re-deleted every time.
  "jsr:@deno/installer-shell-setup@*":
    "Deno's own installer machinery — `deno install` requests it unversioned; nothing here imports it",
};

/** A request with no version, or one that asks for anything. */
export function isUnpinned(specifier: string): boolean {
  // `jsr:@scope/name@RANGE` / `npm:name@RANGE` — the LAST `@` starts the range,
  // except the one that opens a scope (`@std/...`), which never follows a `/`.
  const body = specifier.replace(/^(?:jsr|npm|https?):/, "");
  const at = body.lastIndexOf("@");
  if (at <= 0) return true; // no range at all: "npm:esbuild"
  const range = body.slice(at + 1).split("/")[0]!;
  return range === "" || range === "*" || range === "latest";
}

export function unpinnedSpecifiers(lock: {
  specifiers?: Record<string, string>;
}): string[] {
  return Object.keys(lock.specifiers ?? {})
    .filter(isUnpinned)
    .filter((s) => !(s in NOT_OURS))
    .sort();
}

/** An import specifier written in source with no version range. The lock is
 *  the symptom; this is the cause, and it can name the file.
 *
 *  Only real import POSITIONS — `from "…"`, `import("…")`, `export … from "…"`.
 *  A first attempt matched any string holding a `jsr:`/`npm:` prefix and
 *  reported 37 hits, every one of them a specifier the code talks ABOUT: a
 *  template the linter builds (`npm:${spec}`), a fixture an example app
 *  imports, the needle a check greps for. A gate that cries wolf gets an
 *  exemption list, and an exemption list is where a real hit goes to hide. */
export function unpinnedImports(src: string): string[] {
  const out: string[] = [];
  const positions = [
    /\bfrom\s*["'`]((?:jsr|npm):[^"'`]+)["'`]/g,
    /\bimport\s*\(\s*["'`]((?:jsr|npm):[^"'`]+)["'`]/g,
    /\bimport\s*["'`]((?:jsr|npm):[^"'`]+)["'`]/g,
  ];
  // …and a REGEX LITERAL matching import statements (`/from "npm:[^"]+"/`)
  // reads as one of those positions. A package specifier cannot contain regex
  // metacharacters, so requiring a legal specifier is both the narrower test
  // and the honest one — it excludes nothing that could be a real import.
  const LEGAL = /^(?:jsr|npm):[@\w][\w.@/-]*$/;
  // A commented import is not an import — including the one in the comment
  // above this gate's own test explaining what it looks for. Line-at-a-time,
  // because the only failure mode of over-stripping here is a MISSED hit on a
  // line where an import shares space with a comment, and an import statement
  // does not.
  const code = src.split("\n")
    .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  for (const re of positions) {
    for (const m of code.matchAll(re)) {
      const spec = m[1]!;
      if (LEGAL.test(spec) && isUnpinned(spec)) out.push(spec);
    }
  }
  return out;
}

async function sourceHits(dirs: string[]): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      if (["node_modules", ".git", "dist", ".aio"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory) await walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        const src = await Deno.readTextFile(p);
        for (const spec of new Set(unpinnedImports(src))) {
          hits.push(`  ${p.slice(ROOT.length)}  imports ${spec}`);
        }
      }
    }
  };
  for (const d of dirs) await walk(join(ROOT, d));
  return hits.sort();
}

if (import.meta.main) {
  const lock = JSON.parse(
    await Deno.readTextFile(join(ROOT, "deno.lock")),
  ) as { specifiers?: Record<string, string> };
  const loose = unpinnedSpecifiers(lock);
  if (loose.length > 0) {
    console.error(
      `✗ ${loose.length} unpinned dependenc(ies) in deno.lock — these resolve ` +
        `to whatever is newest, so the same commit builds differently on ` +
        `different days:\n`,
    );
    for (const s of loose) {
      console.error(`  ${s}  → currently ${lock.specifiers![s]}`);
    }
    console.error(
      `\n  fix: import through the mapping in deno.json's "imports" (which is\n` +
        `  pinned), or give the specifier a range — \`jsr:@std/assert@1\`. Then\n` +
        `  delete the stale \`@*\` line from deno.lock: Deno keeps resolved\n` +
        `  entries it no longer needs.\n` +
        `  If it is not this repo's to pin, add it to NOT_OURS in\n` +
        `  scripts/check-lock.ts with the reason.`,
    );
    Deno.exit(1);
  }
  const inSource = await sourceHits([
    "src",
    "tests",
    "scripts",
    "aiol",
    "amui/src",
  ]);
  if (inSource.length > 0) {
    console.error(
      `✗ ${inSource.length} import(s) name a dependency with no version — ` +
        `each one becomes an \`@*\` request in the lock:\n`,
    );
    console.error(inSource.join("\n"));
    console.error(
      `\n  fix: import through deno.json's "imports" (\`@std/assert\`), which ` +
        `is\n  pinned in one place, or give the specifier a range.`,
    );
    Deno.exit(1);
  }
  const n = Object.keys(lock.specifiers ?? {}).length;
  const exempt = Object.keys(NOT_OURS).length;
  console.log(
    `✓ lock: all ${n} dependency request(s) are bounded` +
      (exempt ? ` (${exempt} exempt)` : ""),
  );
}
