// Pausing time travel must not rewind state.
//
// `pause` is documented as "freeze state, drop incoming actions"
// (diagnostics/time-travel.ts), and `skipActions` as "Skipped actions still
// dispatch, broadcast and persist normally — they are only absent from the
// time-travel ring" (docs/debugging/time-travel.md). But `handleTTCommand`
// (server/aio.ts) treats EVERY command that returns a new TTState object as a
// jump: `pause()` returns `{ ...tt, paused: true }`, so the live state is
// replaced by `stateAt(tt)` — the state of the last RECORDED entry. Every
// skipped action since that entry (the 60 fps `game:tick` the option exists
// for) is silently undone — and, with `journal: true`, the rewind is journalled
// as a time-travel line, so it survives a restart too.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";

Deno.test("time travel: pause keeps the live state, including skipped actions", async () => {
  const c = cell("ttpause", {
    state: { n: 0, hits: 0 },
    methods: {
      tick(s: { n: number }) {
        s.n++;
      },
      score(s: { hits: number }) {
        s.hits++;
      },
    },
  });
  await using srv = await testServer({
    cells: [c],
    diagnostics: { dev: { skipActions: ["ttpause:tick"] } },
    // deno-lint-ignore no-explicit-any
  } as any);
  // deno-lint-ignore no-explicit-any
  const cc = c as any;
  await cc.score(); // recorded: history's newest entry has n = 0
  await cc.tick(); // skipped from history, but a real write
  await cc.tick();
  await cc.tick();
  assertEquals({ n: cc.n, hits: cc.hits }, { n: 3, hits: 1 }, "premise");

  const res = await fetch(`${srv.url}/__aio/trojan/tt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify({ cmd: "pause" }),
  });
  const body = await res.text();
  assertEquals(res.status, 200, body);

  assertEquals(
    { n: cc.n, hits: cc.hits },
    { n: 3, hits: 1 },
    "pause froze the app at a state it was not in — the three skipped " +
      "ticks were rewound",
  );
});
