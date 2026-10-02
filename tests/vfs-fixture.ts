// A stand-in for a `deno compile` binary, for the tests of what one embeds.

/** A binary's file tree and file data the way deno writes them: the tree's
 *  JSON behind its 8-byte length, then the files' bytes behind theirs. */
export function artifact(packages: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const data: number[] = [];
  const dir = (n: string, e: string) => `{"Dir":{"n":"${n}","e":[${e}]}}`;
  const entries = Object.entries(packages).map(([entry, json]) => {
    const bytes = enc.encode(json);
    const at = data.length;
    data.push(...bytes);
    const name = entry.slice(0, entry.lastIndexOf("@")).replace("+", "/");
    const file = `{"File":{"n":"package.json","o":[${at},${bytes.length}]}},` +
      // A package.json deeper in the package describes something else.
      dir("fixtures", `{"File":{"n":"package.json","o":[0,1]}}`);
    const inner = name.split("/").reduceRight((e, seg) => dir(seg, e), file);
    return dir(entry, dir("node_modules", inner));
  });
  const tree = enc.encode(
    `[${dir("node_modules", dir(".deno", entries.join(",")))}]`,
  );
  const out = new Uint8Array(4 + 8 + tree.length + 8 + data.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(4, BigInt(tree.length), true);
  out.set(tree, 12);
  view.setBigUint64(12 + tree.length, BigInt(data.length), true);
  out.set(data, 20 + tree.length);
  return out;
}
