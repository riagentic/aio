const { aio, cell } = await import(Deno.env.get("MOD"));
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
// persist: "none": its arguments are its state.
const vault = cell("vault", {
  persist: "none",
  state: { tok: "", other: "" },
  methods: {
    setTok(s, t) {
      s.tok = t;
    },
    setOther(s, t) {
      s.other = t;
    },
  },
});
// A persisted cell that REACTS to a persist:"none" call — the reaction reads
// the argument, so it cannot be re-derived without it.
const audit = cell("audit", {
  state: { seen: 0, lens: [], own: 0 },
  methods: {
    onTok(s, t) {
      s.seen++;
      s.lens.push(String(t).length);
    },
    bump(s) {
      s.own++;
    },
  },
  listensTo: { onTok: vault.setTok },
});
const app = await aio.run({
  cells: [vault, audit],
  appId: "none-listener-fixture",
  client: "server-only",
  journal: true,
  persistDebounceMs: 1000,
  port: PORT,
  appDir: DIR,
});
const call = async (type, args) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/__aio/trojan/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify({ type, payload: { args } }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${type} ${res.status} ${text}`);
};
const snap = () =>
  JSON.stringify({
    audit: { seen: audit.seen, lens: audit.lens, own: audit.own },
  });
if (PHASE === "crash") {
  await call("vault:setTok", ["SECRET-A"]);
  await new Promise((r) => setTimeout(r, 2500)); // saved: the journal compacts
  await call("vault:setTok", ["SECRET-BB"]);
  await call("audit:bump", []);
  await call("vault:setOther", ["SECRET-OTHER"]);
  await call("vault:setTok", ["SECRET-CCC"]);
  Deno.writeTextFileSync(`${DIR}/expected.json`, snap() + "\n");
  Deno.kill(Deno.pid, "SIGKILL"); // inside the 1 s debounce
} else {
  Deno.writeTextFileSync(`${DIR}/recovered.json`, snap() + "\n");
  await app.close();
  Deno.exit(0);
}
