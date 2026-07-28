// Every option in `aio.run({ … })` must actually reach the runtime.
//
// This bug class has landed twice, both times silently, both times in a
// security-relevant option:
//
//   • `strictOrigin` was typed, documented and validated — and dropped at the
//     CellsConfig → AioConfig bridge, so the WS origin check never saw it.
//   • `redactActions` shipped with its own tests and its own docs, and the
//     bridge never copied it either: `journal: true, redactActions: […]` wrote
//     the passphrase to disk anyway. The unit tests passed, because they tested
//     `createJournal` directly rather than a booted app.
//
// The shape is always the same — a key is valid, typed and read by SOME
// consumer, but nothing carries it from the config the developer wrote to the
// object that consumer reads. It fails open and it fails quietly, which is the
// worst pair. So: a key is either assigned in the bridge, or it is listed below
// with the reason it doesn't need to be. A new key gets neither for free.
import { assert, assertEquals } from "@std/assert";
import { VALID_FEATURES_CONFIG_KEYS } from "../src/server/config.ts";

const BRIDGE = "src/server/aio-cells-bridge.ts";

/** Keys the bridge deliberately does not copy, and who consumes them instead.
 *  Each entry is checked: an exemption that names nothing real is a key that
 *  has quietly died, which is the same failure wearing a different hat. */
const CONSUMED_ELSEWHERE: Record<string, string> = {
  cells: "composeCellsWiring — the cells themselves, not a passthrough option",
  cellDefaults: "aio-composition.ts, applied per cell at composition time",
  appDir: "aio-cells-bridge.ts + aio-boot.ts — resolved into the app directory",
  renderBudget: "aio-server.ts — a client-side budget, sent to the browser",
  memory: "aio-cells-bridge.ts — wired into the memory guard directly",
  circuitBreaker: "aio-composition.ts — per-cell breaker config",
  strictCells: "aio.ts — read from the cells config at boot",
  fatalOnStart: "aio.ts — decides whether an onStart failure is fatal",
  dispatchStorm: "aio-cells-bridge.ts — builds the storm tracker in-place",
  logging: "aio-cells-bridge.ts — builds the action logger in-place",
  diagnostics: "mapped as `_diagnostics` (renamed, not dropped)",
  onCheckpointRestore: "mapped as `_onCheckpointRestore` (renamed)",
};

const src = await Deno.readTextFile(new URL(`../${BRIDGE}`, import.meta.url));
const allSrc = await (async () => {
  const parts: string[] = [];
  for await (
    const e of Deno.readDir(new URL("../src/server", import.meta.url))
  ) {
    if (e.isFile && e.name.endsWith(".ts") && e.name !== "config.ts") {
      parts.push(
        await Deno.readTextFile(
          new URL(`../src/server/${e.name}`, import.meta.url),
        ),
      );
    }
  }
  return parts.join("\n");
})();

const assignedInBridge = (key: string) =>
  new RegExp(`^\\s*${key}:`, "m").test(src);

Deno.test("config bridge: every CellsConfig key reaches the runtime", () => {
  const orphans: string[] = [];
  for (const key of VALID_FEATURES_CONFIG_KEYS) {
    if (key.startsWith("_")) continue; // internal, set by the framework itself
    if (assignedInBridge(key)) continue;
    if (key in CONSUMED_ELSEWHERE) continue;
    orphans.push(key);
  }
  assertEquals(
    orphans,
    [],
    `these options are accepted from the developer and then go nowhere — add ` +
      `\`${orphans[0] ?? "key"}: fc.${
        orphans[0] ?? "key"
      },\` to ${BRIDGE}, or ` +
      `record in CONSUMED_ELSEWHERE which consumer reads it directly`,
  );
});

Deno.test("config bridge: no exemption outlives the key it excuses", () => {
  for (const key of Object.keys(CONSUMED_ELSEWHERE)) {
    assert(
      VALID_FEATURES_CONFIG_KEYS.has(key),
      `"${key}" is exempted but is no longer a config key — drop the exemption`,
    );
    // …and the consumer it names must still read it. An exemption whose reader
    // has been refactored away leaves a documented, believed, dead option.
    assert(
      new RegExp(`\\.${key}\\b`).test(allSrc),
      `"${key}" is exempted as "${CONSUMED_ELSEWHERE[key]}" but nothing in ` +
        `src/server reads it any more — the option is dead`,
    );
  }
});
