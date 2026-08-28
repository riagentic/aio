// Every key the server hands the BROWSER reaches a reader in the browser.
//
// `renderBudget` was accepted by `aio.run`, validated by config.ts, bridged
// into the `cfg` frame and the page shell — and from alpha48 to alpha69 read
// by nothing on the client: the meter that consumed it went with the old
// transport, and every gate stayed green because every gate stopped at the
// bridge. "Config accepted, silently dropped" is the class CLAUDE.md forbids;
// this test extends the reach check across the LAST hop. For each key of the
// client config (`AioWindow.__aioConfig`, the wire type — the one place the
// keys are declared), some module under src/browser must read it, and the
// reader is named so a stale claim fails loudly.
import { assertEquals } from "@std/assert";

/** key → the file that reads `__aioConfig.<key>` (a claim checked below). */
const READERS: Record<string, string> = {
  renderBudget: "src/browser/browser-vitals.ts",
  syncCells: "src/browser/sync-cells.ts",
  callTimeouts: "src/browser/browser-ack.ts",
};

async function clientConfigKeys(): Promise<string[]> {
  const src = await Deno.readTextFile("src/protocol/protocol-types.ts");
  const block = src.slice(src.indexOf("__aioConfig?: {"));
  const body = block.slice(0, block.indexOf("\n  };"));
  return [...body.matchAll(/^\s{4}(\w+)\?:/gm)].map((m) => m[1]!);
}

Deno.test("client config: every __aioConfig key has a named reader under src/browser", async () => {
  const keys = await clientConfigKeys();
  assertEquals(
    keys.length > 0,
    true,
    "the AioWindow.__aioConfig type must still be where the keys are declared",
  );
  const missing: string[] = [];
  for (const key of keys) {
    const file = READERS[key];
    if (!file) {
      missing.push(`${key}: no reader claimed — add it to READERS`);
      continue;
    }
    // Code only — a comment that names the key is not a reader.
    const code = (await Deno.readTextFile(file)).split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const reads = /__aioConfig/.test(code) &&
      new RegExp(`\\.${key}\\b`).test(code);
    if (!reads) {
      missing.push(`${key}: ${file} does not read __aioConfig.${key}`);
    }
  }
  assertEquals(
    missing,
    [],
    "a client config key with no reader is accepted and dropped:\n  " +
      missing.join("\n  "),
  );
  // The ledger cannot rot: a claimed key must still be a key.
  assertEquals(
    Object.keys(READERS).filter((k) => !keys.includes(k)),
    [],
    "READERS names keys that are no longer client config",
  );
});
