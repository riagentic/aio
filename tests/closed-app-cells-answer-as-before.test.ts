// A closed app's cells answer every call shape exactly as the closed app did.
//
// At close each cell is re-bound to a tombstone (aio-cells-bridge.ts
// `_tombstoneCells`) so the closed app — config, scope, logger — can be
// collected (tests/closed-app-scope-gc.test.ts). The first tombstone answered
// from the DECLARED initial state and refused every call with the main loop's
// DISPATCH_CLOSED — but a closed app answers with its FINAL state (a worker
// cell keeps what its worker wrote; main cells were reset by destroy), and a
// worker cell's call is refused BY ITS CLOSED WORKER, by name. Pinned against
// v1.0.11-beta's answers, shape by shape.
//
// Real process, real worker: libraryMode runs worker cells in-isolate, so no
// in-process harness reaches the worker pool's closed path.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { childEnv } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

function appSource(port: number): string {
  return `import { aio, cell } from "${REPO}/mod.ts";
const P = (k: string, v: unknown) => console.log("P " + k + "=" + JSON.stringify(v));
const settle = (p: any) => Promise.resolve(p).then(
  (v) => "ok:" + JSON.stringify(v),
  (e) => "err:" + (e?.code ?? "") + ":" + e?.message,
);
export const c = cell("c", {
  state: { n: 0 },
  // A plain selector gets the FULL state as arg 2 — here, the worker's slice.
  selectors: { double: (s: any) => s.n * 2, wk: (_s: any, all: any) => all.w.k },
  methods: { inc(s: any) { s.n++; }, async ainc(s: any) { s.n++; } },
});
export const w = cell("w", {
  worker: true,
  state: { k: 0, list: [] as number[] },
  methods: {
    wi(s: any) { s.k++; s.list = [...s.list, s.k]; },
    async wa(s: any) { s.k++; return s.k; },
  },
});
const app = await aio.run({
  cells: [c, w],
  appId: "closed-cells-" + crypto.randomUUID().slice(0, 8),
  client: "server-only",
  persist: false,
  port: ${port},
  appDir: Deno.env.get("PROBE_DIR"),
});
await c.inc(); await w.wi(); await w.wi(); await w.wa();
await app.close();
const W = w as any, C = c as any;
P("w.k", W.k);
P("w.list", W.list);
P("c.wk", C.wk());
P("frozen", Object.isFrozen(W.list));
P("c.n", C.n);
P("c.double", C.double());
P("c.inc", await settle(C.inc()));
P("c.ainc", await settle(C.ainc()));
P("w.wi", await settle(W.wi()));
P("w.wa", await settle(W.wa()));
P("w.k.after", W.k);
Deno.exit(0);
`;
}

async function runChild(): Promise<Record<string, unknown>> {
  const dir = await tempDir("aio-closed-cells-");
  try {
    const entry = join(dir, "app.ts");
    await Deno.writeTextFile(entry, appSource(freePort()));
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(REPO, "deno.json"), entry],
      env: childEnv({ PROBE_DIR: join(dir, "home") }),
      stdout: "piped",
      stderr: "piped",
    }).output();
    const all = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 0, all);
    const got: Record<string, unknown> = {};
    for (const m of all.matchAll(/^P ([\w.]+)=(.*)$/gm)) {
      got[m[1]!] = JSON.parse(m[2]!);
    }
    return got;
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "closed app: its cells' state reads answer the closed app's FINAL state, frozen — never the declared initial state",
  async fn() {
    const got = await runChild();
    // v1.0.11-beta: the worker cell keeps what its worker wrote…
    assertEquals(got["w.k"], 3);
    assertEquals(got["w.list"], [1, 2]);
    assertEquals(got["c.wk"], 3, "a selector reads the final state too");
    assertEquals(got["frozen"], true);
    // …and a main cell reads what destroy left: its declared state.
    assertEquals(got["c.n"], 0);
    assertEquals(got["c.double"], 0);
  },
});

Deno.test({
  name:
    "closed app: a late call is refused as the closed app refused it — a worker cell by its closed worker, a main cell with DISPATCH_CLOSED",
  async fn() {
    const got = await runChild();
    const sealed =
      "err:DISPATCH_CLOSED:dispatch after close() — action dropped, not applied";
    assertEquals(got["c.inc"], sealed);
    assertEquals(got["c.ainc"], sealed);
    // The worker's own refusal, by name, as on v1.0.11-beta — now carrying
    // the DISPATCH_CLOSED code a main cell's refusal has (additive: the
    // message is unchanged). Without it a closed worker's refusal of a
    // schedule tick read as a crash, and every clean stop logged an ERROR.
    assertEquals(
      got["w.wi"],
      `err:DISPATCH_CLOSED:[aio] cell worker "w" is closed — action "w:wi" was not applied`,
    );
    assertEquals(
      got["w.wa"],
      `err:DISPATCH_CLOSED:[aio] cell worker "w" is closed — action "w:wa" was not applied`,
    );
    assertEquals(got["w.k.after"], 3, "a refused call applied nothing");
  },
});
