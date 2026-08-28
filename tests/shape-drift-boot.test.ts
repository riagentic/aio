// Boot-integration proof of shape-drift detection: an app persists a
// cell state, then a LATER build boots with that field removed from the cell's
// declared shape. deepMerge silently keeps the stale field — so boot detects the
// drift and surfaces it on the `migrations` trojan route (what `am migrations`
// reads). This covers the seam the pure detectShapeDrift tests can't: real KV
// restore → deepMerge → detectShapeDrift → route.
import { assert } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetParsedCli } from "../src/server/aio-cli.ts";

// Boot B runs as PROD: since alpha70 a DEV boot REFUSES unmigrated structural
// drift (tests/shape-drift-strict.test.ts); prod warns and surfaces it here.
const _argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;
function setProd(): void {
  Object.defineProperty(Deno, "args", {
    value: ["--prod"],
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
}
function restoreArgs(): void {
  Object.defineProperty(Deno, "args", _argsDesc);
  _resetParsedCli();
}

const PORT = freePort();
const APP_ID = "shape-drift-boot";

Deno.test("boot shape-drift: a stored field dropped from initialState surfaces on `migrations`", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shape-drift-" });
  const dbPath = join(dir, "data.db");

  // ── Boot A: an older build whose wallet cell HAS `seedPhrase`. Persist it. ──
  {
    const wallet = cell("wallet", {
      state: { balance: 0, seedPhrase: "" },
      methods: {
        setSeed(s: { seedPhrase: string }, v: string) {
          s.seedPhrase = v;
        },
      },
    });
    const app = await aio.run({
      cells: [wallet],
      appId: APP_ID,
      client: "server-only",
      libraryMode: true,
      port: PORT,
      dbPath,
      baseDir: dir,
      persistDebounceMs: 10,
    });
    await (wallet as unknown as { setSeed: (v: string) => Promise<void> })
      .setSeed("hunter2");
    await new Promise((r) => setTimeout(r, 300)); // let the debounced flush land
    await app.close();
  }

  // ── Boot B: a newer build that DROPPED `seedPhrase` from the declared shape. ─
  setProd();
  const warned: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
  try {
    const wallet = cell("wallet", {
      state: { balance: 0 }, // seedPhrase removed — no version bump
      methods: {
        deposit(s: { balance: number }, n: number) {
          s.balance += n;
        },
      },
    });
    const app = await aio.run({
      cells: [wallet],
      appId: APP_ID,
      client: "server-only",
      libraryMode: true,
      port: PORT,
      dbPath,
      baseDir: dir,
      persistDebounceMs: 10,
    });
    try {
      // The trojan does not exist in prod; the boot WARNING is the surface
      // (`am migrations` reads the same picture in dev, where structural
      // drift is now a refusal — tests/shape-drift-strict.test.ts).
      const w = warned.join("\n");
      assert(
        w.includes("shape drift") && w.includes("wallet.seedPhrase"),
        `expected wallet.seedPhrase drift in the boot warning, got:\n${w}`,
      );
    } finally {
      await app.close();
    }
  } finally {
    console.warn = origWarn;
    restoreArgs();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
