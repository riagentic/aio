// A LEAF entry that is not a leaf is worse than no entry at all.
//
// A live trading desk measured `import { log } from "aio"` at 260 aio modules
// and 3.7 MB in a process that never draws a pixel: the vdom renderer (31), the
// build system (20), the Electron target (8) and the CRDT engine (5) all
// arrived because one file wanted a logger. That desk pins aio and treats a pin
// bump as a live-trading change *because* its import graph is mostly framework
// — so the cost of the barrel is not bytes, it is that upgrading aio became a
// risk event for a process that only ever asked for `log.info`.
//
// `aio/log` is the answer, and it is only an answer while it stays small. The
// failure this guards against is silent and one import away: someone adds
// `import { isDev } from "../server/..."` to a diagnostics module, the entry
// quietly grows the server tree, and nothing says so — the export still
// resolves, the types still check, and the next measurement is a field report.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** The aio modules `spec` pulls in, as repo-relative paths. */
async function graphOf(entry: string): Promise<string[]> {
  const out = await new Deno.Command("deno", {
    args: ["info", "--json", entry],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(
    out.code,
    0,
    `deno info failed for ${entry}: ${new TextDecoder().decode(out.stderr)}`,
  );
  const info = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    modules: { specifier: string }[];
  };
  return info.modules
    .map((m) => m.specifier)
    .filter((s) => s.startsWith("file://"))
    .map((s) => fromFileUrl(s))
    .filter((p) => p.startsWith(ROOT))
    .map((p) => p.slice(ROOT.length));
}

// The subtrees a non-UI, non-server process has no business loading. Each is a
// whole capability, not a file: reaching one means the leaf grew a trunk.
const FORBIDDEN = [
  "src/air/",
  "src/browser/",
  "src/ui/",
  "src/server/",
  "src/build/",
  "src/electron/",
  "src/sync/",
  "src/am/",
  "src/db/",
  "src/adapters/",
  "src/testing/",
];

Deno.test("aio/log is a leaf — no renderer, server, build, Electron or sync", async () => {
  const graph = await graphOf("src/diagnostics/logger.ts");
  const leaked = graph.filter((p) => FORBIDDEN.some((d) => p.startsWith(d)));
  assertEquals(
    leaked,
    [],
    `aio/log pulled in ${leaked.length} module(s) from a subtree a logger has ` +
      `no reason to load. That is the barrel problem this entry exists to ` +
      `solve, arriving one import at a time:\n  ${leaked.join("\n  ")}`,
  );
});

Deno.test("aio/log stays an order of magnitude smaller than the barrel", async () => {
  const [leaf, barrel] = await Promise.all([
    graphOf("src/diagnostics/logger.ts"),
    graphOf("mod.ts"),
  ]);
  // Not a byte budget — a SHAPE assertion. The measured numbers were 13 vs 260
  // aio modules; the ceiling is generous so ordinary growth in diagnostics is
  // not a red gate, and a structural regression (the leaf acquiring a subtree)
  // still is. The barrel comparison is what makes the number meaningful: this
  // fails if the leaf grows OR if the barrel shrinks to meet it.
  assert(
    leaf.length <= 40,
    `aio/log now costs ${leaf.length} aio modules (was 13). A logger that ` +
      `costs a framework is the finding this entry closed:\n  ${
        leaf.join("\n  ")
      }`,
  );
  assert(
    leaf.length * 3 < barrel.length,
    `aio/log (${leaf.length} modules) is no longer meaningfully cheaper than ` +
      `\`aio\` (${barrel.length}). Either the leaf grew or the barrel is not ` +
      `the barrel any more — either way the entry stopped paying for itself.`,
  );
});
