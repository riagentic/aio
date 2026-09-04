// check:sanitizers — a ratchet on tests that opt out of Deno's leak sanitizers.
//
// `sanitizeOps: false` / `sanitizeResources: false` / `sanitizeExit: false`
// turn off the one thing that tells a test it left a timer, a socket or a
// child process behind. Some tests need it — a real browser, a spawned app —
// and every one of those can say why. This gate freezes the count of opt-outs
// that say nothing: a new one must carry `// aio-ok: <reason>` on its line or
// the line above, or the count must come DOWN. Tests are the strictest
// environment; an opt-out with no reason is a leniency nobody agreed to.
//
// Usage: deno run --allow-read scripts/check-sanitizers.ts
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
/** Unjustified opt-outs at the time this gate was written. Ratchet DOWN. */
export const CEILING = 0;
const OPT_OUT = /sanitize(?:Ops|Resources|Exit)\s*:\s*false/;
const JUSTIFIED = /aio-ok:/;

export async function scan(
  dir = join(ROOT, "tests"),
): Promise<{ unjustified: string[]; justified: number }> {
  const unjustified: string[] = [];
  let justified = 0;
  const files: string[] = [];
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) await walk(p);
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  await walk(dir);
  for (const path of files.sort()) {
    const lines = (await Deno.readTextFile(path)).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!OPT_OUT.test(lines[i]!)) continue;
      if (JUSTIFIED.test(lines[i]!) || JUSTIFIED.test(lines[i - 1] ?? "")) {
        justified++;
      } else {
        unjustified.push(`${path.slice(ROOT.length)}:${i + 1}`);
      }
    }
  }
  return { unjustified, justified };
}

/** Do the test tasks actually RUN the sanitizers this gate ratchets?
 *
 *  Deno 2.9 made `--sanitize-ops` / `--sanitize-resources` OPT-IN (they were
 *  on by default before), and no aio task passes them — so the mechanism this
 *  gate freezes the opt-outs of does not run at all, and
 *  `docs/testing/README.md`'s "Sanitizers stay on" is false. A ratchet on
 *  nothing is the exact shape this repo calls a checker that cannot see what
 *  it claims to check, so the gate says so about ITSELF.
 *
 *  Returns the task names that run `deno test` without the flags. */
export async function tasksWithoutSanitizers(): Promise<string[]> {
  const cfg = JSON.parse(
    await Deno.readTextFile(join(ROOT, "deno.json")),
  ) as { tasks?: Record<string, string> };
  const out: string[] = [];
  for (const [name, cmd] of Object.entries(cfg.tasks ?? {})) {
    // Only the tasks that are the LEAK FLOOR — the ones a person runs to be
    // told the suite is clean. A targeted e2e task is not that.
    if (!["test", "test:core", "check:coverage"].includes(name)) continue;
    if (!/\bdeno test\b/.test(cmd)) continue;
    if (/--sanitize-ops/.test(cmd) && /--sanitize-resources/.test(cmd)) {
      continue;
    }
    out.push(name);
  }
  return out;
}

if (import.meta.main) {
  const { unjustified, justified } = await scan();
  const blind = await tasksWithoutSanitizers();
  if (blind.length > 0) {
    // WARNS, does not fail — and that is a decision, not an oversight. Turning
    // the flags on today reds 702 of 7009 tests at once (measured over the
    // whole suite on 2026-09-04): mostly booted test apps that leave their
    // file watcher and timers behind. A gate that goes red on a backlog
    // nobody has worked through is not a gate, it is a blocked repo. So this
    // says the truth every run, loudly, and `todo.md` carries the work.
    // Delete this branch the moment the tasks pass the flags.
    console.warn(
      `⚠ the sanitizers this gate ratchets are NOT RUN by: ${
        blind.join(", ")
      }.\n` +
        `  Deno 2.9 made --sanitize-ops / --sanitize-resources opt-IN, so a\n` +
        `  suite that does not pass them has no leak floor at all: a test can\n` +
        `  leave a timer, a socket, a file or a child process behind and stay\n` +
        `  green. docs/testing/README.md says "Sanitizers stay on" and\n` +
        `  freezing the opt-out count is meaningless while they are off.\n` +
        `  Fix: add \`--sanitize-ops --sanitize-resources\` to those tasks and\n` +
        `  fix what they surface (702 of 7009 as of 2026-09-04, mostly booted\n` +
        `  apps leaving a file watcher behind) — tracked in todo.md.`,
    );
  }
  const n = unjustified.length;
  if (n > CEILING) {
    console.error(
      `✗ sanitizer opt-outs: ${n} unjustified (ceiling ${CEILING}). A test ` +
        `that turns a sanitizer off says why: \`// aio-ok: <reason>\` on the ` +
        `line or the line above.`,
    );
    Deno.exit(1);
  }
  console.log(
    `✓ sanitizer opt-outs: ${n} unjustified (ceiling ${CEILING}), ${justified} justified with \`aio-ok:\`` +
      (n < CEILING
        ? ` — lower the CEILING in scripts/check-sanitizers.ts to ${n}`
        : ""),
  );
}
