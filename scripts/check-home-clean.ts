// check:home-clean — the test suite may not write into the developer's HOME.
//
// `_armTestStrict` has sandboxed app directories since alpha70, with the right
// reasoning written next to it ("a harness must not be able to write into the
// user's home — not by design, and not by accident"). It arms on the first
// HARNESS use, which is the hole: a test that scaffolds an app and SPAWNS it
// never touches the harness, and a spawned app resolves its home to
// `~/.<appId>` unless something pins `AIO_APPS_DIR`.
//
// The suite's own task pins it. Running one file — `deno test -A tests/x.test.ts`,
// which is how CLAUDE.md tells you to run one — does not. So every e2e app,
// every scaffolded fixture and every version probe left a directory behind,
// each with a fresh random id so nothing ever collided and nothing was ever
// noticed. 169 of them had accumulated: 107 `.e2e-*`, 51 `.app-*`, 15
// `.ver-probe-*`.
//
// This looks for the shapes those tests produce. It never deletes anything —
// it names what is there and the one command that removes it, because a gate
// that tidies the user's home is a worse idea than the mess.
//
// Usage: deno run --allow-read --allow-env scripts/check-home-clean.ts
import { join } from "@std/path";

/** The appId shapes this repo's tests generate. Anchored, so a real app called
 *  `apple` or a user's own `~/.appointments` is never matched. */
const TEST_SHAPES: RegExp[] = [
  /^\.app-[0-9a-f]{8}$/, // e2e-app-harness makeApp()
  /^\.e2e-[0-9a-f]{8}$/, // e2e-harness scaffoldApp()
  /^\.ver-probe-[0-9a-f]{8}$/, // app-version-identity
  /^\.aio-test-apps-/, // an older sandbox prefix
  /^\.[a-z0-9-]*-e2e$/, // cell-worker-e2e, worker-parity-e2e, dev-restart-e2e
  /^\.e2e-probe$/,
];

export function isTestStray(name: string): boolean {
  return TEST_SHAPES.some((re) => re.test(name));
}

export function straysIn(names: string[]): string[] {
  return names.filter(isTestStray).sort();
}

if (import.meta.main) {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    console.log("✓ home-clean: no HOME to check");
    Deno.exit(0);
  }
  const names: string[] = [];
  try {
    for (const e of Deno.readDirSync(home)) names.push(e.name);
  } catch (e) {
    console.error(
      `✗ home-clean: cannot read ${home} (${
        e instanceof Error ? e.message : e
      })`,
    );
    Deno.exit(1);
  }
  const strays = straysIn(names);
  if (strays.length > 0) {
    console.error(
      `✗ ${strays.length} test artefact(s) in ${home} — a test wrote an app ` +
        `home outside its sandbox:\n`,
    );
    for (const s of strays.slice(0, 12)) console.error(`  ${join(home, s)}`);
    if (strays.length > 12) {
      console.error(`  … and ${strays.length - 12} more`);
    }
    console.error(
      `\n  cause: a spawned app resolves its home as \`~/.<appId>\` unless\n` +
        `  AIO_APPS_DIR is set. Pin it in the child's env — \`childEnv()\` in\n` +
        `  tests/e2e-app-harness.ts is where every spawned test app gets it.\n` +
        `\n  These are yours to remove, not this gate's:\n` +
        `      ls -d ~/.app-* ~/.e2e-* ~/.ver-probe-* ~/.*-e2e 2>/dev/null\n` +
        `      # review the list, then delete it`,
    );
    Deno.exit(1);
  }
  console.log(`✓ home-clean: no test artefacts in ${home}`);
}
