// Boot-integration proof of shape-drift detection (risoto #1): an app persists a
// cell state, then a LATER build boots with that field removed from the cell's
// declared shape. deepMerge silently keeps the stale field — so boot detects the
// drift and surfaces it on the `migrations` trojan route (what `am migrations`
// reads). This covers the seam the pure detectShapeDrift tests can't: real KV
// restore → deepMerge → detectShapeDrift → route.
import { assert } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";

const PORT = 9560 + (Deno.pid % 120);
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
      appVersion: "0.0.0",
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
      appVersion: "0.0.0",
      client: "server-only",
      libraryMode: true,
      port: PORT,
      dbPath,
      baseDir: dir,
      persistDebounceMs: 10,
    });
    try {
      const res = await fetch(
        `http://localhost:${PORT}/__aio/trojan/migrations`,
      );
      const m = await res.json() as {
        drift: { cell: string; path: string; issue: string }[];
      };
      assert(
        m.drift.some((d) =>
          d.cell === "wallet" && d.path === "seedPhrase" &&
          d.issue === "unknown-field"
        ),
        `expected wallet.seedPhrase drift, got ${JSON.stringify(m.drift)}`,
      );
    } finally {
      await app.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
