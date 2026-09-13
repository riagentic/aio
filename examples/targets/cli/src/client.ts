// Thin CLI client — bound remote cell: the same cell definition the server
// uses, bound to the connection. `await counter.increment(1)` dispatches over
// the socket (resolves on the server ack) and `counter.count` reads live
// server state — no raw { type, payload } wire actions, no state mirror.
import { connectCli } from "aio/server";
import { instances, resolveAppId } from "aio/extras";
import config from "../deno.json" with { type: "json" };
import { counter } from "./cell/counter.ts";

// WHERE the server is. `deno task dev` binds a FREE port, so the hard-coded
// ws://localhost:8000 this used to default to reached nothing (or another
// app), and retried it forever without a word. A URL argument wins — a server
// elsewhere; otherwise the lock file the running server wrote says where it
// is, the same lookup `am instances` does, keyed by THIS project's identity
// (its own deno.json, not the directory you run the client from).
const live = instances(resolveAppId(config.title))
  .find((i) => i.alive && i.port > 0);
const url = Deno.args[0] ??
  (live ? `ws://localhost:${live.port}/ws` : undefined);
if (!url) {
  console.error(
    `no ${config.title} server running — start one with \`deno task dev\`, ` +
      `or pass its URL: deno task client ws://host:port/ws`,
  );
  Deno.exit(1);
}
console.log("Connecting to", url, "...");

// Bounded: a server that is not there is an answer, not a hang.
const app = connectCli(url, { readyTimeoutMs: 10_000 });
app.bind(counter);
try {
  await app.ready;
} catch (e) {
  console.error(`no server at ${url} — ${e instanceof Error ? e.message : e}`);
  app.close();
  Deno.exit(1);
}

console.log("Counter:", counter.count);
app.subscribe(() => console.log("Counter:", counter.count));

const HELP = "Commands: inc [n], dec [n], reset";
console.log(HELP);

const decoder = new TextDecoder();
const buf = new Uint8Array(1024);
while (true) {
  const n = await Deno.stdin.read(buf);
  if (n === null) break;
  const [cmd, arg] = decoder.decode(buf.subarray(0, n)).trim().split(/\s+/);
  if (cmd === "inc") await counter.increment(Number(arg) || 1);
  else if (cmd === "dec") await counter.decrement(Number(arg) || 1);
  else if (cmd === "reset") await counter.reset();
  else if (cmd) console.log(HELP);
}

app.close();
