// A cell rename must never destroy data (a field report: a
// leaderboard was silently dropped by the first persist of a build that no
// longer declared its cell, and had to be carved out of SQLite free pages).
//
// Contract now: a stored-but-undeclared cell slice is PRESERVED in every
// future persisted document, stripped from runtime state (no cell owns it),
// warned about at every boot — and a rename migration is one onRestore hook:
// read the old slice, move what you need, delete the key to consume it.
import { assert, assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function boot(
  dir: string,
  cells: unknown[],
  onRestore?: (s: Record<string, unknown>) => Record<string, unknown>,
) {
  const { aio } = await import("../mod.ts");
  // deno-lint-ignore no-explicit-any
  return await aio.run({
    cells,
    appId: "orphan-app",
    client: "server-only",
    persist: true,
    libraryMode: true,
    port: freePort(),
    appDir: dir,
    ...(onRestore ? { onRestore } : {}),
  } as any);
}

Deno.test({
  name: "cell rename: undeclared stored cell survives, warns, and round-trips",
  async fn() {
    const { cell } = await import("../mod.ts");
    const dir = await Deno.makeTempDir();
    const mkGame = () =>
      cell("game", {
        state: { leaderboard: [] as string[] },
        methods: {
          add(s: { leaderboard: string[] }, n: string) {
            s.leaderboard.push(n);
          },
        },
      });
    const mkScores = () =>
      cell("scores", {
        state: { entries: [] as string[] },
        methods: {
          add(s: { entries: string[] }, n: string) {
            s.entries.push(n);
          },
        },
      });

    // Boot 1 — old build: `game` holds the data.
    {
      const game = mkGame();
      const app = await boot(dir, [game]);
      try {
        (game as Any).add("ada-9000");
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        await app.close();
      }
    }

    // Boot 2 — the rename shipped: `game` is gone, `scores` exists. The old
    // slice must NOT be in runtime state, and must survive this build's
    // persists untouched.
    {
      const scores = mkScores();
      const app = await boot(dir, [scores]);
      try {
        const s = app.getState() as Record<string, unknown>;
        assertEquals(
          s.game,
          undefined,
          "no cell owns it — not in runtime state",
        );
        (scores as Any).add("new-entry");
        await new Promise((r) => setTimeout(r, 200)); // let a persist flush run
      } finally {
        await app.close();
      }
    }

    // Boot 3 — `game` is declared again: the data is right back, as-is.
    {
      const game = mkGame();
      const app = await boot(dir, [game]);
      try {
        const s = app.getState() as { game: { leaderboard: string[] } };
        assertEquals(
          s.game.leaderboard,
          ["ada-9000"],
          "the undeclared interlude did not touch the data",
        );
      } finally {
        await app.close();
      }
    }
  },
});

Deno.test({
  name: "cell rename: onRestore migrates the old slice and consumes it",
  async fn() {
    const { cell } = await import("../mod.ts");
    const dir = await Deno.makeTempDir();

    // Boot 1 — old build writes into `game`.
    {
      const game = cell("game", {
        state: { leaderboard: [] as string[] },
        methods: {
          add(s: { leaderboard: string[] }, n: string) {
            s.leaderboard.push(n);
          },
        },
      });
      const app = await boot(dir, [game]);
      try {
        // deno-lint-ignore no-explicit-any
        (game as any).add("carried-over");
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        await app.close();
      }
    }

    // Boot 2 — the documented rename migration: one onRestore hook.
    {
      const scores = cell("scores", {
        state: { entries: [] as string[] },
        methods: {},
      });
      const app = await boot(dir, [scores], (s) => {
        const old = s.game as { leaderboard?: string[] } | undefined;
        if (old?.leaderboard) {
          (s.scores as { entries: string[] }).entries = old.leaderboard;
          delete s.game; // consume — the stored row goes away
        }
        return s;
      });
      try {
        const s = app.getState() as { scores: { entries: string[] } };
        assertEquals(s.scores.entries, ["carried-over"], "migrated");
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        await app.close();
      }
    }

    // Boot 3 — consumed: no orphan resurfaces, the migrated data persists.
    {
      const scores = cell("scores", {
        state: { entries: [] as string[] },
        methods: {},
      });
      const app = await boot(dir, [scores]);
      try {
        const s = app.getState() as Record<string, unknown>;
        assertEquals(
          (s.scores as { entries: string[] }).entries,
          ["carried-over"],
        );
        assertEquals(s.game, undefined, "consumed slice stays consumed");
      } finally {
        await app.close();
      }
    }
  },
});
