// A SQL-only `db:` table written directly (app.db.execute) beside a journalled
// store cell — the regression probe for tests/journal-toggle-stale.test.ts.
const { aio, cell, table, pk, text } = await import(Deno.env.get("MOD"));
const DIR = Deno.env.get("DIR"),
  PORT = Number(Deno.env.get("PORT")),
  PHASE = Deno.env.get("PHASE");
const E = (k, d) => Deno.env.get(k) ?? d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
const c = cell("c", {
  state: { n: 0 },
  methods: {
    bump(s) {
      s.n++;
    },
    async logMsg(s, t) {
      await app.db.execute("INSERT INTO messages (id, body) VALUES (?, ?)", [
        t,
        t,
      ]);
      s.n++;
    },
  },
});
app = await aio.run({
  cells: [c],
  appId: "p1",
  client: "server-only",
  port: PORT,
  appDir: DIR,
  journal: E("J", "1") === "1",
  persistDebounceMs: Number(E("PDM", "1500")),
  ...(E("MULTI", "") ? { persistMode: "multi" } : {}),
  db: { messages: table({ id: pk(), body: text() }) },
});
const snap = async () => ({
  n: app.getState().c.n,
  rows: (await app.db.query("SELECT COUNT(*) AS k FROM messages")).rows[0].k,
});
if (PHASE === "read") {
  console.log("SNAP", JSON.stringify(await snap()));
  await app.close();
  Deno.exit(0);
}
await app.dispatch({ type: "c:bump", payload: { args: [] } }).catch((e) =>
  console.log("dispatch err", e)
);
await sleep(Number(E("PDM", "1500")) + 1500); // first save lands
if (E("MODE", "sql") === "sql") {
  await app.db.execute("INSERT INTO messages (id, body) VALUES (1,'hi')");
}
if (E("MODE", "sql") === "method") {
  await app.dispatch({ type: "c:logMsg", payload: { args: [1] } });
}
await app.dispatch({ type: "c:bump", payload: { args: [] } });
await app.dispatch({ type: "c:bump", payload: { args: [] } });
console.log("LIVE", JSON.stringify(await snap()));
await sleep(100);
if (E("CLOSE", "")) {
  await app.close();
  Deno.exit(0);
}
Deno.kill(Deno.pid, "SIGKILL");
