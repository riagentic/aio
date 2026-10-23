// `am peer <appId|url>` — what another running aio app lets a caller do, asked
// live over its own door (`peer().describe()`), and `--types[=<file>]` saves the
// types it publishes (`aio.run({ peerTypes })`) so a caller gets typed calls
// without that app's source. am connects as a plain caller (no peer identity):
// the list is what an anonymous local client may call.
import { peer, type PeerDescription } from "../server/peer.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, outData, sayDataStream } from "./am-output.ts";
import { dirname } from "@std/path";

/** First line of every file `--types=<file>` writes — what makes a file safe
 *  to overwrite on the next run, and nothing else. */
const HEADER = "// Types published by ";

const USAGE = "usage: am peer <appId|url> [--types[=<file>]]\n" +
  "  The cells and methods a caller may call on that running app, and the\n" +
  "  types it publishes (--types: print them; --types=<file>: save them).";

/** The pretty listing. Pure. */
export function peerListing(d: PeerDescription): string {
  const lines = [`${d.app} ${d.version} (aio ${d.aio})`];
  const cells = Object.entries(d.cells);
  if (cells.length === 0) lines.push("  nothing this caller may call");
  for (const [cell, { methods }] of cells) {
    for (const [m, x] of Object.entries(methods)) {
      const args = x.args === undefined ? "…" : String(x.args);
      lines.push(`  ${cell}.${m}(${args})${x.async ? "  async" : ""}`);
    }
  }
  lines.push(
    d.types === undefined
      ? "  types: none published (aio.run({ peerTypes }))"
      : `  types: ${d.types.length} chars — am peer ${d.app} --types=<file>`,
  );
  return lines.join("\n");
}

export async function cmdPeer(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const positional = args.filter((a) => !a.startsWith("--"));
  const target = positional[0];
  if (!target) fail(USAGE, mode);
  if (positional.length > 1) {
    fail(
      `unexpected argument "${positional[1]}" — the file goes after ` +
        `--types=, joined: --types=${positional[1]}`,
      mode,
    );
  }
  const typesArg = args.find((a) =>
    a === "--types" || a.startsWith("--types=")
  );
  if (typesArg === "--types=") fail("--types= needs a file name", mode);
  let p: Awaited<ReturnType<typeof peer>>;
  try {
    p = await peer(target, { offline: "fail" });
  } catch (e) {
    fail(String(e instanceof Error ? e.message : e), mode);
  }
  if (!p) fail(`"${target}" is not running (am instances lists what is)`, mode);
  let d: PeerDescription;
  try {
    d = await p.describe();
  } catch (e) {
    p.close();
    fail(String(e instanceof Error ? e.message : e), mode);
  }
  p.close();
  if (typesArg === undefined) {
    outData(d, mode, () => peerListing(d));
    return;
  }
  if (d.types === undefined) {
    fail(
      `${d.app} publishes no types`,
      mode,
      `in ${d.app}: aio.run({ peerTypes }) with ` +
        `import types from "./contract.ts" with { type: "text" }`,
    );
  }
  const file = typesArg.startsWith("--types=") ? typesArg.slice(8) : "";
  if (!file) {
    // Raw, for a redirect: `am peer aipro --types > src/peers/aipro.ts`.
    if (mode === "json") outData({ app: d.app, types: d.types }, mode);
    else await sayDataStream(d.types);
    return;
  }
  let existing: string | null = null;
  try {
    existing = await Deno.readTextFile(file);
  } catch { /* aio-ok: absent — written fresh below */ }
  if (existing && !existing.startsWith(HEADER)) {
    fail(
      `${file} exists and was not written by am peer — refusing to ` +
        `overwrite it`,
      mode,
      "pick another file, or delete this one first",
    );
  }
  const header = `${HEADER}${d.app} ${d.version} — saved by ` +
    `\`am peer ${d.app} --types=${file}\`. Re-run to refresh; do not edit.\n`;
  await Deno.mkdir(dirname(file) || ".", { recursive: true });
  await Deno.writeTextFile(file, header + d.types);
  outData(
    { app: d.app, version: d.version, file, chars: d.types.length },
    mode,
    `saved ${d.app}'s types → ${file}`,
  );
}
