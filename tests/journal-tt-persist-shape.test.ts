// A time-travel line must not write to disk what `onPersist` shapes OFF it.
//
// `persist` is TWO screens, exactly as `visible` is: the include/exclude
// filter, and then `onPersist` — the callback the store runs on its way to
// disk (`buildDBStateGetter`, aio-composition.ts), which an app uses to drop
// a session token or a decrypted field from what it stores. A jump is
// journalled as the state it puts in place, and it screened that state
// through the FILTER alone: the field the store has never once written was
// written into the durable journal by pressing undo.
//
// The same class the nested-exclude fix closed one screen earlier — see
// journal-tt-persist-exclude.test.ts.
import { assert } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const SECRET = "TOPSECRET-shaped-off-disk";

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const w = cell("w", {
  state: { keep: 0, token: "" },
  // What the store writes: everything but the live session token.
  onPersist: (s) => ({ ...s, token: "" }),
  methods: {
    seal(s, v) { s.keep = v; s.token = "${SECRET}"; },
    bump(s) { s.keep += 1; },
  },
});
const app = await aio.run({
  cells: [w],
  appId: "journal-tt-shape-probe",
  client: "server-only",
  journal: true,
  persistDebounceMs: 999999,
  port: PORT,
  appDir: DIR,
});
await w.seal(1);
await w.bump();
// Undo lands on the state seal() produced — the one holding the token.
const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/tt", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-AIO": "1" },
  body: JSON.stringify({ cmd: "undo" }),
});
Deno.writeTextFileSync(DIR + "/tt.json", await res.text());
// SIGKILL, not close(): a clean stop snapshots and compacts the journal away.
Deno.kill(Deno.pid, "SIGKILL");
`;

Deno.test("journal: a time-travel line honours onPersist shaping", async () => {
  const dir = await tempDir("aio-journal-tt-shape-");
  await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: { DIR: dir, PORT: String(freePort()), AIO_APPS_DIR: dir },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(!out.success, "the child ends on the SIGKILL it sends itself");
  const ack = await Deno.readTextFile(`${dir}/tt.json`);
  assert(JSON.parse(ack).ok === true, `the jump must have happened: ${ack}`);

  const journals: string[] = [];
  const walk = (at: string) => {
    for (const e of Deno.readDirSync(at)) {
      const p = `${at}/${e.name}`;
      if (e.isDirectory) walk(p);
      else if (e.name === "journal" || e.name.endsWith(".journal")) {
        journals.push(p);
      }
    }
  };
  walk(dir);
  assert(journals.length > 0, "the run journalled");
  const text = journals.map((p) => Deno.readTextFileSync(p)).join("\n");
  assert(
    text.includes("aio:__timeTravel"),
    `the jump is in the journal: ${text.slice(0, 400)}`,
  );
  assert(
    !text.includes(SECRET),
    `a field onPersist strips must not be written by a time-travel line: ${
      text.slice(0, 900)
    }`,
  );
  // …and what the store DOES hold still rides, or replay would lose the jump.
  assert(text.includes('"keep":1'), text.slice(0, 900));
});
