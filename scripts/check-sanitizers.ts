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

if (import.meta.main) {
  const { unjustified, justified } = await scan();
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
